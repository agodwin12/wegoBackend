// src/controllers/backoffice/deliveryOverview.controller.js

const { Op, fn, col, literal } = require('sequelize');
const { Delivery, DeliveryDispute, Driver, Account, sequelize } = require('../../models');

// ═══════════════════════════════════════════════════════════════════════════════
// GET DELIVERY OVERVIEW DASHBOARD
// GET /api/backoffice/delivery/overview
// ═══════════════════════════════════════════════════════════════════════════════
exports.getOverview = async (req, res) => {
    try {
        const now        = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const weekStart  = new Date(todayStart); weekStart.setDate(weekStart.getDate() - 7);
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

        // ── TODAY STATS ────────────────────────────────────────────────────
        const [
            todayTotal,
            todayDelivered,
            todayCancelled,
            todayRevenue,
            todayCommission,
        ] = await Promise.all([
            Delivery.count({ where: { created_at: { [Op.gte]: todayStart } } }),
            Delivery.count({ where: { created_at: { [Op.gte]: todayStart }, status: 'delivered' } }),
            Delivery.count({ where: { created_at: { [Op.gte]: todayStart }, status: 'cancelled' } }),
            Delivery.sum('total_price',      { where: { created_at: { [Op.gte]: todayStart }, status: 'delivered' } }),
            Delivery.sum('commission_amount',{ where: { created_at: { [Op.gte]: todayStart }, status: 'delivered' } }),
        ]);

        // ── THIS WEEK STATS ────────────────────────────────────────────────
        const [
            weekTotal,
            weekDelivered,
            weekRevenue,
            weekCommission,
        ] = await Promise.all([
            Delivery.count({ where: { created_at: { [Op.gte]: weekStart } } }),
            Delivery.count({ where: { created_at: { [Op.gte]: weekStart }, status: 'delivered' } }),
            Delivery.sum('total_price',      { where: { created_at: { [Op.gte]: weekStart }, status: 'delivered' } }),
            Delivery.sum('commission_amount',{ where: { created_at: { [Op.gte]: weekStart }, status: 'delivered' } }),
        ]);

        // ── THIS MONTH STATS ───────────────────────────────────────────────
        const [
            monthTotal,
            monthDelivered,
            monthRevenue,
            monthCommission,
        ] = await Promise.all([
            Delivery.count({ where: { created_at: { [Op.gte]: monthStart } } }),
            Delivery.count({ where: { created_at: { [Op.gte]: monthStart }, status: 'delivered' } }),
            Delivery.sum('total_price',      { where: { created_at: { [Op.gte]: monthStart }, status: 'delivered' } }),
            Delivery.sum('commission_amount',{ where: { created_at: { [Op.gte]: monthStart }, status: 'delivered' } }),
        ]);

        // ── LIVE STATUS ────────────────────────────────────────────────────
        const ACTIVE_STATUSES = [
            'accepted', 'en_route_pickup', 'arrived_pickup',
            'picked_up', 'en_route_dropoff', 'arrived_dropoff',
        ];

        const [
            activeDeliveries,
            searchingDeliveries,
            onlineAgents,
            busyAgents,
            openDisputes,
        ] = await Promise.all([
            Delivery.count({ where: { status: { [Op.in]: ACTIVE_STATUSES } } }),
            Delivery.count({ where: { status: 'searching' } }),
            Driver.count({ where: { current_mode: 'delivery', status: 'online' } }),
            Driver.count({ where: { current_mode: 'delivery', status: 'busy' } }),
            DeliveryDispute.count({ where: { status: { [Op.in]: ['open', 'investigating'] } } }),
        ]);

        // ── STATUS BREAKDOWN (today) ───────────────────────────────────────
        const statusBreakdown = await Delivery.findAll({
            where:      { created_at: { [Op.gte]: todayStart } },
            attributes: ['status', [fn('COUNT', col('id')), 'count']],
            group:      ['status'],
            raw:        true,
        });

        // ── LAST 7 DAYS SPARKLINE ──────────────────────────────────────────
        const last7Days = await Delivery.findAll({
            where: { created_at: { [Op.gte]: weekStart } },
            attributes: [
                [fn('DATE', col('created_at')), 'date'],
                [fn('COUNT', col('id')),        'total'],
                [fn('SUM', literal(`CASE WHEN status = 'delivered' THEN 1 ELSE 0 END`)), 'delivered'],
                [fn('SUM', literal(`CASE WHEN status = 'delivered' THEN commission_amount ELSE 0 END`)), 'commission'],
            ],
            group:  [fn('DATE', col('created_at'))],
            order:  [[fn('DATE', col('created_at')), 'ASC']],
            raw:    true,
        });

        // ── RECENT DELIVERIES (last 8) ─────────────────────────────────────
        const recentDeliveries = await Delivery.findAll({
            order:      [['created_at', 'DESC']],
            limit:      8,
            attributes: [
                'id', 'delivery_code', 'status', 'package_size',
                'total_price', 'commission_amount', 'payment_method',
                'pickup_address', 'dropoff_address', 'created_at', 'delivered_at',
                'sender_id', 'driver_id',
            ],
            include: [
                { association: 'sender', attributes: ['uuid', 'first_name', 'last_name'] },
            ],
        });

        // Enrich driver names for recent deliveries
        const recentEnriched = await Promise.all(recentDeliveries.map(async (d) => {
            let driverName = '—';
            if (d.driver_id) {
                const driver = await Driver.findByPk(d.driver_id, { attributes: ['userId'] });
                if (driver?.userId) {
                    const acc = await Account.findOne({
                        where:      { uuid: driver.userId },
                        attributes: ['first_name', 'last_name'],
                    });
                    if (acc) driverName = `${acc.first_name} ${acc.last_name}`.trim();
                }
            }
            return {
                id:            d.id,
                deliveryCode:  d.delivery_code,
                status:        d.status,
                packageSize:   d.package_size,
                totalPrice:    parseFloat(d.total_price),
                commission:    parseFloat(d.commission_amount),
                paymentMethod: d.payment_method,
                pickupAddress: d.pickup_address,
                dropoffAddress:d.dropoff_address,
                createdAt:     d.created_at,
                deliveredAt:   d.delivered_at,
                senderName:    d.sender
                    ? `${d.sender.first_name} ${d.sender.last_name}`.trim()
                    : '—',
                driverName,
            };
        }));

        // ── ALERTS ─────────────────────────────────────────────────────────
        const alerts = [];

        if (openDisputes > 0) {
            alerts.push({
                type:    'warning',
                message: `${openDisputes} open dispute${openDisputes > 1 ? 's' : ''} require attention`,
                link:    '/dashboard/delivery/disputes',
            });
        }

        if (searchingDeliveries > 0) {
            alerts.push({
                type:    'info',
                message: `${searchingDeliveries} deliver${searchingDeliveries > 1 ? 'ies' : 'y'} searching for a driver`,
                link:    '/dashboard/delivery/live',
            });
        }

        if (onlineAgents === 0) {
            alerts.push({
                type:    'danger',
                message: 'No delivery agents are currently online',
                link:    '/dashboard/delivery/agents',
            });
        }

        return res.json({
            success: true,

            // Live counters (top of page)
            live: {
                activeDeliveries,
                searchingDeliveries,
                onlineAgents,
                busyAgents,
                openDisputes,
            },

            // Period stats
            today: {
                total:          todayTotal,
                delivered:      todayDelivered,
                cancelled:      todayCancelled,
                revenue:        todayRevenue    || 0,
                commission:     todayCommission || 0,
                completionRate: todayTotal > 0 ? Math.round((todayDelivered / todayTotal) * 100) : 0,
            },

            week: {
                total:          weekTotal,
                delivered:      weekDelivered,
                revenue:        weekRevenue    || 0,
                commission:     weekCommission || 0,
                completionRate: weekTotal > 0 ? Math.round((weekDelivered / weekTotal) * 100) : 0,
            },

            month: {
                total:          monthTotal,
                delivered:      monthDelivered,
                revenue:        monthRevenue    || 0,
                commission:     monthCommission || 0,
                completionRate: monthTotal > 0 ? Math.round((monthDelivered / monthTotal) * 100) : 0,
            },

            statusBreakdown: statusBreakdown.map(s => ({
                status: s.status,
                count:  parseInt(s.count),
            })),

            last7Days: last7Days.map(d => ({
                date:      d.date,
                total:     parseInt(d.total),
                delivered: parseInt(d.delivered || 0),
                commission:parseFloat(d.commission || 0),
            })),

            recentDeliveries: recentEnriched,
            alerts,
        });

    } catch (error) {
        console.error('❌ [OVERVIEW] getOverview error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch overview' });
    }
};