// backend/src/controllers/backoffice/serviceReportsAdmin.controller.js
// Services Marketplace — Plan Revenue Reports (classifieds model)

const {
    ServiceAdPayment,
    ServiceListingPlan,
    ServiceListing,
    ServiceCategory,
    ServiceRating,
    Account,
} = require('../../models');
const { Op, fn, col, literal } = require('sequelize');
const db = require('../../config/database');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const dateRange = (range, startRaw, endRaw) => {
    const now   = new Date();
    let start, end;
    if (range === 'custom' && startRaw && endRaw) {
        start = new Date(startRaw);
        end   = new Date(endRaw);
    } else {
        end = now;
        switch (range) {
            case 'today': start = new Date(now); start.setHours(0, 0, 0, 0); break;
            case 'week':  start = new Date(now.getTime() - 7 * 86400000);     break;
            case 'year':  start = new Date(now.getFullYear(), 0, 1);           break;
            default:      start = new Date(now.getFullYear(), now.getMonth(), 1); // month
        }
    }
    return { start, end };
};

const monthStart = () => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
};

// ═══════════════════════════════════════════════════════════════════════
// GET /api/services/admin/reports
// ═══════════════════════════════════════════════════════════════════════
exports.getReportsData = async (req, res) => {
    try {
        const { date_range = 'month', start_date, end_date } = req.query;
        const { start, end } = dateRange(date_range, start_date, end_date);

        const rangeFilter = {
            created_at: { [Op.between]: [start, end] },
        };
        const paidFilter = {
            ...rangeFilter,
            status: { [Op.in]: ['active', 'expired'] },
        };

        // ── 1. Overview KPIs ───────────────────────────────────────────
        const [totalRevRow] = await ServiceAdPayment.findAll({
            attributes: [[fn('SUM', col('amount_snapshot')), 'total']],
            where: paidFilter,
            raw: true,
        });
        const totalRevenue = parseFloat(totalRevRow?.total ?? 0);

        // prev period for growth rate
        const periodMs   = end - start;
        const prevStart  = new Date(start.getTime() - periodMs);
        const prevEnd    = new Date(start.getTime() - 1);
        const [prevRow]  = await ServiceAdPayment.findAll({
            attributes: [[fn('SUM', col('amount_snapshot')), 'total']],
            where: { created_at: { [Op.between]: [prevStart, prevEnd] }, status: { [Op.in]: ['active', 'expired'] } },
            raw: true,
        });
        const prevRevenue  = parseFloat(prevRow?.total ?? 0);
        const growthRate   = prevRevenue > 0 ? ((totalRevenue - prevRevenue) / prevRevenue) * 100 : 0;

        const activeListings  = await ServiceListing.count({ where: { status: 'active' } });
        const activeProviders = await ServiceListing.count({
            where:    { status: 'active' },
            distinct: true,
            col:      'provider_id',
        });

        const [avgRow] = await ServiceRating.findAll({
            attributes: [[fn('AVG', col('rating')), 'avg']],
            raw: true,
        });
        const averageRating = parseFloat(avgRow?.avg ?? 0);

        const plansThisMonth = await ServiceAdPayment.count({
            where: { created_at: { [Op.gte]: monthStart() }, status: { [Op.in]: ['active', 'expired'] } },
        });

        // ── 2. Revenue by day (last 30 days) ──────────────────────────
        const thirtyAgo = new Date(Date.now() - 30 * 86400000);
        thirtyAgo.setHours(0, 0, 0, 0);

        const revByDay = await ServiceAdPayment.findAll({
            attributes: [
                [fn('DATE', col('created_at')), 'date'],
                [fn('SUM', col('amount_snapshot')), 'amount'],
                [fn('COUNT', col('id')), 'count'],
            ],
            where: { created_at: { [Op.gte]: thirtyAgo }, status: { [Op.in]: ['active', 'expired'] } },
            group: [fn('DATE', col('created_at'))],
            order: [[fn('DATE', col('created_at')), 'ASC']],
            raw: true,
        });

        const revenueByDay = revByDay.map(r => ({
            date:   r.date,
            amount: parseFloat(r.amount ?? 0),
            count:  parseInt(r.count ?? 0),
        }));

        // ── 3. Revenue by plan type ───────────────────────────────────
        const planRows = await ServiceAdPayment.findAll({
            attributes: [
                'plan_key_snapshot',
                [fn('SUM', col('amount_snapshot')), 'amount'],
                [fn('COUNT', col('ServiceAdPayment.id')), 'count'],
            ],
            where: paidFilter,
            include: [{ model: ServiceListingPlan, as: 'plan', attributes: ['label_fr', 'label_en'] }],
            group: ['plan_key_snapshot', 'plan.id'],
            raw: true,
        });

        const totalPlanRev = planRows.reduce((s, r) => s + parseFloat(r.amount ?? 0), 0) || 1;
        const revenueByPlan = planRows.map(r => ({
            plan_key:   r.plan_key_snapshot,
            label:      r['plan.label_fr'] ?? r['plan.label_en'] ?? r.plan_key_snapshot,
            amount:     parseFloat(r.amount ?? 0),
            count:      parseInt(r.count ?? 0),
            percentage: (parseFloat(r.amount ?? 0) / totalPlanRev) * 100,
        }));

        // ── 4. Top providers by listing count ─────────────────────────
        const topProvRows = await ServiceListing.findAll({
            attributes: [
                'provider_id',
                [fn('COUNT', col('ServiceListing.id')), 'listing_count'],
            ],
            where: { status: 'active' },
            include: [{ model: Account, as: 'provider', attributes: ['first_name', 'last_name'] }],
            group: ['provider_id', 'provider.uuid'],
            order: [[fn('COUNT', col('ServiceListing.id')), 'DESC']],
            limit: 10,
            raw: true,
        });

        const topProviders = topProvRows.map(r => ({
            id:            r.provider_id,
            name:          `${r['provider.first_name'] ?? ''} ${r['provider.last_name'] ?? ''}`.trim(),
            listing_count: parseInt(r.listing_count ?? 0),
            rating:        0, // populated below
        }));

        // fetch avg rating per provider
        const providerIds = topProviders.map(p => p.id);
        if (providerIds.length) {
            const ratingRows = await ServiceRating.findAll({
                attributes: ['provider_id', [fn('AVG', col('rating')), 'avg']],
                where:  { provider_id: { [Op.in]: providerIds } },
                group:  ['provider_id'],
                raw:    true,
            });
            const ratingMap = Object.fromEntries(ratingRows.map(r => [r.provider_id, parseFloat(r.avg ?? 0)]));
            topProviders.forEach(p => { p.rating = ratingMap[p.id] ?? 0; });
        }

        // ── 5. Listing status breakdown ───────────────────────────────
        const statusRows = await ServiceListing.findAll({
            attributes: ['status', [fn('COUNT', col('id')), 'count']],
            where: { status: { [Op.in]: ['active', 'pending_review', 'hero_pending', 'inactive'] } },
            group: ['status'],
            raw: true,
        });
        const statusMap = Object.fromEntries(statusRows.map(r => [r.status, parseInt(r.count ?? 0)]));

        // count expired (plan_expires_at < now AND status = active)
        const expiredCount = await ServiceAdPayment.count({ where: { status: 'expired' } });

        const listingStatusBreakdown = {
            active:         statusMap.active         ?? 0,
            pending_review: statusMap.pending_review ?? 0,
            hero_pending:   statusMap.hero_pending   ?? 0,
            expired:        expiredCount,
        };

        // ── Response ──────────────────────────────────────────────────
        return res.json({
            success: true,
            data: {
                overview: {
                    total_plan_revenue:    totalRevenue,
                    active_listings:       activeListings,
                    active_providers:      activeProviders,
                    average_rating:        averageRating,
                    plans_sold_this_month: plansThisMonth,
                    growth_rate:           growthRate,
                },
                revenue_by_day:           revenueByDay,
                revenue_by_plan:          revenueByPlan,
                top_providers:            topProviders,
                listing_status_breakdown: listingStatusBreakdown,
            },
        });
    } catch (err) {
        console.error('❌ [SERVICE_REPORTS] getReportsData error:', err);
        return res.status(500).json({ success: false, message: 'Failed to load report data', error: err.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// EXPORT — stub stubs (CSV only; PDF/Excel require optional packages)
// ═══════════════════════════════════════════════════════════════════════

exports.exportToCSV = async (req, res) => {
    try {
        const { date_range = 'month', start_date, end_date } = req.query;
        const { start, end } = dateRange(date_range, start_date, end_date);

        const payments = await ServiceAdPayment.findAll({
            where: {
                created_at: { [Op.between]: [start, end] },
                status:     { [Op.in]: ['active', 'expired'] },
            },
            include: [
                { model: ServiceListingPlan, as: 'plan',    attributes: ['label_fr'] },
                { model: Account,            as: 'seller',  attributes: ['first_name', 'last_name', 'phone_e164'] },
                { model: ServiceListing,     as: 'listing', attributes: ['title'] },
            ],
            order: [['created_at', 'DESC']],
        });

        const header = 'ID,Vendeur,Téléphone,Plan,Annonce,Montant XAF,Statut,Début,Fin,Acheté le\n';
        const rows   = payments.map(p => [
            p.id,
            `${p.seller?.first_name ?? ''} ${p.seller?.last_name ?? ''}`.trim(),
            p.seller?.phone_e164 ?? '',
            p.plan?.label_fr ?? p.plan_key_snapshot,
            p.listing?.title ?? '',
            p.amount_snapshot,
            p.status,
            p.plan_starts_at ?? '',
            p.plan_expires_at ?? '',
            p.createdAt?.toISOString().split('T')[0] ?? '',
        ].join(',')).join('\n');

        const filename = `wego_plan_sales_${new Date().toISOString().split('T')[0]}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.send(header + rows);
    } catch (err) {
        console.error('❌ [SERVICE_REPORTS] exportToCSV error:', err);
        return res.status(500).json({ success: false, message: 'CSV export failed' });
    }
};

exports.exportToExcel = async (req, res) => {
    return res.status(501).json({ success: false, message: 'Excel export not available — use CSV export' });
};

exports.exportToPDF = async (req, res) => {
    return res.status(501).json({ success: false, message: 'PDF export not available — use CSV export' });
};
