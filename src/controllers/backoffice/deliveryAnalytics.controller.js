// src/controllers/backoffice/deliveryAnalytics.controller.js

const { Op, fn, col, literal } = require('sequelize');
const { Delivery, Account, Driver, sequelize } = require('../../models');

// ═══════════════════════════════════════════════════════════════════════════════
// GET DELIVERY ANALYTICS
// GET /api/backoffice/delivery/analytics
// Query params: period = '7d' | '30d' | '90d' | 'custom'
//               start_date, end_date (for custom)
// ═══════════════════════════════════════════════════════════════════════════════
exports.getAnalytics = async (req, res) => {
    try {
        const { period = '30d', start_date, end_date } = req.query;

        // ── Resolve date range ──────────────────────────────────────────────
        const now   = new Date();
        let dateFrom, dateTo;

        if (period === 'custom' && start_date && end_date) {
            dateFrom = new Date(start_date);
            dateTo   = new Date(new Date(end_date).setHours(23, 59, 59));
        } else {
            dateTo   = new Date(now);
            const days = period === '7d' ? 7 : period === '90d' ? 90 : 30;
            dateFrom = new Date(now);
            dateFrom.setDate(dateFrom.getDate() - days);
        }

        const dateWhere = {
            created_at: { [Op.between]: [dateFrom, dateTo] },
        };

        // ── 1. OVERVIEW TOTALS ─────────────────────────────────────────────
        const [
            totalDeliveries,
            completedDeliveries,
            cancelledDeliveries,
            totalRevenue,
            totalCommission,
            totalDriverPayout,
        ] = await Promise.all([
            Delivery.count({ where: dateWhere }),
            Delivery.count({ where: { ...dateWhere, status: 'delivered' } }),
            Delivery.count({ where: { ...dateWhere, status: 'cancelled' } }),
            Delivery.sum('total_price',      { where: { ...dateWhere, status: 'delivered' } }),
            Delivery.sum('commission_amount',{ where: { ...dateWhere, status: 'delivered' } }),
            Delivery.sum('driver_payout',    { where: { ...dateWhere, status: 'delivered' } }),
        ]);

        const completionRate = totalDeliveries > 0
            ? Math.round((completedDeliveries / totalDeliveries) * 100)
            : 0;

        const avgOrderValue = completedDeliveries > 0
            ? Math.round((totalRevenue || 0) / completedDeliveries)
            : 0;

        // ── 2. DAILY TREND (last N days) ────────────────────────────────────
        const dailyTrend = await Delivery.findAll({
            where: dateWhere,
            attributes: [
                [fn('DATE', col('created_at')), 'date'],
                [fn('COUNT', col('id')), 'total'],
                [fn('SUM', literal(`CASE WHEN status = 'delivered' THEN 1 ELSE 0 END`)), 'completed'],
                [fn('SUM', literal(`CASE WHEN status = 'delivered' THEN total_price ELSE 0 END`)), 'revenue'],
                [fn('SUM', literal(`CASE WHEN status = 'delivered' THEN commission_amount ELSE 0 END`)), 'commission'],
            ],
            group:  [fn('DATE', col('created_at'))],
            order:  [[fn('DATE', col('created_at')), 'ASC']],
            raw:    true,
        });

        // ── 3. PACKAGE SIZE DISTRIBUTION ────────────────────────────────────
        const packageSizeStats = await Delivery.findAll({
            where: { ...dateWhere, status: 'delivered' },
            attributes: [
                'package_size',
                [fn('COUNT', col('id')), 'count'],
                [fn('SUM', col('total_price')), 'revenue'],
            ],
            group: ['package_size'],
            raw:   true,
        });

        // ── 4. PAYMENT METHOD BREAKDOWN ──────────────────────────────────────
        const paymentStats = await Delivery.findAll({
            where: { ...dateWhere, status: 'delivered' },
            attributes: [
                'payment_method',
                [fn('COUNT', col('id')), 'count'],
                [fn('SUM', col('total_price')), 'revenue'],
            ],
            group: ['payment_method'],
            raw:   true,
        });

        // ── 5. SURGE STATS ───────────────────────────────────────────────────
        const surgeDeliveries = await Delivery.count({
            where: {
                ...dateWhere,
                surge_multiplier_applied: { [Op.gt]: 1.00 },
            },
        });

        const avgSurgeMultiplier = await Delivery.findOne({
            where: {
                ...dateWhere,
                status: 'delivered',
                surge_multiplier_applied: { [Op.gt]: 1.00 },
            },
            attributes: [[fn('AVG', col('surge_multiplier_applied')), 'avg']],
            raw: true,
        });

        // ── 6. TOP PERFORMING AGENTS ─────────────────────────────────────────
        const topAgentsRaw = await Delivery.findAll({
            where: { ...dateWhere, status: 'delivered', driver_id: { [Op.not]: null } },
            attributes: [
                'driver_id',
                [fn('COUNT', col('id')),             'deliveries'],
                [fn('SUM', col('driver_payout')),    'earnings'],
                [fn('AVG', col('rating')),           'avgRating'],
                [fn('SUM', col('commission_amount')),'commission'],
            ],
            group: ['driver_id'],
            order: [[fn('COUNT', col('id')), 'DESC']],
            limit: 10,
            raw:   true,
        });

        // Enrich top agents with names
        const topAgents = await Promise.all(topAgentsRaw.map(async (agent) => {
            const driver = await Driver.findByPk(agent.driver_id, { attributes: ['userId','phone','rating'] });
            let name = 'Unknown';
            if (driver?.userId) {
                const acc = await Account.findOne({
                    where:      { uuid: driver.userId },
                    attributes: ['first_name', 'last_name'],
                });
                if (acc) name = `${acc.first_name} ${acc.last_name}`.trim();
            }
            return {
                driverId:   agent.driver_id,
                name,
                deliveries: parseInt(agent.deliveries),
                earnings:   parseFloat(agent.earnings || 0),
                commission: parseFloat(agent.commission || 0),
                avgRating:  agent.avgRating ? parseFloat(Number(agent.avgRating).toFixed(2)) : null,
            };
        }));

        // ── 7. HOURLY HEATMAP (which hours are busiest) ──────────────────────
        const hourlyStats = await Delivery.findAll({
            where: dateWhere,
            attributes: [
                [fn('HOUR', col('created_at')), 'hour'],
                [fn('COUNT', col('id')),        'count'],
            ],
            group: [fn('HOUR', col('created_at'))],
            order: [[fn('HOUR', col('created_at')), 'ASC']],
            raw:   true,
        });

        // Fill missing hours with 0
        const hourlyHeatmap = Array.from({ length: 24 }, (_, h) => {
            const found = hourlyStats.find((s) => parseInt(s.hour) === h);
            return { hour: h, count: found ? parseInt(found.count) : 0 };
        });

        return res.json({
            success: true,
            period: { from: dateFrom, to: dateTo, label: period },

            overview: {
                totalDeliveries,
                completedDeliveries,
                cancelledDeliveries,
                completionRate,
                totalRevenue:    totalRevenue    || 0,
                totalCommission: totalCommission || 0,
                totalDriverPayout: totalDriverPayout || 0,
                avgOrderValue,
                surgeDeliveries,
                avgSurgeMultiplier: avgSurgeMultiplier?.avg
                    ? parseFloat(Number(avgSurgeMultiplier.avg).toFixed(2))
                    : null,
            },

            dailyTrend: dailyTrend.map(d => ({
                date:       d.date,
                total:      parseInt(d.total),
                completed:  parseInt(d.completed || 0),
                revenue:    parseFloat(d.revenue  || 0),
                commission: parseFloat(d.commission || 0),
            })),

            packageSizeStats: packageSizeStats.map(p => ({
                size:    p.package_size,
                count:   parseInt(p.count),
                revenue: parseFloat(p.revenue || 0),
            })),

            paymentStats: paymentStats.map(p => ({
                method:  p.payment_method,
                count:   parseInt(p.count),
                revenue: parseFloat(p.revenue || 0),
            })),

            topAgents,
            hourlyHeatmap,
        });

    } catch (error) {
        console.error('❌ [ANALYTICS] getAnalytics error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch analytics' });
    }
};