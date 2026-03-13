// ═══════════════════════════════════════════════════════════════════════════════
// backend/src/controllers/backoffice/dashboard.controller.js
// WEGO Backoffice — Main Dashboard Stats & Activity Feed
// ═══════════════════════════════════════════════════════════════════════════════

const { Op, fn, col, literal } = require('sequelize');
const redisClient              = require('../../utils/redis');

// Models
const Account          = require('../../models/Account');
const Trip             = require('../../models/Trip');
const DriverProfile    = require('../../models/DriverProfile');
const ServiceRequest   = require('../../models/ServiceRequest');
const ServiceDispute   = require('../../models/ServiceDispute');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns { start, end } Date objects for the requested range.
 * For 'custom', expects ISO strings in query params from & to.
 */
function getDateRange(range, from, to) {
    const now   = new Date();
    const start = new Date();
    const end   = new Date();

    switch (range) {
        case 'today':
            start.setHours(0, 0, 0, 0);
            end.setHours(23, 59, 59, 999);
            break;

        case 'week': {
            const dayOfWeek = now.getDay() === 0 ? 6 : now.getDay() - 1;
            start.setDate(now.getDate() - dayOfWeek);
            start.setHours(0, 0, 0, 0);
            end.setHours(23, 59, 59, 999);
            break;
        }

        case 'month':
            start.setDate(1);
            start.setHours(0, 0, 0, 0);
            end.setHours(23, 59, 59, 999);
            break;

        case 'custom':
            if (!from || !to) throw new Error('custom range requires from and to params');
            return { start: new Date(from), end: new Date(to) };

        default:
            start.setHours(0, 0, 0, 0);
            end.setHours(23, 59, 59, 999);
    }

    return { start, end };
}

function getPreviousRange(start, end) {
    const duration = end.getTime() - start.getTime();
    return {
        start : new Date(start.getTime() - duration),
        end   : new Date(end.getTime()   - duration),
    };
}

function xaf(amount) {
    return Math.round(amount || 0);
}

function pctChange(current, previous) {
    if (!previous || previous === 0) return null;
    return Math.round(((current - previous) / previous) * 100);
}

// ─── Redis Cache Helper ───────────────────────────────────────────────────────

const CACHE_TTL = 120; // 2 minutes

async function getCached(key) {
    try {
        const val = await redisClient.get(key);
        return val ? JSON.parse(val) : null;
    } catch {
        return null;
    }
}

async function setCache(key, data) {
    try {
        await redisClient.setEx(key, CACHE_TTL, JSON.stringify(data));
    } catch {
        // Non-blocking — if Redis fails we just skip caching
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTROLLER: getDashboardStats
// GET /api/backoffice/dashboard/stats?range=today|week|month|custom&from=&to=
//
// NOTE: Trip model uses underscored: false — all fields are camelCase:
//   passengerId, driverId, fareFinal, fareEstimate, paymentMethod,
//   createdAt, updatedAt, tripCompletedAt, status
// ═══════════════════════════════════════════════════════════════════════════════

exports.getDashboardStats = async (req, res) => {
    try {
        const { range = 'today', from, to } = req.query;

        // ── Redis cache key ──────────────────────────────────────────────
        const cacheKey = `dashboard:stats:${range}:${from || ''}:${to || ''}`;
        const cached   = await getCached(cacheKey);
        if (cached) {
            console.log('✅ Dashboard stats served from cache');
            return res.json({ success: true, data: cached, cached: true });
        }

        // ── Date ranges ──────────────────────────────────────────────────
        const { start, end }         = getDateRange(range, from, to);
        const { start: ps, end: pe } = getPreviousRange(start, end);

        // ── Where clauses — camelCase because underscored: false ─────────
        const currentWhere = { createdAt: { [Op.between]: [start, end] } };

        // ════════════════════════════════════════════════════════════════
        // 1. KPI CARDS — run all queries in parallel
        // ════════════════════════════════════════════════════════════════

        const [
            currentTrips,
            previousTrips,
            currentRevenue,
            previousRevenue,
            activeDriversNow,
            totalDrivers,
            newPassengers,
            previousPassengers,
            totalPassengers,
        ] = await Promise.all([

            // Current period completed trips
            Trip.count({
                where: { ...currentWhere, status: 'COMPLETED' },
            }),

            // Previous period completed trips
            Trip.count({
                where: { createdAt: { [Op.between]: [ps, pe] }, status: 'COMPLETED' },
            }),

            // Current revenue — sum of fareFinal on completed trips
            Trip.sum('fareFinal', {
                where: { ...currentWhere, status: 'COMPLETED' },
            }),

            // Previous revenue
            Trip.sum('fareFinal', {
                where: { createdAt: { [Op.between]: [ps, pe] }, status: 'COMPLETED' },
            }),

            // Drivers currently online — DriverProfile uses status ENUM: offline|online|on_trip|suspended
            DriverProfile.count({
                where: { status: 'online' },
            }),

            // Total registered drivers — Account uses underscored:true → user_type, UPPERCASE enums
            Account.count({
                where: { user_type: 'DRIVER', status: 'ACTIVE' },
            }),

            // New passenger accounts this period
            Account.count({
                where: { created_at: { [Op.between]: [start, end] }, user_type: 'PASSENGER' },
            }),

            // New passengers previous period
            Account.count({
                where: { created_at: { [Op.between]: [ps, pe] }, user_type: 'PASSENGER' },
            }),

            // All passengers total
            Account.count({
                where: { user_type: 'PASSENGER' },
            }),
        ]);

        // Commission is 15% of revenue
        const currentCommission = xaf((currentRevenue || 0) * 0.15);

        const kpis = {
            trips: {
                current  : currentTrips,
                previous : previousTrips,
                change   : pctChange(currentTrips, previousTrips),
            },
            revenue: {
                current    : xaf(currentRevenue),
                previous   : xaf(previousRevenue),
                change     : pctChange(currentRevenue, previousRevenue),
                commission : currentCommission,
            },
            drivers: {
                onlineNow : activeDriversNow,
                total     : totalDrivers,
            },
            passengers: {
                newThisPeriod  : newPassengers,
                previousPeriod : previousPassengers,
                change         : pctChange(newPassengers, previousPassengers),
                total          : totalPassengers,
            },
        };

        // ════════════════════════════════════════════════════════════════
        // 2. REVENUE OVER TIME — one data point per day
        // ════════════════════════════════════════════════════════════════

        const revenueOverTime = await Trip.findAll({
            attributes: [
                [fn('DATE', col('createdAt')), 'date'],
                [fn('SUM', col('fareFinal')),  'revenue'],
                [fn('COUNT', col('id')),       'trips'],
            ],
            where: {
                ...currentWhere,
                status   : 'COMPLETED',
                fareFinal: { [Op.not]: null },
            },
            group : [fn('DATE', col('createdAt'))],
            order : [[fn('DATE', col('createdAt')), 'ASC']],
            raw   : true,
        });

        // ════════════════════════════════════════════════════════════════
        // 3. DAILY TRIPS OVER TIME — bar chart
        //    Trip model ENUM: COMPLETED, CANCELED (single L — not CANCELLED)
        // ════════════════════════════════════════════════════════════════

        const tripsOverTime = await Trip.findAll({
            attributes: [
                [fn('DATE', col('createdAt')), 'date'],
                [fn('COUNT', col('id')),       'total'],
                [fn('SUM', literal(`CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END`)), 'completed'],
                [fn('SUM', literal(`CASE WHEN status = 'CANCELED'  THEN 1 ELSE 0 END`)), 'cancelled'],
            ],
            where : currentWhere,
            group : [fn('DATE', col('createdAt'))],
            order : [[fn('DATE', col('createdAt')), 'ASC']],
            raw   : true,
        });

        // ════════════════════════════════════════════════════════════════
        // 4. PAYMENT METHODS BREAKDOWN — pie chart
        //    Trip model field: paymentMethod (values: CASH, MOMO, OM)
        // ════════════════════════════════════════════════════════════════

        const paymentBreakdown = await Trip.findAll({
            attributes: [
                'paymentMethod',
                [fn('COUNT', col('id')),      'count'],
                [fn('SUM', col('fareFinal')), 'total'],
            ],
            where: {
                ...currentWhere,
                status: 'COMPLETED',
            },
            group : ['paymentMethod'],
            raw   : true,
        });

        // ════════════════════════════════════════════════════════════════
        // 5. TOP 5 DRIVERS BY EARNINGS
        // ════════════════════════════════════════════════════════════════

        const topDrivers = await Trip.findAll({
            attributes: [
                'driverId',
                [fn('SUM', col('fareFinal')), 'totalEarnings'],
                [fn('COUNT', col('id')),      'totalTrips'],
            ],
            where: {
                ...currentWhere,
                status   : 'COMPLETED',
                driverId : { [Op.not]: null },
            },
            group : ['driverId'],
            order : [[fn('SUM', col('fareFinal')), 'DESC']],
            limit : 5,
            raw   : true,
        });

        // Enrich top drivers with name + photo
        const driverIds      = topDrivers.map(d => d.driverId);
        const driverAccounts = driverIds.length > 0
            ? await Account.findAll({
                where      : { uuid: { [Op.in]: driverIds } },
                attributes : ['uuid', 'first_name', 'last_name', 'avatar_url'],
                raw        : true,
            })
            : [];

        const driverMap = {};
        driverAccounts.forEach(a => { driverMap[a.uuid] = a; });

        const topDriversEnriched = topDrivers.map(d => ({
            driverId      : d.driverId,
            name          : driverMap[d.driverId]
                ? `${driverMap[d.driverId].first_name} ${driverMap[d.driverId].last_name}`
                : 'Unknown Driver',
            photo         : driverMap[d.driverId]?.avatar_url || null,
            totalEarnings : xaf(d.totalEarnings),
            totalTrips    : parseInt(d.totalTrips),
        }));

        // ════════════════════════════════════════════════════════════════
        // BUILD RESPONSE
        // ════════════════════════════════════════════════════════════════

        const data = {
            range,
            period: {
                start : start.toISOString(),
                end   : end.toISOString(),
            },
            kpis,
            charts: {
                revenueOverTime: revenueOverTime.map(r => ({
                    date    : r.date,
                    revenue : xaf(r.revenue),
                    trips   : parseInt(r.trips),
                })),
                tripsOverTime: tripsOverTime.map(t => ({
                    date      : t.date,
                    total     : parseInt(t.total),
                    completed : parseInt(t.completed),
                    cancelled : parseInt(t.cancelled),
                })),
                paymentBreakdown: paymentBreakdown.map(p => ({
                    method : p.paymentMethod,
                    count  : parseInt(p.count),
                    total  : xaf(p.total),
                })),
                topDrivers: topDriversEnriched,
            },
        };

        // Cache it
        await setCache(cacheKey, data);

        console.log(`✅ Dashboard stats fetched for range: ${range}`);
        return res.json({ success: true, data, cached: false });

    } catch (err) {
        console.error('❌ Dashboard stats error:', err);
        return res.status(500).json({
            success : false,
            message : 'Failed to load dashboard statistics',
            code    : 'DASHBOARD_STATS_ERROR',
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// CONTROLLER: getActivityFeed
// GET /api/backoffice/dashboard/activity-feed
// Returns last 15 events — NOT cached (always live)
// ═══════════════════════════════════════════════════════════════════════════════

exports.getActivityFeed = async (req, res) => {
    try {

        const [
            recentTrips,
            recentSignups,
            recentDisputes,
            recentServiceRequests,
        ] = await Promise.all([

            // Last 5 completed trips — raw query, no include (avoid FK join issues)
            Trip.findAll({
                where      : { status: 'COMPLETED' },
                order      : [['updatedAt', 'DESC']],
                limit      : 5,
                attributes : ['id', 'passengerId', 'driverId', 'fareFinal', 'pickupAddress', 'dropoffAddress', 'updatedAt'],
                raw        : true,
            }),

            // Last 5 new account signups — Account: underscored:true → created_at, user_type
            Account.findAll({
                order      : [['created_at', 'DESC']],
                limit      : 5,
                attributes : ['uuid', 'first_name', 'last_name', 'user_type', 'created_at'],
                raw        : true,
            }),

            // Last 3 open disputes — only guaranteed columns
            ServiceDispute.findAll({
                where      : { status: 'open' },
                order      : [['createdAt', 'DESC']],
                limit      : 3,
                attributes : ['id', 'status', 'createdAt'],
                raw        : true,
            }),

            // Last 3 pending service requests — only guaranteed columns
            ServiceRequest.findAll({
                where      : { status: 'pending' },
                order      : [['createdAt', 'DESC']],
                limit      : 3,
                attributes : ['id', 'status', 'createdAt'],
                raw        : true,
            }),

        ]);

        // ── Normalize into a unified feed ────────────────────────────────
        const feed = [];

        recentTrips.forEach(t => {
            feed.push({
                type      : 'trip_completed',
                id        : t.id,
                icon      : '🚗',
                title     : 'Trip completed',
                subtitle  : `Fare: ${xaf(t.fareFinal).toLocaleString()} XAF`,
                meta      : t.dropoffAddress || 'No destination info',
                timestamp : t.updatedAt,
            });
        });

        recentSignups.forEach(a => {
            const typeLabel = {
                PASSENGER : '🧍 New passenger',
                DRIVER    : '🚕 New driver',
                PARTNER   : '🤝 New partner',
                ADMIN     : '👔 New employee',
            }[a.user_type] || '👤 New user';

            feed.push({
                type      : 'new_signup',
                id        : a.uuid,
                icon      : typeLabel.split(' ')[0],
                title     : typeLabel.replace(/^\S+\s/, ''),
                subtitle  : `${a.first_name} ${a.last_name}`,
                meta      : a.user_type,
                timestamp : a.created_at,
            });
        });

        recentDisputes.forEach(d => {
            feed.push({
                type      : 'dispute_opened',
                id        : d.id,
                icon      : '⚠️',
                title     : 'New dispute',
                subtitle  : 'Service dispute filed',
                meta      : 'Awaiting review',
                timestamp : d.createdAt,
            });
        });

        recentServiceRequests.forEach(r => {
            feed.push({
                type      : 'service_request',
                id        : r.id,
                icon      : '🔧',
                title     : 'Service request',
                subtitle  : `Request #${String(r.id).slice(0, 8).toUpperCase()}`,
                meta      : 'Pending',
                timestamp : r.createdAt,
            });
        });

        // Sort all events by timestamp descending, return top 15
        feed.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        const trimmed = feed.slice(0, 15);

        console.log(`✅ Activity feed returned ${trimmed.length} events`);
        return res.json({ success: true, data: trimmed });

    } catch (err) {
        console.error('❌ Activity feed error:', err);
        return res.status(500).json({
            success : false,
            message : 'Failed to load activity feed',
            code    : 'ACTIVITY_FEED_ERROR',
        });
    }
};