// backend/src/controllers/serviceAdmin.controller.js
// Service Admin Dashboard Controller - Overview Statistics & Metrics

const {
    ServiceListing,
    ServiceRequest,
    ServiceCategory,
    ServiceRating,
    ServiceDispute,
    Account,
    Employee
} = require('../../models');
const { Op } = require('sequelize');
const sequelize = require('sequelize');

// ═══════════════════════════════════════════════════════════════════════
// GET DASHBOARD STATISTICS (Admin - Overview metrics)
// GET /api/services/admin/dashboard/stats
// ═══════════════════════════════════════════════════════════════════════

exports.getDashboardStats = async (req, res) => {
    try {
        console.log('📊 [SERVICE_ADMIN] Fetching dashboard statistics...');

        // ─────────────────────────────────────────────────────────────────
        // TODAY'S DATE RANGE
        // ─────────────────────────────────────────────────────────────────
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        // ─────────────────────────────────────────────────────────────────
        // LISTINGS STATS
        // ─────────────────────────────────────────────────────────────────
        const pendingListings = await ServiceListing.count({
            where: { status: 'pending' }
        });

        const approvedToday = await ServiceListing.count({
            where: {
                status: ['approved', 'active'],
                approved_at: { [Op.gte]: today }
            }
        });

        const activeServices = await ServiceListing.count({
            where: { status: 'active' }
        });

        const totalListings = await ServiceListing.count();

        // ─────────────────────────────────────────────────────────────────
        // PROVIDERS STATS
        // ─────────────────────────────────────────────────────────────────

        // Get all unique providers who have at least one listing
        const allProviders = await ServiceListing.findAll({
            attributes: [
                [sequelize.fn('DISTINCT', sequelize.col('provider_id')), 'provider_id']
            ],
            raw: true
        });
        const totalProviders = allProviders.length;

        // Active providers (have at least one active listing)
        const activeProviders = await ServiceListing.findAll({
            where: { status: 'active' },
            attributes: [
                [sequelize.fn('DISTINCT', sequelize.col('provider_id')), 'provider_id']
            ],
            raw: true
        });
        const activeProvidersCount = activeProviders.length;

        // Verified providers (providers who are verified accounts)
        const verifiedProviders = await Account.count({
            where: {
                uuid: { [Op.in]: allProviders.map(p => p.provider_id) },
                is_verified: true
            }
        });

        // Suspended providers
        const suspendedProviders = await Account.count({
            where: {
                uuid: { [Op.in]: allProviders.map(p => p.provider_id) },
                account_status: 'suspended'
            }
        });

        // Average rating across all listings
        const avgRatingResult = await ServiceListing.findOne({
            attributes: [
                [sequelize.fn('AVG', sequelize.col('average_rating')), 'avg_rating']
            ],
            where: {
                status: 'active',
                average_rating: { [Op.gt]: 0 }
            },
            raw: true
        });
        const averageRating = avgRatingResult?.avg_rating
            ? parseFloat(avgRatingResult.avg_rating).toFixed(2)
            : 0;

        // ─────────────────────────────────────────────────────────────────
        // FINANCIAL STATS (Commission)
        // ─────────────────────────────────────────────────────────────────

        // Total commission from all completed services
        const totalCommissionResult = await ServiceRequest.findOne({
            attributes: [
                [sequelize.fn('SUM', sequelize.col('commission_amount')), 'total']
            ],
            where: {
                status: ['completed', 'payment_confirmed'],
                commission_amount: { [Op.gt]: 0 }
            },
            raw: true
        });
        const totalCommissionDue = totalCommissionResult?.total || 0;

        // Commission earned today
        const todayCommissionResult = await ServiceRequest.findOne({
            attributes: [
                [sequelize.fn('SUM', sequelize.col('commission_amount')), 'total']
            ],
            where: {
                status: ['completed', 'payment_confirmed'],
                payment_confirmed_at: { [Op.gte]: today },
                commission_amount: { [Op.gt]: 0 }
            },
            raw: true
        });
        const commissionToday = todayCommissionResult?.total || 0;

        // Total revenue (all completed services)
        const totalRevenueResult = await ServiceRequest.findOne({
            attributes: [
                [sequelize.fn('SUM', sequelize.col('final_amount')), 'total']
            ],
            where: {
                status: ['completed', 'payment_confirmed'],
                final_amount: { [Op.gt]: 0 }
            },
            raw: true
        });
        const totalRevenue = totalRevenueResult?.total || 0;

        // Revenue today
        const todayRevenueResult = await ServiceRequest.findOne({
            attributes: [
                [sequelize.fn('SUM', sequelize.col('final_amount')), 'total']
            ],
            where: {
                status: ['completed', 'payment_confirmed'],
                payment_confirmed_at: { [Op.gte]: today },
                final_amount: { [Op.gt]: 0 }
            },
            raw: true
        });
        const revenueToday = todayRevenueResult?.total || 0;

        // ─────────────────────────────────────────────────────────────────
        // SERVICE REQUESTS STATS
        // ─────────────────────────────────────────────────────────────────

        const totalRequests = await ServiceRequest.count();

        const pendingRequests = await ServiceRequest.count({
            where: { status: 'pending' }
        });

        const acceptedRequests = await ServiceRequest.count({
            where: { status: 'accepted' }
        });

        const inProgressRequests = await ServiceRequest.count({
            where: { status: 'in_progress' }
        });

        const paymentPendingRequests = await ServiceRequest.count({
            where: { status: 'payment_pending' }
        });

        const completedToday = await ServiceRequest.count({
            where: {
                status: ['completed', 'payment_confirmed'],
                completed_at: { [Op.gte]: today }
            }
        });

        const totalCompleted = await ServiceRequest.count({
            where: { status: ['completed', 'payment_confirmed'] }
        });

        const totalActive = pendingRequests + acceptedRequests + inProgressRequests + paymentPendingRequests;

        // ─────────────────────────────────────────────────────────────────
        // DISPUTES STATS
        // ─────────────────────────────────────────────────────────────────

        const openDisputes = await ServiceDispute.count({
            where: { status: 'open' }
        });

        const investigatingDisputes = await ServiceDispute.count({
            where: { status: 'investigating' }
        });

        const totalDisputes = await ServiceDispute.count();

        const criticalDisputes = await ServiceDispute.count({
            where: {
                priority: 'critical',
                status: { [Op.in]: ['open', 'investigating', 'awaiting_response', 'escalated'] }
            }
        });

        // ─────────────────────────────────────────────────────────────────
        // ALERTS (Items needing attention)
        // ─────────────────────────────────────────────────────────────────

        // Listings pending more than 24 hours
        const urgentListingsCount = await ServiceListing.count({
            where: {
                status: 'pending',
                created_at: {
                    [Op.lt]: new Date(Date.now() - 24 * 60 * 60 * 1000)
                }
            }
        });

        // Payment disputes needing review
        const paymentDisputesCount = await ServiceDispute.count({
            where: {
                dispute_type: 'payment_issue',
                status: { [Op.in]: ['open', 'investigating'] }
            }
        });

        // Flagged reviews
        const flaggedReviewsCount = await ServiceRating.count({
            where: { is_flagged: true }
        });

        // ─────────────────────────────────────────────────────────────────
        // RECENT ACTIVITY (Last 5 activities)
        // ─────────────────────────────────────────────────────────────────

        const recentListings = await ServiceListing.findAll({
            where: { status: 'pending' },
            order: [['created_at', 'DESC']],
            limit: 3,
            include: [
                {
                    model: Account,
                    as: 'provider',
                    attributes: ['uuid', 'first_name', 'last_name']
                },
                {
                    model: ServiceCategory,
                    as: 'category',
                    attributes: ['id', 'name_en']
                }
            ]
        });

        const recentActivity = recentListings.map(listing => ({
            type: 'new_listing',
            id: listing.listing_id,
            title: listing.title,
            provider: `${listing.provider.first_name} ${listing.provider.last_name}`,
            category: listing.category.name_en,
            timestamp: listing.created_at,
            time_ago: getTimeAgo(listing.created_at)
        }));

        // ─────────────────────────────────────────────────────────────────
        // PROVIDER OVERVIEW
        // ─────────────────────────────────────────────────────────────────

        const providerOverview = {
            total_providers: totalProviders,
            active_providers: activeProvidersCount,
            verified_providers: verifiedProviders,
            suspended_providers: suspendedProviders,
            average_rating: parseFloat(averageRating),
            providers_with_earnings: await ServiceRequest.count({
                where: {
                    status: ['completed', 'payment_confirmed'],
                    provider_net_amount: { [Op.gt]: 0 }
                },
                distinct: true,
                col: 'provider_id'
            })
        };

        // ─────────────────────────────────────────────────────────────────
        // RETURN COMPLETE STATS
        // ─────────────────────────────────────────────────────────────────

        console.log('✅ [SERVICE_ADMIN] Dashboard statistics retrieved successfully');

        res.status(200).json({
            success: true,
            message: 'Dashboard statistics retrieved successfully',
            data: {
                // Today's metrics
                today_metrics: {
                    pending_listings: pendingListings,
                    approved_today: approvedToday,
                    completed_today: completedToday,
                    revenue_today: revenueToday,
                    commission_today: commissionToday,
                },

                // Listings overview
                listings: {
                    total: totalListings,
                    pending: pendingListings,
                    approved: approvedToday,
                    active: activeServices,
                },

                // Service requests overview
                requests: {
                    total: totalRequests,
                    pending: pendingRequests,
                    accepted: acceptedRequests,
                    in_progress: inProgressRequests,
                    payment_pending: paymentPendingRequests,
                    completed_today: completedToday,
                    total_completed: totalCompleted,
                    total_active: totalActive,
                },

                // Financial overview
                financial: {
                    total_revenue: totalRevenue,
                    revenue_today: revenueToday,
                    total_commission: totalCommissionDue,
                    commission_today: commissionToday,
                },

                // Providers overview
                providers: providerOverview,

                // Disputes overview
                disputes: {
                    total: totalDisputes,
                    open: openDisputes,
                    investigating: investigatingDisputes,
                    critical: criticalDisputes,
                },

                // Alerts (items needing attention)
                alerts: {
                    urgent_listings: urgentListingsCount,
                    payment_disputes: paymentDisputesCount,
                    flagged_reviews: flaggedReviewsCount,
                },

                // Recent activity
                recent_activity: recentActivity,
            }
        });

    } catch (error) {
        console.error('❌ [SERVICE_ADMIN] Error in getDashboardStats:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve dashboard statistics. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// HELPER FUNCTION: GET TIME AGO
// ═══════════════════════════════════════════════════════════════════════

function getTimeAgo(date) {
    const now = new Date();
    const diffMs = now - new Date(date);
    const diffMinutes = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMinutes < 1) return 'just now';
    if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes > 1 ? 's' : ''} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
}

// ═══════════════════════════════════════════════════════════════════════
// GET QUICK STATS (Lightweight version for frequent polling)
// GET /api/services/admin/dashboard/quick-stats
// ═══════════════════════════════════════════════════════════════════════

exports.getQuickStats = async (req, res) => {
    try {
        const pendingListings = await ServiceListing.count({
            where: { status: 'pending' }
        });

        const activeServices = await ServiceListing.count({
            where: { status: 'active' }
        });

        const openDisputes = await ServiceDispute.count({
            where: { status: 'open' }
        });

        const inProgressRequests = await ServiceRequest.count({
            where: { status: 'in_progress' }
        });

        res.status(200).json({
            success: true,
            data: {
                pending_listings: pendingListings,
                active_services: activeServices,
                open_disputes: openDisputes,
                in_progress_requests: inProgressRequests,
            }
        });

    } catch (error) {
        console.error('❌ [SERVICE_ADMIN] Error in getQuickStats:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve quick stats.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

module.exports = exports;