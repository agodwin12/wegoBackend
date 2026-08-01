// backend/src/controllers/backoffice/serviceProviderAdmin.controller.js
// Service Provider Admin Controller - Provider Management & Overview
//
// Account.status ENUM is UPPERCASE: 'ACTIVE' | 'PENDING' | 'SUSPENDED' | 'DELETED'.
// ServiceListing status uses a dedicated 'suspended' value for admin takedown
// (distinct from provider-set 'inactive'), so suspend/restore is unambiguous.

const {
    Account,
    ServiceListing,
    ServiceAdPayment,
    ServiceRating,
    ServiceCategory,
} = require('../../models');
const { Op } = require('sequelize');
const sequelize = require('sequelize');

// ═══════════════════════════════════════════════════════════════════════
// GET ALL PROVIDERS (Admin - accounts that own service listings)
// GET /api/services/admin/providers
//
// Bounded: paginate accounts at the DB (LIMIT/OFFSET), then enrich ONLY the
// current page with a constant number of grouped queries — never one query
// per provider. Global stats are a handful of aggregate COUNTs.
// ═══════════════════════════════════════════════════════════════════════

const NO_STORE = {
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'Pragma': 'no-cache',
    'Expires': '0',
};

const getAllProviders = async (req, res) => {
    try {
        const page   = Math.max(parseInt(req.query.page) || 1, 1);
        const limit  = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
        const offset = (page - 1) * limit;

        const { status, search, sort_by = 'recent', sort_order = 'DESC' } = req.query;

        console.log(`👥 [SERVICE_PROVIDER_ADMIN] providers page=${page} limit=${limit} status=${status || 'all'} sort=${sort_by}`);

        // Universe of providers = distinct provider_id on listings (one query)
        const providerRows = await ServiceListing.findAll({
            attributes: [[sequelize.fn('DISTINCT', sequelize.col('provider_id')), 'provider_id']],
            raw: true,
        });
        const allProviderIds = providerRows.map(p => p.provider_id).filter(Boolean);

        if (allProviderIds.length === 0) {
            res.set(NO_STORE);
            return res.status(200).json({
                success: true,
                message: 'No providers found',
                providers: [],
                stats: { total_providers: 0, active_providers: 0, verified_providers: 0, suspended_providers: 0, average_rating: 0, total_commission_due: '0.00' },
                pagination: { total: 0, page: 1, limit, totalPages: 0, hasNext: false, hasPrev: false },
            });
        }

        // Account-level filter (status + search), applied at the DB
        const where = { uuid: { [Op.in]: allProviderIds } };
        if (status === 'suspended')                       where.status = 'SUSPENDED';
        else if (status === 'active' || status === 'verified') where.status = 'ACTIVE';

        if (search) {
            where[Op.or] = [
                { first_name: { [Op.like]: `%${search}%` } },
                { last_name:  { [Op.like]: `%${search}%` } },
                { email:      { [Op.like]: `%${search}%` } },
                { phone_e164: { [Op.like]: `%${search}%` } },
            ];
        }

        // Page of accounts (DB-paginated). Ordered by created_at; rating/services
        // sorts are applied within the page (a global aggregate sort would need a
        // provider-stats rollup — out of scope here, the O(7N) blocker is the fix).
        const orderDir = String(sort_order).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
        const { count: totalMatching, rows: pageAccounts } = await Account.findAndCountAll({
            where,
            attributes: ['uuid', 'first_name', 'last_name', 'email', 'phone_e164', 'avatar_url', 'user_type', 'status', 'created_at'],
            order: [['created_at', orderDir]],
            limit,
            offset,
        });

        const pageIds = pageAccounts.map(a => a.uuid);

        // ── Batch-enrich ONLY the page (constant # of grouped queries) ─────────
        let listingByProvider = {}, planActiveByProvider = {}, ratingByProvider = {};
        if (pageIds.length > 0) {
            const [listingRows, planRows, ratingRows] = await Promise.all([
                ServiceListing.findAll({
                    attributes: ['provider_id', 'status', [sequelize.fn('COUNT', sequelize.col('id')), 'cnt']],
                    where: { provider_id: { [Op.in]: pageIds } },
                    group: ['provider_id', 'status'],
                    raw: true,
                }),
                ServiceAdPayment.findAll({
                    attributes: ['paid_by', [sequelize.fn('COUNT', sequelize.col('id')), 'cnt']],
                    where: { paid_by: { [Op.in]: pageIds }, status: 'active' },
                    group: ['paid_by'],
                    raw: true,
                }),
                ServiceRating.findAll({
                    attributes: ['provider_id', [sequelize.fn('AVG', sequelize.col('rating')), 'avg'], [sequelize.fn('COUNT', sequelize.col('rating')), 'cnt']],
                    where: { provider_id: { [Op.in]: pageIds } },
                    group: ['provider_id'],
                    raw: true,
                }),
            ]);

            for (const r of listingRows) {
                const b = (listingByProvider[r.provider_id] ||= { total: 0, active: 0, pending: 0 });
                const c = parseInt(r.cnt) || 0;
                b.total += c;
                if (r.status === 'active')         b.active  += c;
                if (r.status === 'pending_review') b.pending += c;
            }
            for (const r of planRows)   planActiveByProvider[r.paid_by]     = parseInt(r.cnt) || 0;
            for (const r of ratingRows) ratingByProvider[r.provider_id]     = { avg: parseFloat(r.avg) || 0, count: parseInt(r.cnt) || 0 };
        }

        const providers = pageAccounts.map((provider) => {
            const lb  = listingByProvider[provider.uuid] || { total: 0, active: 0, pending: 0 };
            const rt  = ratingByProvider[provider.uuid]  || { avg: 0, count: 0 };
            const avg = parseFloat((rt.avg || 0).toFixed(1));
            return {
                id: provider.uuid,
                uuid: provider.uuid,
                first_name: provider.first_name,
                last_name: provider.last_name,
                full_name: `${provider.first_name} ${provider.last_name}`,
                email: provider.email,
                phone: provider.phone_e164,
                phone_e164: provider.phone_e164,
                profile_image: provider.avatar_url,
                avatar_url: provider.avatar_url,
                location: 'Douala',
                user_type: provider.user_type,
                account_status: provider.status,
                is_verified: true,
                is_active: provider.status === 'ACTIVE',
                is_suspended: provider.status === 'SUSPENDED',
                is_driver: provider.user_type === 'driver',
                member_since: provider.created_at,
                joined_date: provider.created_at,
                last_active: provider.created_at,
                total_services: lb.total,
                completed_services: lb.active,
                active_services: planActiveByProvider[provider.uuid] || 0,
                cancelled_services: 0,
                completion_rate: 0,
                total_earnings: 0,
                commission_due: 0,
                commission_paid: 0,
                outstanding_commission: 0,
                rating: avg,
                average_rating: avg,
                total_reviews: rt.count,
                response_time_minutes: 0,
                average_response_time_minutes: 0,
                active_listings_count: lb.active,
                pending_listings_count: lb.pending,
                total_listings: lb.total,
                rejection_rate: 0,
            };
        });

        // Page-scoped sort for non-default keys (recent is already DB-ordered)
        if (sort_by === 'rating' || sort_by === 'services') {
            const key = sort_by === 'rating' ? 'rating' : 'total_services';
            const dir = orderDir === 'ASC' ? 1 : -1;
            providers.sort((a, b) => (a[key] - b[key]) * dir);
        }

        // ── Cheap global stats (constant # of queries) ────────────────────────
        const [activeProviders, suspendedProviders, avgRatingRow] = await Promise.all([
            Account.count({ where: { uuid: { [Op.in]: allProviderIds }, status: 'ACTIVE' } }),
            Account.count({ where: { uuid: { [Op.in]: allProviderIds }, status: 'SUSPENDED' } }),
            ServiceRating.findOne({
                attributes: [[sequelize.fn('AVG', sequelize.col('rating')), 'avg']],
                where: { provider_id: { [Op.in]: allProviderIds } },
                raw: true,
            }),
        ]);

        const totalPages = Math.ceil(totalMatching / limit);
        res.set(NO_STORE);
        res.status(200).json({
            success: true,
            message: 'All providers retrieved successfully',
            providers,
            stats: {
                total_providers: allProviderIds.length,
                active_providers: activeProviders,
                verified_providers: activeProviders,
                suspended_providers: suspendedProviders,
                average_rating: avgRatingRow?.avg ? parseFloat(parseFloat(avgRatingRow.avg).toFixed(1)) : 0,
                total_commission_due: '0.00',
            },
            pagination: {
                total: totalMatching,
                page,
                limit,
                totalPages,
                hasNext: page < totalPages,
                hasPrev: page > 1,
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_PROVIDER_ADMIN] Error in getAllProviders:', error);
        res.set(NO_STORE);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve providers. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET PROVIDER STATISTICS (Admin dashboard)
// GET /api/services/admin/providers/stats
// ═══════════════════════════════════════════════════════════════════════

const getProviderStats = async (req, res) => {
    try {
        // total distinct providers + distinct providers with an active listing,
        // via COUNT(DISTINCT ...) — no materialize-then-.length.
        const [{ total = 0 } = {}] = await ServiceListing.findAll({
            attributes: [[sequelize.fn('COUNT', sequelize.fn('DISTINCT', sequelize.col('provider_id'))), 'total']],
            raw: true,
        });
        const [{ active = 0 } = {}] = await ServiceListing.findAll({
            attributes: [[sequelize.fn('COUNT', sequelize.fn('DISTINCT', sequelize.col('provider_id'))), 'active']],
            where: { status: 'active' },
            raw: true,
        });

        const providerRows = await ServiceListing.findAll({
            attributes: [[sequelize.fn('DISTINCT', sequelize.col('provider_id')), 'provider_id']],
            raw: true,
        });
        const providerIds = providerRows.map(p => p.provider_id).filter(Boolean);

        let suspendedProviders = 0, averageRating = 0;
        if (providerIds.length > 0) {
            const [suspended, avgRow] = await Promise.all([
                Account.count({ where: { uuid: { [Op.in]: providerIds }, status: 'SUSPENDED' } }),
                ServiceRating.findOne({
                    attributes: [[sequelize.fn('AVG', sequelize.col('rating')), 'avg']],
                    where: { provider_id: { [Op.in]: providerIds } },
                    raw: true,
                }),
            ]);
            suspendedProviders = suspended;
            averageRating = avgRow?.avg ? parseFloat(parseFloat(avgRow.avg).toFixed(1)) : 0;
        }

        res.set(NO_STORE);
        res.status(200).json({
            success: true,
            message: 'Provider statistics retrieved successfully',
            data: {
                total_providers: parseInt(total) || 0,
                active_providers: parseInt(active) || 0,
                verified_providers: (parseInt(total) || 0) - suspendedProviders,
                suspended_providers: suspendedProviders,
                average_rating: averageRating,
                total_commission_due: '0.00',
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_PROVIDER_ADMIN] Error in getProviderStats:', error);
        res.set(NO_STORE);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve provider statistics. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

const getProviderById = async (req, res) => {
    try {
        const { id } = req.params;
        if (!id) {
            res.set(NO_STORE);
            return res.status(400).json({ success: false, message: 'Invalid provider ID.' });
        }

        const provider = await Account.findOne({
            where: { uuid: id },
            attributes: ['uuid', 'first_name', 'last_name', 'email', 'phone_e164', 'avatar_url', 'user_type', 'status', 'created_at', 'updated_at'],
        });

        if (!provider) {
            res.set(NO_STORE);
            return res.status(404).json({ success: false, message: 'Provider not found.' });
        }

        res.set(NO_STORE);
        res.status(200).json({
            success: true,
            message: 'Provider details retrieved successfully',
            data: {
                uuid: provider.uuid,
                first_name: provider.first_name,
                last_name: provider.last_name,
                full_name: `${provider.first_name} ${provider.last_name}`,
                email: provider.email,
                phone_e164: provider.phone_e164,
                avatar_url: provider.avatar_url,
                user_type: provider.user_type,
                account_status: provider.status,
                is_active: provider.status === 'ACTIVE',
                is_suspended: provider.status === 'SUSPENDED',
                joined_date: provider.created_at,
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_PROVIDER_ADMIN] Error in getProviderById:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve provider details.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// SUSPEND PROVIDER — blocks the account AND takes their live ads down
// ═══════════════════════════════════════════════════════════════════════

const suspendProvider = async (req, res) => {
    try {
        const { id } = req.params;
        const { suspension_reason } = req.body;

        if (!id || !suspension_reason || suspension_reason.trim().length < 10) {
            return res.status(400).json({ success: false, message: 'A suspension reason of at least 10 characters is required.' });
        }

        const provider = await Account.findOne({ where: { uuid: id } });
        if (!provider) {
            return res.status(404).json({ success: false, message: 'Provider not found.' });
        }
        if (provider.status === 'SUSPENDED') {
            return res.status(400).json({ success: false, message: 'Provider is already suspended.' });
        }

        // Atomic: block the account AND take their currently-live ads down.
        let hiddenCount = 0;
        await ServiceListing.sequelize.transaction(async (t) => {
            await provider.update({ status: 'SUSPENDED' }, { transaction: t });
            const [affected] = await ServiceListing.update(
                { status: 'suspended' },
                { where: { provider_id: id, status: 'active' }, transaction: t }
            );
            hiddenCount = affected || 0;
        });

        console.log(`✅ [SERVICE_PROVIDER_ADMIN] Provider ${id} suspended; ${hiddenCount} listing(s) taken down.`);

        res.set(NO_STORE);
        res.status(200).json({
            success: true,
            message: 'Provider suspended and their live listings taken down.',
            data: { provider_id: id, account_status: 'SUSPENDED', listings_taken_down: hiddenCount },
        });

    } catch (error) {
        console.error('❌ [SERVICE_PROVIDER_ADMIN] Error in suspendProvider:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to suspend provider.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// ACTIVATE PROVIDER — restores the account AND the ads suspension took down
// ═══════════════════════════════════════════════════════════════════════

const activateProvider = async (req, res) => {
    try {
        const { id } = req.params;
        if (!id) {
            return res.status(400).json({ success: false, message: 'Invalid provider ID.' });
        }

        const provider = await Account.findOne({ where: { uuid: id } });
        if (!provider) {
            return res.status(404).json({ success: false, message: 'Provider not found.' });
        }
        if (provider.status === 'ACTIVE') {
            return res.status(400).json({ success: false, message: 'Provider is already active.' });
        }

        // Restore only the listings admin-suspension took down ('suspended'),
        // never listings the provider themselves set to 'inactive'.
        let restoredCount = 0;
        await ServiceListing.sequelize.transaction(async (t) => {
            await provider.update({ status: 'ACTIVE' }, { transaction: t });
            const [affected] = await ServiceListing.update(
                { status: 'active' },
                { where: { provider_id: id, status: 'suspended' }, transaction: t }
            );
            restoredCount = affected || 0;
        });

        console.log(`✅ [SERVICE_PROVIDER_ADMIN] Provider ${id} activated; ${restoredCount} listing(s) restored.`);

        res.set(NO_STORE);
        res.status(200).json({
            success: true,
            message: 'Provider account reactivated and their listings restored.',
            data: { provider_id: id, account_status: 'ACTIVE', listings_restored: restoredCount },
        });

    } catch (error) {
        console.error('❌ [SERVICE_PROVIDER_ADMIN] Error in activateProvider:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to activate provider.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

module.exports = {
    getAllProviders,
    getProviderStats,
    getProviderById,
    suspendProvider,
    activateProvider,
};
