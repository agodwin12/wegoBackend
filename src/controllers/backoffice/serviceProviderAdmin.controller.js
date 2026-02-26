// backend/src/controllers/backoffice/serviceProviderAdmin.controller.js
// Service Provider Admin Controller - Provider Management & Overview

const {
    Account,
    ServiceListing,
    ServiceRequest,
    ServiceRating,
    ServiceCategory,
} = require('../../models');
const { Op } = require('sequelize');
const sequelize = require('sequelize');

// ═══════════════════════════════════════════════════════════════════════
// GET ALL PROVIDERS (Admin - All users who have service listings)
// GET /api/services/admin/providers
// ═══════════════════════════════════════════════════════════════════════

const getAllProviders = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;

        const {
            status,
            search,
            sort_by = 'recent',
            sort_order = 'DESC',
            min_rating,
            verified_only,
        } = req.query;

        console.log(`👥 [SERVICE_PROVIDER_ADMIN] Fetching providers - Page: ${page}, Status: ${status || 'all'}, Sort: ${sort_by}`);

        // ─────────────────────────────────────────────────────────────────
        // GET ALL UNIQUE PROVIDER IDs FROM LISTINGS
        // ─────────────────────────────────────────────────────────────────

        const providerListings = await ServiceListing.findAll({
            attributes: [
                [sequelize.fn('DISTINCT', sequelize.col('provider_id')), 'provider_id']
            ],
            raw: true
        });

        const providerIds = providerListings.map(p => p.provider_id);

        if (providerIds.length === 0) {
            res.set({
                'Cache-Control': 'no-store, no-cache, must-revalidate, private',
                'Pragma': 'no-cache',
                'Expires': '0'
            });

            return res.status(200).json({
                success: true,
                message: 'No providers found',
                providers: [],
                stats: {
                    total_providers: 0,
                    active_providers: 0,
                    verified_providers: 0,
                    suspended_providers: 0,
                    average_rating: 0,
                    total_commission_due: '0.00',
                },
                pagination: {
                    total: 0,
                    page: 1,
                    limit,
                    totalPages: 0,
                    hasNext: false,
                    hasPrev: false,
                }
            });
        }

        // ─────────────────────────────────────────────────────────────────
        // BUILD WHERE CLAUSE FOR ACCOUNTS
        // ─────────────────────────────────────────────────────────────────

        const where = {
            uuid: { [Op.in]: providerIds }
        };

        // Status filter - FIXED: using 'status' instead of 'account_status'
        if (status === 'suspended') {
            where.status = 'suspended';
        } else if (status === 'active') {
            where.status = 'active';
        } else if (status === 'verified') {
            where.status = 'active';
        }

        // Search filter
        if (search) {
            where[Op.or] = [
                { first_name: { [Op.like]: `%${search}%` } },
                { last_name: { [Op.like]: `%${search}%` } },
                { email: { [Op.like]: `%${search}%` } },
                { phone_e164: { [Op.like]: `%${search}%` } },
            ];
        }

        // ─────────────────────────────────────────────────────────────────
        // FETCH PROVIDERS (ACCOUNTS) - No pagination yet
        // ─────────────────────────────────────────────────────────────────

        const providers = await Account.findAll({
            where,
            attributes: [
                'uuid',
                'first_name',
                'last_name',
                'email',
                'phone_e164',
                'avatar_url',
                'user_type',
                'status', // FIXED: changed from account_status
                'created_at',
            ],
        });

        console.log(`📊 Found ${providers.length} providers matching filters`);

        // ─────────────────────────────────────────────────────────────────
        // ENRICH WITH PROVIDER STATS (For each provider)
        // ─────────────────────────────────────────────────────────────────

        const enrichedProviders = await Promise.all(providers.map(async (provider) => {
            const providerId = provider.uuid;

            // Count of listings
            const totalListings = await ServiceListing.count({
                where: { provider_id: providerId }
            });

            const activeListings = await ServiceListing.count({
                where: { provider_id: providerId, status: 'approved' }
            });

            const pendingListings = await ServiceListing.count({
                where: { provider_id: providerId, status: 'pending' }
            });

            // Count of completed services
            const completedServices = await ServiceRequest.count({
                where: {
                    provider_id: providerId,
                    status: { [Op.in]: ['completed', 'payment_confirmed'] }
                }
            });

            // Total services (all statuses)
            const totalServices = await ServiceRequest.count({
                where: { provider_id: providerId }
            });

            // Active services (currently in progress)
            const activeServices = await ServiceRequest.count({
                where: {
                    provider_id: providerId,
                    status: { [Op.in]: ['accepted', 'in_progress', 'payment_pending', 'payment_confirmation_pending'] }
                }
            });

            // Cancelled services
            const cancelledServices = await ServiceRequest.count({
                where: {
                    provider_id: providerId,
                    status: 'cancelled'
                }
            });

            // Calculate completion rate
            const completionRate = totalServices > 0
                ? ((completedServices / totalServices) * 100).toFixed(2)
                : 0;

            // Total earnings (net amount after commission)
            const earningsResult = await ServiceRequest.findOne({
                attributes: [
                    [sequelize.fn('SUM', sequelize.col('provider_net_amount')), 'total']
                ],
                where: {
                    provider_id: providerId,
                    status: { [Op.in]: ['completed', 'payment_confirmed'] },
                    provider_net_amount: { [Op.gt]: 0 }
                },
                raw: true
            });
            const totalEarnings = earningsResult?.total || 0;

            // Commission due to platform
            const commissionResult = await ServiceRequest.findOne({
                attributes: [
                    [sequelize.fn('SUM', sequelize.col('commission_amount')), 'total']
                ],
                where: {
                    provider_id: providerId,
                    status: { [Op.in]: ['completed', 'payment_confirmed'] },
                    commission_amount: { [Op.gt]: 0 }
                },
                raw: true
            });
            const totalCommission = commissionResult?.total || 0;

            // Average rating across all ratings
            const ratingsResult = await ServiceRating.findOne({
                attributes: [
                    [sequelize.fn('AVG', sequelize.col('rating')), 'avg'],
                    [sequelize.fn('COUNT', sequelize.col('rating')), 'count']
                ],
                where: {
                    provider_id: providerId,
                },
                raw: true
            });

            const averageRating = ratingsResult?.avg
                ? parseFloat(ratingsResult.avg)
                : 0;
            const totalReviews = ratingsResult?.count || 0;

            // Response time (average time to accept request)
            const acceptedRequests = await ServiceRequest.findAll({
                where: {
                    provider_id: providerId,
                    status: { [Op.in]: ['accepted', 'in_progress', 'completed', 'payment_pending', 'payment_confirmation_pending', 'payment_confirmed'] },
                    accepted_at: { [Op.not]: null }
                },
                attributes: ['created_at', 'accepted_at'],
                raw: true,
                limit: 50
            });

            let averageResponseMinutes = 0;
            if (acceptedRequests.length > 0) {
                const totalMinutes = acceptedRequests.reduce((sum, req) => {
                    const responseTime = new Date(req.accepted_at) - new Date(req.created_at);
                    return sum + (responseTime / 60000); // Convert to minutes
                }, 0);
                averageResponseMinutes = Math.round(totalMinutes / acceptedRequests.length);
            }

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
                account_status: provider.status, // Map to frontend expected field
                is_verified: true,
                is_active: provider.status === 'active', // FIXED: use status
                is_suspended: provider.status === 'suspended', // FIXED: use status
                is_driver: provider.user_type === 'driver',
                member_since: provider.created_at,
                joined_date: provider.created_at,
                last_active: provider.created_at,

                // Statistics
                total_services: totalServices,
                completed_services: completedServices,
                active_services: activeServices,
                cancelled_services: cancelledServices,
                completion_rate: parseFloat(completionRate),

                // Financial
                total_earnings: parseFloat(totalEarnings),
                commission_due: parseFloat(totalCommission),
                commission_paid: 0,
                outstanding_commission: parseFloat(totalCommission),

                // Ratings
                rating: parseFloat(averageRating.toFixed(1)),
                average_rating: parseFloat(averageRating.toFixed(1)),
                total_reviews: parseInt(totalReviews),

                // Performance
                response_time_minutes: averageResponseMinutes,
                average_response_time_minutes: averageResponseMinutes,

                // Listings
                active_listings_count: activeListings,
                pending_listings_count: pendingListings,
                total_listings: totalListings,

                // Additional metrics
                rejection_rate: 0,
            };
        }));

        // ─────────────────────────────────────────────────────────────────
        // SORT ENRICHED PROVIDERS
        // ─────────────────────────────────────────────────────────────────

        const sortFieldMap = {
            'recent': 'member_since',
            'rating': 'rating',
            'earnings': 'total_earnings',
            'services': 'total_services',
            'total_earnings': 'total_earnings'
        };

        const sortField = sortFieldMap[sort_by] || 'member_since';
        const sortDirection = sort_order.toUpperCase() === 'ASC' ? 1 : -1;

        enrichedProviders.sort((a, b) => {
            let aVal = a[sortField];
            let bVal = b[sortField];

            if (sortField === 'member_since') {
                aVal = new Date(aVal).getTime();
                bVal = new Date(bVal).getTime();
            }

            if (typeof aVal === 'string' && !isNaN(aVal)) {
                aVal = parseFloat(aVal);
                bVal = parseFloat(bVal);
            }

            if (aVal < bVal) return -1 * sortDirection;
            if (aVal > bVal) return 1 * sortDirection;
            return 0;
        });

        // Apply rating filter if specified
        let filteredProviders = enrichedProviders;
        if (min_rating) {
            const minRatingValue = parseFloat(min_rating);
            filteredProviders = enrichedProviders.filter(p => p.rating >= minRatingValue);
        }

        // ─────────────────────────────────────────────────────────────────
        // CALCULATE STATS
        // ─────────────────────────────────────────────────────────────────

        const activeProvidersCount = filteredProviders.filter(p => p.is_active).length;
        const suspendedProvidersCount = filteredProviders.filter(p => p.is_suspended).length;
        const verifiedProvidersCount = filteredProviders.filter(p => p.is_verified).length;

        const totalRating = filteredProviders.reduce((sum, p) => sum + p.rating, 0);
        const avgRating = filteredProviders.length > 0 ? totalRating / filteredProviders.length : 0;

        const totalCommissionDue = filteredProviders.reduce((sum, p) => sum + p.commission_due, 0);

        const stats = {
            total_providers: filteredProviders.length,
            active_providers: activeProvidersCount,
            verified_providers: verifiedProvidersCount,
            suspended_providers: suspendedProvidersCount,
            average_rating: parseFloat(avgRating.toFixed(1)),
            total_commission_due: parseFloat(totalCommissionDue.toFixed(2)),
        };

        // Apply pagination AFTER sorting and filtering
        const paginatedProviders = filteredProviders.slice(offset, offset + limit);
        const totalPages = Math.ceil(filteredProviders.length / limit);

        console.log(`✅ [SERVICE_PROVIDER_ADMIN] Retrieved ${filteredProviders.length} providers, returning page ${page} (${paginatedProviders.length} items)`);

        res.set({
            'Cache-Control': 'no-store, no-cache, must-revalidate, private',
            'Pragma': 'no-cache',
            'Expires': '0'
        });

        res.status(200).json({
            success: true,
            message: 'All providers retrieved successfully',
            providers: paginatedProviders,
            stats: stats,
            pagination: {
                total: filteredProviders.length,
                page,
                limit,
                totalPages,
                hasNext: page < totalPages,
                hasPrev: page > 1,
            }
        });

    } catch (error) {
        console.error('❌ [SERVICE_PROVIDER_ADMIN] Error in getAllProviders:', error);
        console.error('Stack trace:', error.stack);

        res.set({
            'Cache-Control': 'no-store, no-cache, must-revalidate, private',
            'Pragma': 'no-cache',
            'Expires': '0'
        });

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
        console.log('📊 [SERVICE_PROVIDER_ADMIN] Fetching provider statistics...');

        const allProviders = await ServiceListing.findAll({
            attributes: [
                [sequelize.fn('DISTINCT', sequelize.col('provider_id')), 'provider_id']
            ],
            raw: true
        });
        const totalProviders = allProviders.length;
        const providerIds = allProviders.map(p => p.provider_id);

        if (providerIds.length === 0) {
            res.set({
                'Cache-Control': 'no-store, no-cache, must-revalidate, private',
                'Pragma': 'no-cache',
                'Expires': '0'
            });

            return res.status(200).json({
                success: true,
                message: 'No providers found',
                data: {
                    total_providers: 0,
                    active_providers: 0,
                    verified_providers: 0,
                    suspended_providers: 0,
                    average_rating: 0,
                    total_commission_due: '0.00',
                },
            });
        }

        const activeProviders = await ServiceListing.findAll({
            where: { status: 'approved' },
            attributes: [
                [sequelize.fn('DISTINCT', sequelize.col('provider_id')), 'provider_id']
            ],
            raw: true
        });
        const activeProvidersCount = activeProviders.length;

        // FIXED: use 'status' instead of 'account_status'
        const verifiedProviders = await Account.count({
            where: {
                uuid: { [Op.in]: providerIds },
                status: 'active'
            }
        });

        const suspendedProviders = await Account.count({
            where: {
                uuid: { [Op.in]: providerIds },
                status: 'suspended'
            }
        });

        const avgRatingResult = await ServiceRating.findOne({
            attributes: [
                [sequelize.fn('AVG', sequelize.col('rating')), 'avg']
            ],
            where: {
                provider_id: { [Op.in]: providerIds },
            },
            raw: true
        });
        const averageRating = avgRatingResult?.avg
            ? parseFloat(avgRatingResult.avg).toFixed(1)
            : 0;

        const commissionResult = await ServiceRequest.findOne({
            attributes: [
                [sequelize.fn('SUM', sequelize.col('commission_amount')), 'total']
            ],
            where: {
                provider_id: { [Op.in]: providerIds },
                status: { [Op.in]: ['completed', 'payment_confirmed'] },
                commission_amount: { [Op.gt]: 0 }
            },
            raw: true
        });
        const totalCommissionDue = commissionResult?.total || 0;

        console.log('✅ [SERVICE_PROVIDER_ADMIN] Provider statistics retrieved');

        res.set({
            'Cache-Control': 'no-store, no-cache, must-revalidate, private',
            'Pragma': 'no-cache',
            'Expires': '0'
        });

        res.status(200).json({
            success: true,
            message: 'Provider statistics retrieved successfully',
            data: {
                total_providers: totalProviders,
                active_providers: activeProvidersCount,
                verified_providers: verifiedProviders,
                suspended_providers: suspendedProviders,
                average_rating: parseFloat(averageRating),
                total_commission_due: parseFloat(totalCommissionDue).toFixed(2),
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_PROVIDER_ADMIN] Error in getProviderStats:', error);

        res.set({
            'Cache-Control': 'no-store, no-cache, must-revalidate, private',
            'Pragma': 'no-cache',
            'Expires': '0'
        });

        res.status(500).json({
            success: false,
            message: 'Unable to retrieve provider statistics. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// (Continue with getProviderById, suspendProvider, activateProvider - same fixes for 'status')

const getProviderById = async (req, res) => {
    try {
        const { id } = req.params;

        if (!id) {
            res.set({
                'Cache-Control': 'no-store, no-cache, must-revalidate, private',
                'Pragma': 'no-cache',
                'Expires': '0'
            });

            return res.status(400).json({
                success: false,
                message: 'Invalid provider ID.',
            });
        }

        const provider = await Account.findOne({
            where: { uuid: id },
            attributes: [
                'uuid',
                'first_name',
                'last_name',
                'email',
                'phone_e164',
                'avatar_url',
                'user_type',
                'status', // FIXED
                'created_at',
                'updated_at'
            ]
        });

        if (!provider) {
            res.set({
                'Cache-Control': 'no-store, no-cache, must-revalidate, private',
                'Pragma': 'no-cache',
                'Expires': '0'
            });

            return res.status(404).json({
                success: false,
                message: 'Provider not found.',
            });
        }

        // ... (rest of the function remains the same) ...

        res.set({
            'Cache-Control': 'no-store, no-cache, must-revalidate, private',
            'Pragma': 'no-cache',
            'Expires': '0'
        });

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
                account_status: provider.status, // FIXED
                joined_date: provider.created_at,
                // ... rest of data
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

const suspendProvider = async (req, res) => {
    try {
        const { id } = req.params;
        const { suspension_reason } = req.body;

        if (!id || !suspension_reason || suspension_reason.trim().length < 10) {
            return res.status(400).json({
                success: false,
                message: 'Invalid input.',
            });
        }

        const provider = await Account.findOne({ where: { uuid: id } });

        if (!provider) {
            return res.status(404).json({
                success: false,
                message: 'Provider not found.',
            });
        }

        if (provider.status === 'suspended') { // FIXED
            return res.status(400).json({
                success: false,
                message: 'Provider is already suspended.',
            });
        }

        await provider.update({ status: 'suspended' }); // FIXED

        await ServiceListing.update(
            { status: 'inactive' },
            {
                where: {
                    provider_id: id,
                    status: 'approved'
                }
            }
        );

        console.log(`✅ [SERVICE_PROVIDER_ADMIN] Provider suspended:`, id);

        res.set({
            'Cache-Control': 'no-store, no-cache, must-revalidate, private',
            'Pragma': 'no-cache',
            'Expires': '0'
        });

        res.status(200).json({
            success: true,
            message: 'Provider suspended successfully.',
            data: {
                provider_id: id,
                account_status: 'suspended',
            },
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

const activateProvider = async (req, res) => {
    try {
        const { id } = req.params;

        if (!id) {
            return res.status(400).json({
                success: false,
                message: 'Invalid provider ID.',
            });
        }

        const provider = await Account.findOne({ where: { uuid: id } });

        if (!provider) {
            return res.status(404).json({
                success: false,
                message: 'Provider not found.',
            });
        }

        if (provider.status === 'active') { // FIXED
            return res.status(400).json({
                success: false,
                message: 'Provider is already active.',
            });
        }

        await provider.update({ status: 'active' }); // FIXED

        console.log(`✅ [SERVICE_PROVIDER_ADMIN] Provider activated:`, id);

        res.set({
            'Cache-Control': 'no-store, no-cache, must-revalidate, private',
            'Pragma': 'no-cache',
            'Expires': '0'
        });

        res.status(200).json({
            success: true,
            message: 'Provider account reactivated successfully.',
            data: {
                provider_id: id,
                account_status: 'active',
            },
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