// backend/src/controllers/backoffice/serviceAdmin.controller.js
// Service Admin Dashboard — classifieds model

const {
    ServiceListing,
    ServiceAdPayment,
    ServiceListingPlan,
    ServiceCategory,
    ServiceRating,
    Account,
} = require('../../models');
const { Op, fn, col } = require('sequelize');

// ═══════════════════════════════════════════════════════════════════════
// GET /api/services/admin/dashboard/stats
// ═══════════════════════════════════════════════════════════════════════
exports.getDashboardStats = async (req, res) => {
    try {
        const today    = new Date(); today.setHours(0, 0, 0, 0);
        const monthAgo = new Date(Date.now() - 30 * 86400000);

        // Listings
        const [pendingReview, heroQueue, active, total] = await Promise.all([
            ServiceListing.count({ where: { status: 'pending_review' } }),
            ServiceListing.count({ where: { status: 'hero_pending'   } }),
            ServiceListing.count({ where: { status: 'active'         } }),
            ServiceListing.count(),
        ]);

        // Providers
        const activeProvidersRows = await ServiceListing.findAll({
            attributes: [[fn('DISTINCT', col('provider_id')), 'provider_id']],
            where: { status: 'active' },
            raw: true,
        });
        const activeProviders = activeProvidersRows.length;

        const allProvidersRows = await ServiceListing.findAll({
            attributes: [[fn('DISTINCT', col('provider_id')), 'provider_id']],
            raw: true,
        });
        const totalProviders = allProvidersRows.length;

        // Ratings
        const [avgRow] = await ServiceRating.findAll({
            attributes: [[fn('AVG', col('rating')), 'avg']],
            raw: true,
        });
        const averageRating = parseFloat(avgRow?.avg ?? 0).toFixed(2);

        // Plan revenue
        const [revenueAllRow] = await ServiceAdPayment.findAll({
            attributes: [[fn('SUM', col('amount_snapshot')), 'total']],
            where: { status: { [Op.in]: ['active', 'expired'] } },
            raw: true,
        });
        const totalPlanRevenue = parseFloat(revenueAllRow?.total ?? 0);

        const [revMonthRow] = await ServiceAdPayment.findAll({
            attributes: [[fn('SUM', col('amount_snapshot')), 'total']],
            where: { status: { [Op.in]: ['active', 'expired'] }, created_at: { [Op.gte]: monthAgo } },
            raw: true,
        });
        const revenueLast30Days = parseFloat(revMonthRow?.total ?? 0);

        const [revTodayRow] = await ServiceAdPayment.findAll({
            attributes: [[fn('SUM', col('amount_snapshot')), 'total']],
            where: { status: { [Op.in]: ['active', 'expired'] }, created_at: { [Op.gte]: today } },
            raw: true,
        });
        const revenueToday = parseFloat(revTodayRow?.total ?? 0);

        const activePlans  = await ServiceAdPayment.count({ where: { status: 'active' } });
        const expiredPlans = await ServiceAdPayment.count({ where: { status: 'expired' } });
        const pendingPlans = await ServiceAdPayment.count({ where: { status: 'pending_payment' } });

        return res.json({
            success: true,
            data: {
                listings: {
                    total,
                    active,
                    pending_review: pendingReview,
                    hero_queue:     heroQueue,
                },
                providers: {
                    total:  totalProviders,
                    active: activeProviders,
                },
                ratings: {
                    average: averageRating,
                },
                revenue: {
                    total:         totalPlanRevenue,
                    last_30_days:  revenueLast30Days,
                    today:         revenueToday,
                    active_plans:  activePlans,
                    expired_plans: expiredPlans,
                    pending_plans: pendingPlans,
                },
            },
        });
    } catch (err) {
        console.error('❌ [SERVICE_ADMIN] getDashboardStats:', err);
        return res.status(500).json({ success: false, message: 'Failed to fetch stats', error: err.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET /api/services/admin/dashboard/quick-stats
// Lightweight polling endpoint
// ═══════════════════════════════════════════════════════════════════════
exports.getQuickStats = async (req, res) => {
    try {
        const [pendingReview, heroQueue, activePlans] = await Promise.all([
            ServiceListing.count({ where: { status: 'pending_review' } }),
            ServiceListing.count({ where: { status: 'hero_pending'   } }),
            ServiceAdPayment.count({ where: { status: 'active' } }),
        ]);

        return res.json({
            success: true,
            data: { pending_review: pendingReview, hero_queue: heroQueue, active_plans: activePlans },
        });
    } catch (err) {
        console.error('❌ [SERVICE_ADMIN] getQuickStats:', err);
        return res.status(500).json({ success: false, message: 'Failed to fetch quick stats' });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET /api/services/admin/ad-payments
// List all ad payments (plan sales) for backoffice Plan Sales page
// ═══════════════════════════════════════════════════════════════════════
exports.getAdminAdPayments = async (req, res) => {
    try {
        const { status, date_range, page = 1, limit = 50 } = req.query;
        const where = {};

        if (status && status !== 'all') where.status = status;

        if (date_range && date_range !== 'all') {
            const now   = new Date();
            let   start = new Date();
            switch (date_range) {
                case 'today': start.setHours(0, 0, 0, 0); break;
                case 'week':  start = new Date(now.getTime() - 7 * 86400000); break;
                case 'month': start = new Date(now.getFullYear(), now.getMonth(), 1); break;
            }
            where.created_at = { [Op.gte]: start };
        }

        const offset = (parseInt(page) - 1) * parseInt(limit);

        const { count, rows: payments } = await ServiceAdPayment.findAndCountAll({
            where,
            include: [
                { model: ServiceListingPlan, as: 'plan',    attributes: ['label_fr', 'label_en', 'plan_key', 'boost_priority'] },
                { model: Account,            as: 'seller',  attributes: ['first_name', 'last_name', 'phone_e164'] },
                { model: ServiceListing,     as: 'listing', attributes: ['title'], required: false },
            ],
            order:  [['created_at', 'DESC']],
            limit:  parseInt(limit),
            offset,
        });

        // Stats
        const [totalRevRow] = await ServiceAdPayment.findAll({
            attributes: [[fn('SUM', col('amount_snapshot')), 'total']],
            where: { status: { [Op.in]: ['active', 'expired'] } },
            raw: true,
        });

        const [activePlans, expiredPlans, pendingPlans] = await Promise.all([
            ServiceAdPayment.count({ where: { status: 'active' } }),
            ServiceAdPayment.count({ where: { status: 'expired' } }),
            ServiceAdPayment.count({ where: { status: 'pending_payment' } }),
        ]);

        const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
        const salesThisMonth = await ServiceAdPayment.count({
            where: { status: { [Op.in]: ['active', 'expired'] }, created_at: { [Op.gte]: monthStart } },
        });

        const formatted = payments.map(p => ({
            id:                        p.id,
            plan_key_snapshot:         p.plan_key_snapshot,
            duration_days_snapshot:    p.duration_days_snapshot,
            is_hero_placement_snapshot: p.is_hero_placement_snapshot,
            amount_snapshot:           p.amount_snapshot,
            status:                    p.status,
            plan_starts_at:            p.plan_starts_at,
            plan_expires_at:           p.plan_expires_at,
            created_at:                p.createdAt,
            paid_by:                   p.paid_by,
            seller_name:               `${p.seller?.first_name ?? ''} ${p.seller?.last_name ?? ''}`.trim(),
            seller_phone:              p.seller?.phone_e164 ?? '',
            listing_id:                p.listing_id,
            listing_title:             p.listing?.title ?? null,
            plan_label:                p.plan?.label_fr ?? p.plan?.label_en ?? p.plan_key_snapshot,
        }));

        return res.json({
            success: true,
            data: {
                payments: formatted,
                pagination: { total: count, page: parseInt(page), limit: parseInt(limit) },
                stats: {
                    total_revenue:    parseFloat(totalRevRow?.total ?? 0),
                    active_plans:     activePlans,
                    expired_plans:    expiredPlans,
                    pending_plans:    pendingPlans,
                    sales_this_month: salesThisMonth,
                },
            },
        });
    } catch (err) {
        console.error('❌ [SERVICE_ADMIN] getAdminAdPayments:', err);
        return res.status(500).json({ success: false, message: 'Failed to load plan sales', error: err.message });
    }
};
