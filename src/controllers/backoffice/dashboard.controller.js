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
const ServiceListing   = require('../../models/ServiceListing');
const ServiceAdPayment = require('../../models/ServiceAdPayment');
const { WegoPayment }  = require('../../models');

// CamPay verticals that represent platform SALES (revenue) — excludes wallet
// top-ups (fleet_topup / delivery_topup), which are deposits, not revenue.
const REVENUE_VERTICALS = ['delivery', 'listing_fee', 'rental'];

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

        // Platform SALES revenue collected via CamPay (services + rentals +
        // delivery) — added to ride fares so "revenue" reflects the whole platform.
        const [wpRevCurrent, wpRevPrevious] = await Promise.all([
            WegoPayment.sum('amount', { where: { createdAt: { [Op.between]: [start, end] }, status: 'SUCCESSFUL', vertical: { [Op.in]: REVENUE_VERTICALS } } }),
            WegoPayment.sum('amount', { where: { createdAt: { [Op.between]: [ps, pe] },     status: 'SUCCESSFUL', vertical: { [Op.in]: REVENUE_VERTICALS } } }),
        ]);
        const totalRevenue     = (currentRevenue  || 0) + (wpRevCurrent  || 0);
        const totalPrevRevenue = (previousRevenue || 0) + (wpRevPrevious || 0);

        // Commission is 15% of revenue
        const currentCommission = xaf(totalRevenue * 0.15);

        const kpis = {
            trips: {
                current  : currentTrips,
                previous : previousTrips,
                change   : pctChange(currentTrips, previousTrips),
            },
            revenue: {
                current    : xaf(totalRevenue),
                previous   : xaf(totalPrevRevenue),
                change     : pctChange(totalRevenue, totalPrevRevenue),
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

        // Merge in CamPay sales revenue per day (services + rentals + delivery)
        // so the line reflects the whole platform, not just ride fares.
        const wpRevByDay = await WegoPayment.findAll({
            attributes: [
                [fn('DATE', col('createdAt')), 'date'],
                [fn('SUM', col('amount')),     'revenue'],
            ],
            where: { createdAt: { [Op.between]: [start, end] }, status: 'SUCCESSFUL', vertical: { [Op.in]: REVENUE_VERTICALS } },
            group: [fn('DATE', col('createdAt'))],
            raw:   true,
        });
        const revByDate = new Map();
        for (const r of revenueOverTime) {
            const k = String(r.date);
            revByDate.set(k, { date: k, revenue: parseFloat(r.revenue || 0), trips: parseInt(r.trips || 0, 10) });
        }
        for (const r of wpRevByDay) {
            const k   = String(r.date);
            const cur = revByDate.get(k) || { date: k, revenue: 0, trips: 0 };
            cur.revenue += parseFloat(r.revenue || 0);
            revByDate.set(k, cur);
        }
        const revenueOverTimeMerged = [...revByDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));

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

        // Merge in CamPay payments by operator (MTN / Orange) across ALL verticals
        // (services, rentals, delivery, top-ups) so the pie shows how money really
        // enters the platform — not just cash from rides.
        const wpByOperator = await WegoPayment.findAll({
            attributes: ['operator', [fn('COUNT', col('id')), 'count'], [fn('SUM', col('amount')), 'total']],
            where: { createdAt: { [Op.between]: [start, end] }, status: 'SUCCESSFUL' },
            group: ['operator'],
            raw:   true,
        });
        // Emit method KEYS the frontend colour/label maps understand.
        const RIDE_METHOD_KEY = { CASH: 'cash', MOMO: 'mtn_mobile_money', OM: 'orange_money', MTN_MOMO: 'mtn_mobile_money', ORANGE_MONEY: 'orange_money' };
        const methodAgg = new Map();
        const addMethod = (key, count, total) => {
            const c = methodAgg.get(key) || { count: 0, total: 0 };
            c.count += count;
            c.total += total;
            methodAgg.set(key, c);
        };
        for (const p of paymentBreakdown) {
            const key = RIDE_METHOD_KEY[String(p.paymentMethod || '').toUpperCase()] || 'cash';
            addMethod(key, parseInt(p.count || 0, 10), parseFloat(p.total || 0));
        }
        for (const p of wpByOperator) {
            const key = p.operator === 'MTN' ? 'mtn_mobile_money' : p.operator === 'ORANGE' ? 'orange_money' : 'mobile_money';
            addMethod(key, parseInt(p.count || 0, 10), parseFloat(p.total || 0));
        }
        const paymentBreakdownMerged = [...methodAgg.entries()].map(([method, v]) => ({ method, count: v.count, total: v.total }));

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
                revenueOverTime: revenueOverTimeMerged.map(r => ({
                    date    : r.date,
                    revenue : xaf(r.revenue),
                    trips   : r.trips,
                })),
                tripsOverTime: tripsOverTime.map(t => ({
                    date      : t.date,
                    total     : parseInt(t.total),
                    completed : parseInt(t.completed),
                    cancelled : parseInt(t.cancelled),
                })),
                paymentBreakdown: paymentBreakdownMerged.map(p => ({
                    method : p.method,
                    count  : p.count,
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
            pendingListings,
            pendingPlans,
        ] = await Promise.all([

            // Last 5 completed trips
            Trip.findAll({
                where      : { status: 'COMPLETED' },
                order      : [['updatedAt', 'DESC']],
                limit      : 5,
                attributes : ['id', 'passengerId', 'driverId', 'fareFinal', 'pickupAddress', 'dropoffAddress', 'updatedAt'],
                raw        : true,
            }),

            // Last 5 new account signups
            Account.findAll({
                order      : [['created_at', 'DESC']],
                limit      : 5,
                attributes : ['uuid', 'first_name', 'last_name', 'user_type', 'created_at'],
                raw        : true,
            }),

            // Last 3 listings awaiting moderation
            ServiceListing.findAll({
                where      : { status: 'pending_review' },
                order      : [['created_at', 'DESC']],
                limit      : 3,
                attributes : ['id', 'title', 'status', 'created_at'],
                raw        : true,
            }),

            // Last 3 ad plans awaiting payment
            ServiceAdPayment.findAll({
                where      : { status: 'pending_payment' },
                order      : [['created_at', 'DESC']],
                limit      : 3,
                attributes : ['id', 'plan_key_snapshot', 'status', 'created_at'],
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

        pendingListings.forEach(l => {
            feed.push({
                type      : 'listing_pending',
                id        : l.id,
                icon      : '📋',
                title     : 'Annonce en attente',
                subtitle  : l.title || `Annonce #${l.id}`,
                meta      : 'Modération requise',
                timestamp : l.created_at,
            });
        });

        pendingPlans.forEach(p => {
            feed.push({
                type      : 'plan_pending',
                id        : p.id,
                icon      : '💳',
                title     : 'Plan en attente de paiement',
                subtitle  : p.plan_key_snapshot,
                meta      : 'Paiement attendu',
                timestamp : p.created_at,
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