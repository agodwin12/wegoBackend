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

// ═══════════════════════════════════════════════════════════════════════
// GET /api/services/admin/subscriptions
// Provider-level subscriptions (ServiceAdPayment where listing_id = null),
// with subscriber KPIs + combined services-ad revenue.
// ═══════════════════════════════════════════════════════════════════════
exports.getSubscriptions = async (req, res) => {
    try {
        const { status, plan, page = 1, limit = 50 } = req.query;
        const where = { listing_id: null };
        if (status && status !== 'all') where.status = status;
        if (plan   && plan   !== 'all') where.plan_key_snapshot = plan;

        const offset = (parseInt(page) - 1) * parseInt(limit);

        const { count, rows } = await ServiceAdPayment.findAndCountAll({
            where,
            include: [
                { model: ServiceListingPlan, as: 'plan',  attributes: ['label_fr', 'label_en', 'plan_key', 'listing_quota', 'boost_priority'], required: false },
                { model: Account,            as: 'payer', attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'email'], required: false },
            ],
            order:  [['created_at', 'DESC']],
            limit:  parseInt(limit),
            offset,
        });

        // listings-used per provider — one grouped query (no N+1)
        const providerIds = [...new Set(rows.map(r => r.paid_by))];
        let usedByProvider = {};
        if (providerIds.length) {
            const usedRows = await ServiceListing.findAll({
                where:      { provider_id: { [Op.in]: providerIds }, status: { [Op.ne]: 'deleted' } },
                attributes: ['provider_id', [fn('COUNT', col('id')), 'cnt']],
                group:      ['provider_id'],
                raw:        true,
            });
            usedByProvider = Object.fromEntries(usedRows.map(u => [u.provider_id, parseInt(u.cnt, 10)]));
        }

        // KPIs
        const now = new Date();
        const in7 = new Date(now.getTime() + 7 * 86400000);
        const [activeSubscribers, expiringSoon] = await Promise.all([
            ServiceAdPayment.count({ where: { listing_id: null, status: 'active', plan_expires_at: { [Op.gt]: now } } }),
            ServiceAdPayment.count({ where: { listing_id: null, status: 'active', plan_expires_at: { [Op.gt]: now, [Op.lte]: in7 } } }),
        ]);

        // Combined services-ad revenue (subscriptions + per-listing ads).
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        const monthAgo   = new Date(Date.now() - 30 * 86400000);
        const revWhere   = { status: { [Op.in]: ['active', 'expired'] } };
        const sumAmount  = (extra = {}) => ServiceAdPayment.findAll({
            attributes: [[fn('SUM', col('amount_snapshot')), 't']],
            where:      { ...revWhere, ...extra },
            raw:        true,
        }).then(r => parseFloat(r[0]?.t ?? 0));
        const [revTotal, rev30d, revToday] = await Promise.all([
            sumAmount(),
            sumAmount({ created_at: { [Op.gte]: monthAgo } }),
            sumAmount({ created_at: { [Op.gte]: todayStart } }),
        ]);

        const subscriptions = rows.map(r => ({
            id:             r.id,
            provider_uuid:  r.paid_by,
            provider_name:  `${r.payer?.first_name ?? ''} ${r.payer?.last_name ?? ''}`.trim() || '—',
            provider_phone: r.payer?.phone_e164 ?? '',
            provider_email: r.payer?.email ?? '',
            plan_key:       r.plan_key_snapshot,
            plan_label:     r.plan?.label_fr || r.plan?.label_en || r.plan_key_snapshot,
            amount:         parseFloat(r.amount_snapshot ?? 0),
            status:         r.status,
            started_at:     r.plan_starts_at,
            expires_at:     r.plan_expires_at,
            listings_used:  usedByProvider[r.paid_by] ?? 0,
            listing_quota:  r.plan?.listing_quota ?? null,
            notes:          r.notes ?? null,
            created_at:     r.createdAt,
        }));

        return res.json({
            success: true,
            data: {
                subscriptions,
                pagination: { total: count, page: parseInt(page), limit: parseInt(limit) },
                stats: {
                    active_subscribers: activeSubscribers,
                    expiring_7d:        expiringSoon,
                    revenue_total:      revTotal,
                    revenue_30d:        rev30d,
                    revenue_today:      revToday,
                },
            },
        });
    } catch (err) {
        console.error('❌ [SERVICE_ADMIN] getSubscriptions:', err);
        return res.status(500).json({ success: false, message: 'Failed to fetch subscriptions', error: err.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /api/services/admin/subscriptions/:id/cancel   body: { reason? }
// ═══════════════════════════════════════════════════════════════════════
exports.cancelSubscription = async (req, res) => {
    try {
        const { id }     = req.params;
        const { reason } = req.body || {};
        const empId   = req.employee?.id;
        const empName = `${req.employee?.first_name || ''} ${req.employee?.last_name || ''}`.trim()
            || req.employee?.name || 'Admin';

        const sub = await ServiceAdPayment.findOne({ where: { id, listing_id: null } });
        if (!sub) return res.status(404).json({ success: false, message: 'Subscription not found.' });
        if (sub.status === 'cancelled') {
            return res.json({ success: true, message: 'Already cancelled.', data: { id: sub.id, status: 'cancelled' } });
        }

        await sub.update({
            status: 'cancelled',
            notes:  `Cancelled by ${empName} (#${empId})${reason ? `: ${reason}` : ''} on ${new Date().toISOString()}`.slice(0, 300),
        });
        console.log(`🧾 [SERVICE_ADMIN] Subscription #${id} cancelled by employee #${empId}${reason ? ` (${reason})` : ''}`);
        return res.json({ success: true, message: 'Subscription cancelled.', data: { id: sub.id, status: 'cancelled' } });
    } catch (err) {
        console.error('❌ [SERVICE_ADMIN] cancelSubscription:', err);
        return res.status(500).json({ success: false, message: 'Failed to cancel subscription.' });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /api/services/admin/subscriptions/:id/extend   body: { days }
// ═══════════════════════════════════════════════════════════════════════
exports.extendSubscription = async (req, res) => {
    try {
        const { id } = req.params;
        const days   = parseInt(req.body?.days, 10);
        const empId   = req.employee?.id;
        const empName = `${req.employee?.first_name || ''} ${req.employee?.last_name || ''}`.trim()
            || req.employee?.name || 'Admin';

        if (!days || days <= 0 || days > 3650) {
            return res.status(400).json({ success: false, message: 'days must be a positive number (max 3650).' });
        }

        const sub = await ServiceAdPayment.findOne({ where: { id, listing_id: null } });
        if (!sub) return res.status(404).json({ success: false, message: 'Subscription not found.' });
        if (sub.status === 'cancelled' || sub.status === 'refunded') {
            return res.status(409).json({ success: false, message: `Cannot extend a ${sub.status} subscription.` });
        }

        // Extend from the later of now / current expiry, so an expired plan revives cleanly.
        const base = sub.plan_expires_at && new Date(sub.plan_expires_at) > new Date()
            ? new Date(sub.plan_expires_at)
            : new Date();
        const newExpiry = new Date(base.getTime() + days * 86400000);

        await sub.update({
            plan_expires_at: newExpiry,
            status:          'active',
            notes:           `Extended +${days}d by ${empName} (#${empId}) on ${new Date().toISOString()}`.slice(0, 300),
        });
        console.log(`🧾 [SERVICE_ADMIN] Subscription #${id} extended +${days}d by employee #${empId} → ${newExpiry.toISOString()}`);
        return res.json({ success: true, message: `Extended by ${days} day(s).`, data: { id: sub.id, status: 'active', plan_expires_at: newExpiry } });
    } catch (err) {
        console.error('❌ [SERVICE_ADMIN] extendSubscription:', err);
        return res.status(500).json({ success: false, message: 'Failed to extend subscription.' });
    }
};
