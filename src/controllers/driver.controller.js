/// src/controllers/driver.controller.js

const { Account, DriverProfile, Trip, TripEvent, Rating, DriverWallet, EarningRule, sequelize } = require('../models');
const { Op }          = require('sequelize');
const earningsEngine  = require('../services/earningsEngineService');
const { v4: uuidv4 }  = require('uuid');
const { redisClient, redisHelpers, REDIS_KEYS } = require('../config/redis');
const { getIO }       = require('../sockets/index');

// ── Shared cache key with EarningsEngineService + tripMatchingService ─────────
// All three services read the same Redis key so commission rules are never
// fetched from the DB more than once per 5-minute TTL window.
const RULES_CACHE_KEY        = 'earnings:rules:active';
const RULES_CACHE_TTL_S      = 300;
const FALLBACK_COMMISSION_RATE = parseFloat(process.env.DEFAULT_COMMISSION_RATE || '0.10');

// ── Low-balance warning threshold ─────────────────────────────────────────────
// If balance < this many XAF the goOnline response includes a low_balance flag
// so Flutter can show a top-up banner without blocking the driver.
const LOW_BALANCE_THRESHOLD = parseInt(process.env.LOW_BALANCE_THRESHOLD_XAF || '2000', 10);

// ═══════════════════════════════════════════════════════════════════════
// PRIVATE HELPER — Resolve commission rate from cached EarningRules
// ═══════════════════════════════════════════════════════════════════════
// Mirrors the same logic in tripMatchingService._getCommissionRate()
// so the accept-time wallet check uses the exact same rate.

async function _getCommissionRate(fareEstimate) {
    let rules = [];

    try {
        const cached = await redisClient.get(RULES_CACHE_KEY);
        if (cached) rules = JSON.parse(cached);
    } catch (e) {
        // cache miss — will load from DB below
    }

    if (rules.length === 0) {
        const today  = new Date().toISOString().split('T')[0];
        const dbRules = await EarningRule.findAll({
            where: {
                isActive: true,
                type:     'COMMISSION_PERCENT',
                [Op.and]: [
                    { [Op.or]: [{ validFrom: null }, { validFrom: { [Op.lte]: today } }] },
                    { [Op.or]: [{ validTo:   null }, { validTo:   { [Op.gte]: today } }] },
                ],
            },
            order: [['priority', 'DESC']],
        });
        rules = dbRules.map(r => r.toJSON());
        try {
            await redisClient.setex(RULES_CACHE_KEY, RULES_CACHE_TTL_S, JSON.stringify(rules));
        } catch (e) { /* non-fatal */ }
    }

    for (const rule of rules) {
        if (rule.type !== 'COMMISSION_PERCENT' || !rule.isActive) continue;
        const c = rule.conditions || {};
        if (c.min_fare !== undefined && fareEstimate < c.min_fare) continue;
        if (c.max_fare !== undefined && fareEstimate > c.max_fare) continue;
        return parseFloat(rule.value);
    }

    return FALLBACK_COMMISSION_RATE;
}

// ═══════════════════════════════════════════════════════════════════════
// HELPER — Build full driver info (used in acceptTrip socket emit)
// ═══════════════════════════════════════════════════════════════════════

async function buildFullDriverInfo(driverUuid, driverLocation = null) {
    console.log(`\n🔧 [DRIVER_INFO] Building full driver info for: ${driverUuid}`);

    const [account, profile] = await Promise.all([
        Account.findOne({
            where:      { uuid: driverUuid },
            attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'],
        }),
        DriverProfile.findOne({
            where:      { account_id: driverUuid },
            attributes: [
                'rating_avg', 'rating_count', 'vehicle_type', 'vehicle_plate',
                'vehicle_make_model', 'vehicle_color', 'vehicle_year',
                'vehicle_photo_url', 'avatar_url',
            ],
        }),
    ]);

    const firstName = account?.first_name || '';
    const lastName  = account?.last_name  || '';
    const fullName  = `${firstName} ${lastName}`.trim() || 'Driver';

    const info = {
        id:         driverUuid,
        uuid:       driverUuid,
        name:       fullName,
        firstName,
        lastName,
        phone:      account?.phone_e164 || '',
        phone_e164: account?.phone_e164 || '',
        avatar:     profile?.avatar_url || account?.avatar_url || null,
        avatar_url: profile?.avatar_url || account?.avatar_url || null,
        rating:      profile?.rating_avg   ?? 5.0,
        rating_avg:  profile?.rating_avg   ?? 5.0,
        ratingAvg:   profile?.rating_avg   ?? 5.0,
        ratingCount: profile?.rating_count ?? 0,
        location:    driverLocation || null,
        vehicle: {
            type:               profile?.vehicle_type       || 'Economy',
            vehicleType:        profile?.vehicle_type       || 'Economy',
            plate:              profile?.vehicle_plate      || '',
            vehiclePlate:       profile?.vehicle_plate      || '',
            makeModel:          profile?.vehicle_make_model || '',
            vehicle_make_model: profile?.vehicle_make_model || '',
            vehicleMakeModel:   profile?.vehicle_make_model || '',
            color:              profile?.vehicle_color      || '',
            vehicleColor:       profile?.vehicle_color      || '',
            year:               profile?.vehicle_year       || '',
            vehicleYear:        profile?.vehicle_year       || '',
            photo:              profile?.vehicle_photo_url  || null,
            vehicle_photo_url:  profile?.vehicle_photo_url  || null,
        },
    };

    console.log(`✅ [DRIVER_INFO] Built for ${fullName}:`);
    console.log(`   Vehicle: ${info.vehicle.makeModel} | ${info.vehicle.color} | ${info.vehicle.plate}`);
    console.log(`   Rating: ${info.rating} | Phone: ${info.phone}`);

    return info;
}

// ═══════════════════════════════════════════════════════════════════════
// DRIVER STATUS CONTROLLERS
// ═══════════════════════════════════════════════════════════════════════

exports.setStatus = async (req, res, next) => {
    try {
        const { status, lat, lng, heading } = req.body;

        if (!status || !['online', 'offline'].includes(status)) {
            return res.status(400).json({
                error:   'Validation error',
                message: 'status must be "online" or "offline"',
            });
        }

        const driverUuid = req.user.uuid;
        console.log(`\n${ status === 'online' ? '🟢' : '🔴' } [DRIVER] setStatus → ${status} | User: ${driverUuid}`);

        if (status === 'online') {
            if (!lat || !lng) {
                return res.status(400).json({
                    error:   'Validation error',
                    message: 'lat and lng are required to go online',
                });
            }

            const parsedLat = parseFloat(lat);
            const parsedLng = parseFloat(lng);

            if (parsedLat < -90 || parsedLat > 90 || parsedLng < -180 || parsedLng > 180) {
                return res.status(400).json({
                    error:   'Validation error',
                    message: 'Invalid coordinates',
                });
            }

            const account = await Account.findByPk(driverUuid);
            if (account) {
                account.lastLatitude  = parsedLat;
                account.lastLongitude = parsedLng;
                await account.save();
            }

            const { Driver } = require('../models');
            await Driver.update(
                { status: 'online', lat: parsedLat, lng: parsedLng },
                { where: { userId: driverUuid } }
            );

            await redisClient.geoadd(REDIS_KEYS.DRIVERS_GEO, parsedLng, parsedLat, driverUuid.toString());
            await redisClient.sadd(REDIS_KEYS.ONLINE_DRIVERS,    driverUuid.toString());
            await redisClient.sadd(REDIS_KEYS.AVAILABLE_DRIVERS, driverUuid.toString());

            await redisHelpers.setJson(`driver:location:${driverUuid}`, {
                driverId:    driverUuid,
                lat:         parsedLat,
                lng:         parsedLng,
                heading:     heading || 0,
                lastUpdated: new Date().toISOString(),
            }, 3600);

            await redisClient.setex(
                REDIS_KEYS.DRIVER_META(driverUuid),
                3600,
                JSON.stringify({
                    driverId:    driverUuid,
                    status:      'ONLINE',
                    isAvailable: true,
                    firstName:   req.user.first_name,
                    lastName:    req.user.last_name,
                    phone:       req.user.phone_e164,
                    userType:    req.user.user_type,
                    lastUpdated: new Date().toISOString(),
                })
            );

            // ── Fetch wallet balance to include in response ────────────
            // Driver is not blocked — they go online regardless of balance.
            // We surface balance + a low_balance flag so Flutter can show
            // a "top up your wallet" banner proactively.
            let walletData = null;
            try {
                const wallet = await DriverWallet.findOne({
                    where:      { driverId: driverUuid },
                    attributes: ['balance', 'status'],
                });
                if (wallet) {
                    walletData = {
                        balance:     wallet.balance,
                        currency:    'XAF',
                        status:      wallet.status,
                        low_balance: wallet.balance < LOW_BALANCE_THRESHOLD,
                    };
                }
            } catch (walletErr) {
                // Non-fatal — don't fail goOnline because of a wallet read error
                console.warn('⚠️  [DRIVER] setStatus: wallet fetch failed (non-fatal):', walletErr.message);
            }

            console.log('✅ [DRIVER] setStatus → online | Redis updated');

            return res.status(200).json({
                success:   true,
                message:   'You are now online',
                data: {
                    driver_id: driverUuid,
                    is_online: true,
                    location:  { lat: parsedLat, lng: parsedLng, heading: heading || 0 },
                    wallet:    walletData,
                    timestamp: new Date().toISOString(),
                },
            });

        } else {
            const { Driver } = require('../models');
            await Driver.update(
                { status: 'offline' },
                { where: { userId: driverUuid } }
            );

            await redisClient.zrem(REDIS_KEYS.DRIVERS_GEO,      driverUuid.toString());
            await redisClient.srem(REDIS_KEYS.ONLINE_DRIVERS,    driverUuid.toString());
            await redisClient.srem(REDIS_KEYS.AVAILABLE_DRIVERS, driverUuid.toString());
            await redisClient.del(REDIS_KEYS.DRIVER_META(driverUuid));
            await redisClient.del(`driver:location:${driverUuid}`);

            console.log('✅ [DRIVER] setStatus → offline | Redis cleaned');

            return res.status(200).json({
                success:   true,
                message:   'You are now offline',
                data: {
                    driver_id: driverUuid,
                    is_online: false,
                    timestamp: new Date().toISOString(),
                },
            });
        }

    } catch (error) {
        console.error('❌ [DRIVER] setStatus error:', error.message);
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────
exports.reportNoShow = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('⚠️  [DRIVER] reportNoShow');
        const { tripId } = req.params;
        const { waitingTime, reason } = req.body;

        if (!waitingTime || waitingTime < 0) {
            return res.status(400).json({ error: 'Validation error', message: 'Valid waiting time is required' });
        }

        const trip = await Trip.findByPk(tripId);
        if (!trip) return res.status(404).json({ error: 'Trip not found' });
        if (trip.driverId !== req.user.uuid) return res.status(403).json({ error: 'Access denied' });
        if (trip.status !== 'DRIVER_ARRIVED') {
            return res.status(400).json({
                error:         'Invalid status',
                message:       'Can only report no-show when status is DRIVER_ARRIVED',
                currentStatus: trip.status,
            });
        }

        const MIN_WAIT = 300;
        if (waitingTime < MIN_WAIT) {
            return res.status(400).json({
                error:              'Invalid waiting time',
                message:            `Please wait at least ${MIN_WAIT / 60} minutes before reporting no-show`,
                minimumWaitingTime: MIN_WAIT,
                currentWaitingTime: waitingTime,
            });
        }

        trip.status       = 'NO_SHOW';
        trip.cancelReason = reason || 'Passenger did not show up';
        trip.canceledBy   = 'DRIVER';
        trip.canceledAt   = new Date();
        await trip.save();

        await redisClient.del(REDIS_KEYS.ACTIVE_TRIP(tripId));
        await redisClient.del(`passenger:active_trip:${trip.passengerId}`);
        await redisClient.del(`driver:active_trip:${req.user.uuid}`);

        const io = getIO();
        io.to(`passenger:${trip.passengerId}`).emit('trip:no_show', {
            tripId:      trip.id,
            waitingTime,
            reason:      trip.cancelReason,
        });

        console.log('✅ [DRIVER] No-show reported');
        res.status(200).json({ message: 'No-show reported successfully', data: { trip, waitingTime } });

    } catch (error) {
        console.error('❌ [DRIVER] reportNoShow error:', error);
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────
exports.goOnline = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🟢 [DRIVER] goOnline — Driver:', req.user.uuid);
        const { lat, lng, heading } = req.body;

        if (!lat || !lng) {
            return res.status(400).json({ error: 'Validation error', message: 'Location (lat, lng) is required' });
        }
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            return res.status(400).json({ error: 'Validation error', message: 'Invalid coordinates' });
        }

        const driver = await Account.findByPk(req.user.uuid);
        if (driver) {
            if (driver.lastLatitude  !== undefined) driver.lastLatitude  = lat;
            if (driver.lastLongitude !== undefined) driver.lastLongitude = lng;
            await driver.save();
        }

        await redisClient.geoadd(REDIS_KEYS.DRIVERS_GEO, parseFloat(lng), parseFloat(lat), req.user.uuid.toString());
        await redisClient.sadd(REDIS_KEYS.ONLINE_DRIVERS,    req.user.uuid.toString());
        await redisClient.sadd(REDIS_KEYS.AVAILABLE_DRIVERS, req.user.uuid.toString());

        await redisHelpers.setJson(`driver:location:${req.user.uuid}`, {
            driverId:    req.user.uuid,
            lat:         parseFloat(lat),
            lng:         parseFloat(lng),
            heading:     heading || 0,
            lastUpdated: new Date().toISOString(),
        }, 3600);

        await redisClient.setex(
            REDIS_KEYS.DRIVER_META(req.user.uuid),
            3600,
            JSON.stringify({
                driverId:    req.user.uuid,
                status:      'ONLINE',
                isAvailable: true,
                firstName:   req.user.first_name,
                lastName:    req.user.last_name,
                phone:       req.user.phone_e164,
                lastUpdated: new Date().toISOString(),
            })
        );

        // ── Fetch wallet balance to surface in response ────────────────
        // No blocking — driver goes online freely.
        // Flutter uses low_balance flag to show a top-up banner.
        let walletData = null;
        try {
            const wallet = await DriverWallet.findOne({
                where:      { driverId: req.user.uuid },
                attributes: ['balance', 'status'],
            });
            if (wallet) {
                walletData = {
                    balance:     wallet.balance,
                    currency:    'XAF',
                    status:      wallet.status,
                    low_balance: wallet.balance < LOW_BALANCE_THRESHOLD,
                };
            }
        } catch (walletErr) {
            console.warn('⚠️  [DRIVER] goOnline: wallet fetch failed (non-fatal):', walletErr.message);
        }

        console.log('✅ [DRIVER] Online — Redis updated (GEO + JSON + metadata)');
        console.log(`   Wallet balance: ${walletData?.balance ?? 'N/A'} XAF | Low: ${walletData?.low_balance ?? 'N/A'}`);

        res.status(200).json({
            message: 'You are now online and ready to receive trips',
            data: {
                driver_id: req.user.uuid,
                is_online: true,
                location:  { lat, lng, heading },
                wallet:    walletData,
                timestamp: new Date().toISOString(),
            },
        });

    } catch (error) {
        console.error('❌ [DRIVER] goOnline error:', error);
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────
exports.goOffline = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔴 [DRIVER] goOffline — Driver:', req.user.uuid);

        await redisClient.zrem(REDIS_KEYS.DRIVERS_GEO,      req.user.uuid.toString());
        await redisClient.srem(REDIS_KEYS.ONLINE_DRIVERS,    req.user.uuid.toString());
        await redisClient.srem(REDIS_KEYS.AVAILABLE_DRIVERS, req.user.uuid.toString());
        await redisClient.del(REDIS_KEYS.DRIVER_META(req.user.uuid));
        await redisClient.del(REDIS_KEYS.DRIVER_LOCATION(req.user.uuid));

        console.log('✅ [DRIVER] Offline — Redis cleaned. Account.status unchanged (ACTIVE)');
        res.status(200).json({
            message: 'You are now offline. You will not receive trip requests.',
            data: { driver_id: req.user.uuid, is_online: false, timestamp: new Date().toISOString() },
        });

    } catch (error) {
        console.error('❌ [DRIVER] goOffline error:', error);
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────
exports.updateLocation = async (req, res, next) => {
    try {
        const { lat, lng, heading, speed, accuracy } = req.body;
        if (!lat || !lng) {
            return res.status(400).json({ error: 'Validation error', message: 'lat and lng are required' });
        }

        await redisClient.geoadd(REDIS_KEYS.DRIVERS_GEO, parseFloat(lng), parseFloat(lat), req.user.uuid.toString());
        await redisHelpers.setJson(`driver:location:${req.user.uuid}`, {
            driverId:    req.user.uuid,
            lat:         parseFloat(lat),
            lng:         parseFloat(lng),
            heading:     heading  || 0,
            speed:       speed    || 0,
            accuracy:    accuracy || 0,
            lastUpdated: new Date().toISOString(),
        }, 3600);

        const activeTripData = await redisHelpers.getJson(`driver:active_trip:${req.user.uuid}`);
        if (activeTripData?.tripId) {
            const tripData = await redisHelpers.getJson(REDIS_KEYS.ACTIVE_TRIP(activeTripData.tripId));
            if (tripData?.passengerId) {
                const io = getIO();
                io.to(`passenger:${tripData.passengerId}`).emit('driver:location_update', {
                    tripId:  activeTripData.tripId,
                    lat:     parseFloat(lat),
                    lng:     parseFloat(lng),
                    heading: heading || 0,
                    speed:   speed   || 0,
                });
            }
        }

        res.status(200).json({
            message: 'Location updated successfully',
            data: { lat, lng, heading, speed, timestamp: new Date().toISOString() },
        });

    } catch (error) {
        console.error('❌ [DRIVER] updateLocation error:', error);
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────
exports.getStatus = async (req, res, next) => {
    try {
        console.log('📊 [DRIVER] getStatus — Driver:', req.user.uuid);

        const rawMeta      = await redisClient.get(REDIS_KEYS.DRIVER_META(req.user.uuid));
        const meta         = rawMeta ? JSON.parse(rawMeta) : null;
        const is_online    = meta?.status === 'ONLINE';
        const locationData = await redisHelpers.getJson(`driver:location:${req.user.uuid}`);

        console.log(`✅ [DRIVER] getStatus — is_online: ${is_online} (from Redis)`);

        res.status(200).json({
            message: 'Driver status retrieved',
            data: {
                driver_id:    req.user.uuid,
                is_online,
                is_available: meta?.isAvailable ?? false,
                location:     locationData ? { lat: locationData.lat, lng: locationData.lng } : null,
                last_updated: meta?.lastUpdated || new Date().toISOString(),
            },
        });

    } catch (error) {
        console.error('❌ [DRIVER] getStatus error:', error);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// WALLET CONTROLLER
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /api/driver/wallet
 *
 * Returns the driver's current wallet balance plus period breakdowns.
 * Delegates to EarningsEngineService.getWalletSummary() for the heavy
 * lifting — the same data that powers the earnings dashboard, but
 * accessible from a simpler endpoint for the wallet widget.
 */
exports.getWalletBalance = async (req, res, next) => {
    try {
        console.log('\n💰 [DRIVER] getWalletBalance — Driver:', req.user.uuid);

        const summary = await earningsEngine.getWalletSummary(req.user.uuid);

        if (!summary) {
            // Wallet not created yet — driver has never completed a trip
            // and hasn't topped up. Return a zero state so Flutter doesn't crash.
            return res.status(200).json({
                message: 'Wallet retrieved',
                data: {
                    balance:         0,
                    currency:        'XAF',
                    status:          'ACTIVE',
                    low_balance:     true,
                    low_balance_threshold: LOW_BALANCE_THRESHOLD,
                    totalEarned:     0,
                    totalCommission: 0,
                    totalBonuses:    0,
                    totalPayouts:    0,
                    today:  { net: 0, trips: 0 },
                    week:   { net: 0, trips: 0 },
                    month:  { net: 0 },
                },
            });
        }

        console.log(`✅ [DRIVER] Wallet balance: ${summary.balance} XAF`);

        return res.status(200).json({
            message: 'Wallet retrieved',
            data: {
                ...summary,
                low_balance:           summary.balance < LOW_BALANCE_THRESHOLD,
                low_balance_threshold: LOW_BALANCE_THRESHOLD,
            },
        });

    } catch (error) {
        console.error('❌ [DRIVER] getWalletBalance error:', error);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// TRIP MANAGEMENT CONTROLLERS
// ═══════════════════════════════════════════════════════════════════════

exports.getCurrentTrip = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔍 [DRIVER] getCurrentTrip — Driver:', req.user.uuid);

        const trip = await Trip.findOne({
            where: {
                driverId: req.user.uuid,
                status:   { [Op.in]: ['MATCHED', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS'] },
            },
            include: [
                {
                    model:      Account,
                    as:         'passenger',
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'],
                    required:   false,
                }
            ],
            order: [['createdAt', 'DESC']],
        });

        if (!trip) {
            return res.status(200).json({ message: 'No active trip', data: { currentTrip: null } });
        }

        console.log('✅ [DRIVER] Active trip:', trip.id, '—', trip.status);
        res.status(200).json({ message: 'Current trip retrieved', data: { currentTrip: trip } });

    } catch (error) {
        console.error('❌ [DRIVER] getCurrentTrip error:', error);
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────
exports.acceptTrip = async (req, res, next) => {
    const { tripId }  = req.params;
    const driverId    = req.user.uuid;
    const driverName  = `${req.user.first_name} ${req.user.last_name}`;
    const lockKey     = `trip:lock:${tripId}`;
    const lockValue   = uuidv4();
    const lockTTL     = 10;

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🚕 [ACCEPT-TRIP] Processing — Trip:', tripId, '| Driver:', driverId);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    try {
        // ── STEP 1: Acquire atomic Redis lock ─────────────────────────
        const lockAcquired = await redisClient.set(lockKey, lockValue, 'EX', lockTTL, 'NX');
        if (!lockAcquired) {
            console.log('❌ [ACCEPT-TRIP] Lock failed — another driver is processing');
            return res.status(409).json({
                error:   true,
                message: 'Trip is being accepted by another driver',
                code:    'TRIP_LOCKED',
            });
        }
        console.log('✅ [ACCEPT-TRIP] Lock acquired');

        // ── STEP 2: Clear timeout mechanisms ──────────────────────────
        const timeoutKey   = `trip:timeout:${tripId}`;
        const acceptingKey = `trip:accepting:${tripId}`;
        const noExpireKey  = `trip:no_expire:${tripId}`;

        await redisClient.del(timeoutKey);
        await redisClient.set(acceptingKey, driverId, 'EX', 120);
        await redisClient.set(noExpireKey,  '1',      'EX', 120);
        console.log('✅ [ACCEPT-TRIP] Timeout cleared, accepting markers set');

        // ── STEP 3: Get trip from Redis ────────────────────────────────
        const tripKey = REDIS_KEYS.ACTIVE_TRIP(tripId);
        const trip    = await redisHelpers.getJson(tripKey);

        if (!trip) {
            await redisClient.del(lockKey, acceptingKey, noExpireKey);
            return res.status(404).json({
                error:   true,
                message: 'Trip not found or already expired',
                code:    'TRIP_NOT_FOUND',
            });
        }

        // ── STEP 4: Validate trip status ───────────────────────────────
        if (trip.status !== 'SEARCHING') {
            await redisClient.del(lockKey, acceptingKey, noExpireKey);
            return res.status(409).json({
                error:   true,
                message: 'This trip is no longer available',
                code:    'TRIP_NOT_AVAILABLE',
                data:    { currentStatus: trip.status, acceptedBy: trip.driverId || null },
            });
        }

        if (trip.driverId && trip.driverId !== driverId) {
            await redisClient.del(lockKey, acceptingKey, noExpireKey);
            return res.status(409).json({
                error:   true,
                message: 'Trip already accepted by another driver',
                code:    'TRIP_ALREADY_ACCEPTED',
            });
        }

        // ── STEP 4b: Wallet balance gate ───────────────────────────────
        //
        // Time-of-use check: the driver passed the balance gate at dispatch
        // time (in tripMatchingService), but wallet balance can change between
        // offer and accept (admin penalty, another commission deduction, etc.).
        // We re-check here before the trip is locked to this driver.
        //
        // This is the same Uber/Yango pattern — the accept is rejected silently
        // with a specific error code so Flutter can prompt the driver to top up.
        try {
            const fareEstimate       = Math.round(trip.fareEstimate || 0);
            const commissionRate     = await _getCommissionRate(fareEstimate);
            const commissionRequired = Math.ceil(fareEstimate * commissionRate);

            const wallet = await DriverWallet.findOne({
                where:      { driverId, status: 'ACTIVE' },
                attributes: ['balance', 'status'],
            });

            const currentBalance = wallet?.balance ?? 0;

            console.log(`💰 [ACCEPT-TRIP] Wallet gate:`);
            console.log(`   Balance  : ${currentBalance} XAF`);
            console.log(`   Required : ${commissionRequired} XAF (${(commissionRate * 100).toFixed(1)}% of ${fareEstimate} XAF fare)`);

            if (currentBalance < commissionRequired) {
                await redisClient.del(lockKey, acceptingKey, noExpireKey);
                console.log(`⛔ [ACCEPT-TRIP] Insufficient balance — rejecting accept`);
                return res.status(402).json({
                    error:   true,
                    message: `Insufficient wallet balance. You need at least ${commissionRequired} XAF to accept this trip.`,
                    code:    'INSUFFICIENT_WALLET_BALANCE',
                    data: {
                        balance_current:  currentBalance,
                        balance_required: commissionRequired,
                        fare_estimate:    fareEstimate,
                        commission_rate:  commissionRate,
                        shortfall:        commissionRequired - currentBalance,
                        currency:         'XAF',
                    },
                });
            }

            console.log(`✅ [ACCEPT-TRIP] Wallet gate passed — balance sufficient`);

        } catch (walletErr) {
            // If wallet check itself errors, log it but don't silently pass —
            // we fail safe and block the accept to avoid a commission debt.
            await redisClient.del(lockKey, acceptingKey, noExpireKey);
            console.error('❌ [ACCEPT-TRIP] Wallet check error:', walletErr.message);
            return res.status(500).json({
                error:   true,
                message: 'Could not verify wallet balance. Please try again.',
                code:    'WALLET_CHECK_FAILED',
            });
        }

        // ── STEP 5: Get driver location ────────────────────────────────
        const driverLocationData = await redisHelpers.getJson(`driver:location:${driverId}`);
        if (!driverLocationData) {
            await redisClient.del(lockKey, acceptingKey, noExpireKey);
            return res.status(400).json({
                error:   true,
                message: 'Driver location not available. Please ensure you are online.',
                code:    'DRIVER_LOCATION_MISSING',
            });
        }
        const driverLocation = {
            lat: parseFloat(driverLocationData.lat),
            lng: parseFloat(driverLocationData.lng),
        };

        // ── STEP 6: Update Redis trip ──────────────────────────────────
        const updatedTrip = {
            ...trip,
            driverId,
            driverName,
            driverLocation,
            status:    'MATCHED',
            matchedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        await redisHelpers.setJson(tripKey, updatedTrip, 7200);
        console.log('✅ [ACCEPT-TRIP] Redis trip updated → MATCHED');

        // ── STEP 7: Save trip to DB ────────────────────────────────────
        let dbTrip;
        try {
            dbTrip = await Trip.create({
                id:                trip.id,
                passengerId:       trip.passengerId,
                driverId,
                status:            'MATCHED',
                pickupLat:         trip.pickupLat,
                pickupLng:         trip.pickupLng,
                pickupAddress:     trip.pickupAddress,
                dropoffLat:        trip.dropoffLat,
                dropoffLng:        trip.dropoffLng,
                dropoffAddress:    trip.dropoffAddress,
                distanceM:         trip.distanceM,
                durationS:         trip.durationS,
                fareEstimate:      trip.fareEstimate,
                paymentMethod:     trip.paymentMethod || 'CASH',
                routePolyline:     trip.routePolyline,
                driverLocationLat: driverLocation.lat,
                driverLocationLng: driverLocation.lng,
                matchedAt:         new Date(),
            });
            console.log('✅ [ACCEPT-TRIP] Trip saved to DB:', dbTrip.id);
        } catch (dbError) {
            console.error('❌ [ACCEPT-TRIP] DB save error:', dbError.message);
            await redisClient.del(lockKey, acceptingKey, noExpireKey);
            return res.status(500).json({
                error:   true,
                message: 'Failed to save trip',
                code:    'DATABASE_ERROR',
                details: dbError.message,
            });
        }

        // ── STEP 8: Trip event audit log (non-fatal) ───────────────────
        try {
            await TripEvent.create({
                tripId:      trip.id,
                eventType:   'TRIP_MATCHED',
                performedBy: driverId,
                metadata:    { driverLocation, matchedAt: new Date().toISOString() },
            });
        } catch (e) {
            console.warn('⚠️  [ACCEPT-TRIP] TripEvent create failed (non-fatal):', e.message);
        }

        // ── STEP 9: Update active trip refs in Redis ───────────────────
        await redisHelpers.setJson(
            `passenger:active_trip:${trip.passengerId}`,
            { tripId: trip.id, status: 'MATCHED', driverId, driverName },
            7200
        );
        await redisHelpers.setJson(
            `driver:active_trip:${driverId}`,
            { tripId: trip.id, status: 'MATCHED' },
            7200
        );

        // ── STEP 10: Clean driver offer queues ────────────────────────
        const offerKeys = await redisClient.keys('driver:pending_offers:*');
        for (const key of offerKeys) {
            const offers   = await redisHelpers.getJson(key) || [];
            if (Array.isArray(offers)) {
                const filtered = offers.filter(o => o.tripId !== tripId);
                if (filtered.length !== offers.length) {
                    await redisHelpers.setJson(key, filtered, 3600);
                }
            }
        }

        // ── STEP 11: Fetch passenger info from DB ──────────────────────
        const passengerAccount = await Account.findOne({
            where:      { uuid: trip.passengerId },
            attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'],
        });

        if (!passengerAccount) {
            await redisClient.del(lockKey, acceptingKey, noExpireKey);
            return res.status(404).json({
                error:   true,
                message: 'Passenger account not found',
                code:    'PASSENGER_NOT_FOUND',
            });
        }

        // ── STEP 12: Fetch passenger rating ───────────────────────────
        let passengerRating = null;
        try {
            const passengerRatingRows = await Rating.findAll({
                where:      { rated_user: trip.passengerId, rating_type: 'DRIVER_TO_PASSENGER' },
                attributes: ['stars'],
            });
            if (passengerRatingRows.length) {
                const total = passengerRatingRows.reduce((sum, r) => sum + r.stars, 0);
                passengerRating = parseFloat((total / passengerRatingRows.length).toFixed(1));
            }
            console.log('✅ [ACCEPT-TRIP] Passenger rating fetched:', passengerRating);
        } catch (ratingError) {
            console.warn('⚠️  [ACCEPT-TRIP] Rating fetch failed (non-fatal):', ratingError.message);
        }

        const passengerData = {
            id:        passengerAccount.uuid,
            uuid:      passengerAccount.uuid,
            name:      `${passengerAccount.first_name} ${passengerAccount.last_name}`.trim(),
            firstName: passengerAccount.first_name,
            lastName:  passengerAccount.last_name,
            phone:     passengerAccount.phone_e164,
            avatar:    passengerAccount.avatar_url,
            rating:    passengerRating,
            pickup: {
                lat:     trip.pickupLat,
                lng:     trip.pickupLng,
                address: trip.pickupAddress,
            },
            dropoff: {
                lat:     trip.dropoffLat,
                lng:     trip.dropoffLng,
                address: trip.dropoffAddress,
            },
        };

        // ── STEP 13: Emit socket events ────────────────────────────────
        const io = getIO();

        let fullDriverInfo;
        try {
            fullDriverInfo = await buildFullDriverInfo(driverId, driverLocation);
        } catch (profileError) {
            console.warn('⚠️  [ACCEPT-TRIP] buildFullDriverInfo failed, using minimal info:', profileError.message);
            fullDriverInfo = {
                id:         driverId,
                uuid:       driverId,
                name:       driverName,
                firstName:  req.user.first_name || '',
                lastName:   req.user.last_name  || '',
                phone:      req.user.phone_e164 || '',
                phone_e164: req.user.phone_e164 || '',
                avatar:     null,
                avatar_url: null,
                rating:     5.0,
                rating_avg: 5.0,
                ratingAvg:  5.0,
                location:   driverLocation,
                vehicle: {
                    type: 'Economy', vehicleType: 'Economy',
                    plate: '', vehiclePlate: '',
                    makeModel: '', vehicle_make_model: '', vehicleMakeModel: '',
                    color: '', vehicleColor: '',
                    year: '', vehicleYear: '',
                    photo: null, vehicle_photo_url: null,
                },
            };
        }

        console.log('\n📡 [ACCEPT-TRIP] Emitting trip:driver_assigned to passenger:', trip.passengerId);
        console.log('   Driver:', fullDriverInfo.name);
        console.log('   Vehicle:', fullDriverInfo.vehicle.makeModel, '|', fullDriverInfo.vehicle.color, '|', fullDriverInfo.vehicle.plate);

        io.to(`passenger:${trip.passengerId}`).emit('trip:driver_assigned', {
            tripId:    trip.id,
            driver:    fullDriverInfo,
            trip:      updatedTrip,
            timestamp: new Date().toISOString(),
        });

        io.to(`driver:${driverId}`).emit('trip:matched', {
            tripId:    trip.id,
            trip:      updatedTrip,
            passenger: passengerData,
            timestamp: new Date().toISOString(),
        });

        const tripOffersKey  = REDIS_KEYS.TRIP_OFFERS ? REDIS_KEYS.TRIP_OFFERS(tripId) : `trip:offers:${tripId}`;
        const tripOffersData = await redisHelpers.getJson(tripOffersKey);
        const notifiedDrivers = tripOffersData?.drivers || tripOffersData?.notifiedDrivers || [];

        for (const notifiedDriverId of notifiedDrivers) {
            if (notifiedDriverId !== driverId) {
                io.to(`driver:${notifiedDriverId}`).emit('trip:request_expired', {
                    tripId,
                    message:   'This trip was accepted by another driver.',
                    timestamp: new Date().toISOString(),
                });
            }
        }
        console.log(`✅ [ACCEPT-TRIP] trip:request_expired sent to ${notifiedDrivers.length - 1} other drivers`);

        // ── STEP 14: Release lock ──────────────────────────────────────
        const currentLock = await redisClient.get(lockKey);
        if (currentLock === lockValue) await redisClient.del(lockKey);
        await redisClient.del(acceptingKey);

        console.log('✅ [ACCEPT-TRIP] Completed successfully');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({
            message: 'Trip accepted successfully',
            data: {
                driver_id: driverId,
                trip: {
                    id:        dbTrip.id,
                    status:    dbTrip.status,
                    fare:      trip.fareEstimate,
                    distance:  trip.distanceM,
                    duration:  trip.durationS,
                    matchedAt: dbTrip.matchedAt,
                    pickup:  { lat: trip.pickupLat,  lng: trip.pickupLng,  address: trip.pickupAddress  },
                    dropoff: { lat: trip.dropoffLat, lng: trip.dropoffLng, address: trip.dropoffAddress },
                },
                passenger: passengerData,
            },
        });

    } catch (error) {
        console.error('❌ [ACCEPT-TRIP] Unexpected error:', error);
        try {
            const cur = await redisClient.get(lockKey);
            if (cur === lockValue) await redisClient.del(lockKey);
            await redisClient.del(`trip:accepting:${tripId}`, `trip:no_expire:${tripId}`);
        } catch (e) { /* lock release best-effort */ }
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────
exports.declineTrip = async (req, res, next) => {
    const { tripId } = req.params;
    const driverId   = req.user.uuid;
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🚫 [DRIVER] declineTrip — Trip:', tripId, '| Driver:', driverId);

    try {
        const offers   = await redisHelpers.getJson(`driver:pending_offers:${driverId}`) || [];
        const filtered = offers.filter(o => o.tripId !== tripId);
        await redisHelpers.setJson(`driver:pending_offers:${driverId}`, filtered, 3600);

        const declinedKey = `trip:declined:${tripId}`;
        await redisClient.sadd(declinedKey, driverId);
        await redisClient.expire(declinedKey, 300);

        const io = getIO();
        io.to(`driver:${driverId}`).emit('trip:decline:success', { tripId, timestamp: new Date().toISOString() });

        console.log('✅ [DRIVER] Trip declined');
        return res.status(200).json({ message: 'Trip declined successfully', data: { tripId } });

    } catch (error) {
        console.error('❌ [DRIVER] declineTrip error:', error);
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────
exports.arrivedAtPickup = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📍 [DRIVER] arrivedAtPickup — Trip:', req.params.tripId);
        const { tripId } = req.params;

        const trip = await Trip.findByPk(tripId);
        if (!trip)                           return res.status(404).json({ error: 'Trip not found' });
        if (trip.driverId !== req.user.uuid) return res.status(403).json({ error: 'Access denied' });

        const allowedPrev = ['MATCHED', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE'];
        if (!allowedPrev.includes(trip.status)) {
            return res.status(400).json({
                error:         'Invalid status transition',
                message:       `Cannot mark arrived from status: ${trip.status}. Must be one of: ${allowedPrev.join(', ')}`,
                currentStatus: trip.status,
            });
        }

        trip.status    = 'DRIVER_ARRIVED';
        trip.arrivedAt = new Date();
        await trip.save();

        await redisHelpers.setJson(
            REDIS_KEYS.ACTIVE_TRIP(tripId),
            { ...trip.toJSON(), status: 'DRIVER_ARRIVED' },
            7200
        );

        const io = getIO();
        io.to(`passenger:${trip.passengerId}`).emit('trip:driver_arrived', {
            tripId:    trip.id,
            arrivedAt: trip.arrivedAt,
        });

        res.status(200).json({ message: 'Status updated: Driver arrived at pickup', data: { trip } });

    } catch (error) {
        console.error('❌ [DRIVER] arrivedAtPickup error:', error);
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────
exports.startTrip = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🚀 [DRIVER] startTrip — Trip:', req.params.tripId);
        const { tripId } = req.params;

        const trip = await Trip.findByPk(tripId);
        if (!trip)                           return res.status(404).json({ error: 'Trip not found' });
        if (trip.driverId !== req.user.uuid) return res.status(403).json({ error: 'Access denied' });

        if (trip.status !== 'DRIVER_ARRIVED') {
            return res.status(400).json({
                error:         'Invalid status transition',
                message:       `Cannot start trip from status: ${trip.status}. Driver must be DRIVER_ARRIVED first.`,
                currentStatus: trip.status,
            });
        }

        trip.status        = 'IN_PROGRESS';
        trip.tripStartedAt = new Date();
        await trip.save();

        await redisHelpers.setJson(
            REDIS_KEYS.ACTIVE_TRIP(tripId),
            { ...trip.toJSON(), status: 'IN_PROGRESS' },
            7200
        );

        const io = getIO();
        io.to(`passenger:${trip.passengerId}`).emit('trip:started', {
            tripId:    trip.id,
            startedAt: trip.tripStartedAt,
        });

        res.status(200).json({ message: 'Trip started successfully', data: { trip } });

    } catch (error) {
        console.error('❌ [DRIVER] startTrip error:', error);
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────
exports.completeTrip = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🏁 [DRIVER] completeTrip — Trip:', req.params.tripId);

        const { tripId }            = req.params;
        const { final_fare, notes } = req.body;

        const trip = await Trip.findByPk(tripId);
        if (!trip)                           return res.status(404).json({ error: 'Trip not found' });
        if (trip.driverId !== req.user.uuid) return res.status(403).json({ error: 'Access denied' });
        if (trip.status !== 'IN_PROGRESS') {
            return res.status(400).json({
                error:         'Invalid status transition',
                message:       `Cannot complete trip from status: ${trip.status}. Trip must be IN_PROGRESS.`,
                currentStatus: trip.status,
            });
        }

        const result = await sequelize.transaction(async (t) => {
            trip.status          = 'COMPLETED';
            trip.tripCompletedAt = new Date();
            if (final_fare) trip.fareFinal = parseInt(final_fare, 10);
            if (notes)      trip.notes     = notes;
            await trip.save({ transaction: t });

            console.log('✅ [DRIVER] Trip status → COMPLETED');
            console.log('   Final fare:', trip.fareFinal || trip.fareEstimate, 'XAF');

            const earningsResult = await earningsEngine.processTrip(trip, t);
            return { trip, earningsResult };
        });

        // ── Clean up Redis (non-fatal) ─────────────────────────────────
        try {
            await redisClient.del(REDIS_KEYS.ACTIVE_TRIP(tripId));
            await redisClient.del(`passenger:active_trip:${result.trip.passengerId}`);
            await redisClient.del(`driver:active_trip:${req.user.uuid}`);
            await redisClient.del(`trip:timeout:${tripId}`);
            await redisClient.del(`trip:accepting:${tripId}`);
            await redisClient.del(`trip:no_expire:${tripId}`);
        } catch (redisErr) {
            console.warn('⚠️  [DRIVER] Redis cleanup error (non-fatal):', redisErr.message);
        }

        // ── Reset driver to available ──────────────────────────────────
        try {
            const rawMeta = await redisClient.get(REDIS_KEYS.DRIVER_META(req.user.uuid));
            if (rawMeta) {
                const meta       = JSON.parse(rawMeta);
                meta.isAvailable = true;
                meta.lastUpdated = new Date().toISOString();
                await redisClient.setex(REDIS_KEYS.DRIVER_META(req.user.uuid), 3600, JSON.stringify(meta));
            }
            await redisClient.sadd(REDIS_KEYS.AVAILABLE_DRIVERS, req.user.uuid.toString());
        } catch (redisErr) {
            console.warn('⚠️  [DRIVER] Driver availability reset error (non-fatal):', redisErr.message);
        }

        // ── Notify passenger ───────────────────────────────────────────
        try {
            const io = getIO();
            io.to(`passenger:${result.trip.passengerId}`).emit('trip:completed', {
                tripId:      result.trip.id,
                completedAt: result.trip.tripCompletedAt,
                finalFare:   result.trip.fareFinal,
            });
        } catch (socketErr) {
            console.warn('⚠️  [DRIVER] Socket emit error (non-fatal):', socketErr.message);
        }

        const { earningsResult } = result;
        const earnings = earningsResult.alreadyProcessed
            ? { note: 'Earnings already processed for this trip' }
            : {
                grossFare:        earningsResult.summary?.grossFare        || 0,
                commissionAmount: earningsResult.summary?.commissionAmount || 0,
                bonusTotal:       earningsResult.summary?.bonusTotal       || 0,
                driverNet:        earningsResult.summary?.driverNet        || 0,
                questBonusTotal:  earningsResult.summary?.questBonusTotal  || 0,
                questAwards:      earningsResult.questAwards?.map(a => ({
                    programName: a.name || 'Bonus',
                    amount:      a.awardedAmount,
                    periodKey:   a.periodKey,
                })) || [],
            };

        console.log('✅ [DRIVER] completeTrip done');
        console.log('   Driver net:', earnings.driverNet, 'XAF');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({
            message: 'Trip completed successfully',
            data: { trip: result.trip, earnings },
        });

    } catch (error) {
        console.error('❌ [DRIVER] completeTrip error:', error);
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────
exports.cancelTrip = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🚫 [DRIVER] cancelTrip — Trip:', req.params.tripId);
        const { tripId } = req.params;
        const { reason } = req.body;

        if (!reason) return res.status(400).json({ error: 'Validation error', message: 'Cancellation reason is required' });

        const trip = await Trip.findByPk(tripId);
        if (!trip)                           return res.status(404).json({ error: 'Trip not found' });
        if (trip.driverId !== req.user.uuid) return res.status(403).json({ error: 'Access denied' });

        const cancelable = ['MATCHED', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED'];
        if (!cancelable.includes(trip.status)) {
            return res.status(400).json({
                error:   'Cannot cancel',
                message: `Trip in ${trip.status} status cannot be canceled`,
            });
        }

        trip.status       = 'CANCELED';
        trip.cancelReason = reason;
        trip.canceledBy   = 'DRIVER';
        trip.canceledAt   = new Date();
        await trip.save();

        await redisClient.del(REDIS_KEYS.ACTIVE_TRIP(tripId));
        await redisClient.del(`passenger:active_trip:${trip.passengerId}`);
        await redisClient.del(`driver:active_trip:${req.user.uuid}`);

        const rawMeta = await redisClient.get(REDIS_KEYS.DRIVER_META(req.user.uuid));
        if (rawMeta) {
            const meta       = JSON.parse(rawMeta);
            meta.isAvailable = true;
            meta.lastUpdated = new Date().toISOString();
            await redisClient.setex(REDIS_KEYS.DRIVER_META(req.user.uuid), 3600, JSON.stringify(meta));
        }
        await redisClient.sadd(REDIS_KEYS.AVAILABLE_DRIVERS, req.user.uuid.toString());

        const io = getIO();
        io.to(`passenger:${trip.passengerId}`).emit('trip:canceled', {
            tripId:     trip.id,
            canceledBy: 'DRIVER',
            reason,
        });

        console.log('✅ [DRIVER] Trip canceled, Redis cleaned');
        res.status(200).json({ message: 'Trip canceled', data: { trip } });

    } catch (error) {
        console.error('❌ [DRIVER] cancelTrip error:', error);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// STATS & HISTORY CONTROLLERS
// ═══════════════════════════════════════════════════════════════════════

exports.getStats = async (req, res, next) => {
    try {
        const driverId  = req.user.uuid;
        const today     = new Date(); today.setHours(0, 0, 0, 0);
        const tomorrow  = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
        const weekStart = new Date(today); weekStart.setDate(today.getDate() - today.getDay());

        const baseWhere = { driverId, status: 'COMPLETED' };

        const [todayTrips, todayEarnings, weekTrips, weekEarnings, totalTrips, totalEarnings] = await Promise.all([
            Trip.count({ where: { ...baseWhere, tripCompletedAt: { [Op.gte]: today, [Op.lt]: tomorrow } } }),
            Trip.sum('fareFinal',  { where: { ...baseWhere, tripCompletedAt: { [Op.gte]: today, [Op.lt]: tomorrow } } }),
            Trip.count({ where: { ...baseWhere, tripCompletedAt: { [Op.gte]: weekStart } } }),
            Trip.sum('fareFinal',  { where: { ...baseWhere, tripCompletedAt: { [Op.gte]: weekStart } } }),
            Trip.count({ where: baseWhere }),
            Trip.sum('fareFinal',  { where: baseWhere }),
        ]);

        res.status(200).json({
            message: 'Driver stats retrieved successfully',
            data: {
                today: { trips: todayTrips,  earnings: todayEarnings  || 0 },
                week:  { trips: weekTrips,   earnings: weekEarnings   || 0 },
                total: { trips: totalTrips,  earnings: totalEarnings  || 0 },
            },
        });

    } catch (error) {
        console.error('❌ [DRIVER] getStats error:', error);
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────
exports.getEarnings = async (req, res, next) => {
    try {
        console.log('💰 [DRIVER] getEarnings — Driver:', req.user.uuid);
        const { period = 'week' } = req.query;
        const driverId = req.user.uuid;

        const now        = new Date();
        const today      = new Date(now); today.setHours(0, 0, 0, 0);
        const tomorrow   = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
        const weekStart  = new Date(today); weekStart.setDate(today.getDate() - today.getDay());
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

        let dateFilter = {};
        if      (period === 'today') dateFilter = { [Op.gte]: today, [Op.lt]: tomorrow };
        else if (period === 'week')  dateFilter = { [Op.gte]: weekStart };
        else if (period === 'month') dateFilter = { [Op.gte]: monthStart };

        const where = {
            driverId,
            status: 'COMPLETED',
            ...(Object.keys(dateFilter).length ? { tripCompletedAt: dateFilter } : {}),
        };

        const trips = await Trip.findAll({
            where,
            attributes: ['id', 'fareEstimate', 'fareFinal', 'distanceM', 'durationS', 'tripCompletedAt', 'paymentMethod'],
            order:       [['tripCompletedAt', 'DESC']],
        });

        const total = trips.reduce((sum, t) => sum + (t.fareFinal || t.fareEstimate || 0), 0);

        const byDay = {};
        for (const t of trips) {
            if (!t.tripCompletedAt) continue;
            const day = t.tripCompletedAt.toISOString().split('T')[0];
            if (!byDay[day]) byDay[day] = { date: day, trips: 0, earnings: 0 };
            byDay[day].trips    += 1;
            byDay[day].earnings += (t.fareFinal || t.fareEstimate || 0);
        }

        res.status(200).json({
            message: 'Earnings retrieved',
            data: {
                period,
                total,
                tripCount: trips.length,
                currency:  'XAF',
                byDay:     Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date)),
                trips:     trips.map(t => ({
                    id:          t.id,
                    fare:        t.fareFinal || t.fareEstimate || 0,
                    distanceM:   t.distanceM,
                    durationS:   t.durationS,
                    completedAt: t.tripCompletedAt,
                    payment:     t.paymentMethod,
                })),
            },
        });

    } catch (error) {
        console.error('❌ [DRIVER] getEarnings error:', error);
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────
exports.getTripHistory = async (req, res, next) => {
    try {
        const { page = 1, limit = 20, status } = req.query;
        const driverId = req.user.uuid;
        const offset   = (page - 1) * limit;

        const where = { driverId };
        if (status) where.status = status;

        const { count, rows: trips } = await Trip.findAndCountAll({
            where,
            include: [{
                model:      Account,
                as:         'passenger',
                attributes: ['uuid', 'first_name', 'last_name', 'avatar_url'],
                required:   false,
            }],
            limit:  parseInt(limit),
            offset: parseInt(offset),
            order:  [['createdAt', 'DESC']],
        });

        res.status(200).json({
            message: 'Trip history retrieved',
            data: {
                trips,
                pagination: {
                    total:      count,
                    page:       parseInt(page),
                    limit:      parseInt(limit),
                    totalPages: Math.ceil(count / limit),
                },
            },
        });

    } catch (error) {
        console.error('❌ [DRIVER] getTripHistory error:', error);
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────
exports.getAllTrips = async (req, res, next) => {
    try {
        const driverId = req.user.uuid;
        const page   = Math.max(parseInt(req.query.page  || '1', 10), 1);
        const limit  = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
        const offset = (page - 1) * limit;

        const statusParam = (req.query.status || '').trim();
        const where       = { driverId };

        if (statusParam && statusParam.toLowerCase() !== 'all') {
            const statuses = statusParam.includes(',')
                ? statusParam.split(',').map(s => s.trim()).filter(Boolean)
                : [statusParam];
            where.status = { [Op.in]: statuses };
        } else if (!statusParam) {
            where.status = { [Op.in]: ['COMPLETED', 'CANCELED'] };
        }

        const from = req.query.from ? new Date(req.query.from) : null;
        const to   = req.query.to   ? new Date(req.query.to)   : null;

        if (from && !isNaN(from.getTime()) && to && !isNaN(to.getTime())) {
            where.createdAt = { [Op.between]: [from, to] };
        } else if (from && !isNaN(from.getTime())) {
            where.createdAt = { [Op.gte]: from };
        } else if (to && !isNaN(to.getTime())) {
            where.createdAt = { [Op.lte]: to };
        }

        const { count, rows } = await Trip.findAndCountAll({
            where,
            include: [{
                model:      Account,
                as:         'passenger',
                attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'],
                required:   false,
            }],
            order:  [['createdAt', 'DESC']],
            limit,
            offset,
        });

        const trips = rows.map(t => ({
            id:           t.id,
            status:       t.status,
            pickup:       { lat: t.pickupLat,  lng: t.pickupLng,  address: t.pickupAddress  },
            dropoff:      { lat: t.dropoffLat, lng: t.dropoffLng, address: t.dropoffAddress },
            distanceM:    t.distanceM,
            durationS:    t.durationS,
            fareEstimate: t.fareEstimate,
            fareFinal:    t.fareFinal,
            paymentMethod: t.paymentMethod,
            matchedAt:    t.matchedAt     || null,
            startedAt:    t.tripStartedAt || null,
            completedAt:  t.tripCompletedAt || null,
            canceledAt:   t.canceledAt    || null,
            canceledBy:   t.canceledBy    || null,
            cancelReason: t.cancelReason  || null,
            createdAt:    t.createdAt,
            updatedAt:    t.updatedAt,
            passenger: t.passenger ? {
                uuid:      t.passenger.uuid,
                firstName: t.passenger.first_name,
                lastName:  t.passenger.last_name,
                name:      `${t.passenger.first_name || ''} ${t.passenger.last_name || ''}`.trim(),
                phone:     t.passenger.phone_e164,
                avatar:    t.passenger.avatar_url,
            } : null,
        }));

        return res.status(200).json({
            message: 'Driver trips retrieved',
            data: {
                trips,
                filters: {
                    status: statusParam || 'COMPLETED,CANCELED',
                    from:   req.query.from || null,
                    to:     req.query.to   || null,
                },
                pagination: {
                    total:      count,
                    page,
                    limit,
                    totalPages: Math.ceil(count / limit),
                },
            },
        });

    } catch (error) {
        console.error('❌ [DRIVER] getAllTrips error:', error);
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────
exports.getTripDetails = async (req, res, next) => {
    try {
        const { tripId } = req.params;
        const trip = await Trip.findOne({ where: { id: tripId, driverId: req.user.uuid } });
        if (!trip) return res.status(404).json({ error: 'Trip not found or not assigned to you' });
        res.status(200).json({ message: 'Trip details retrieved', data: { trip } });
    } catch (error) {
        console.error('❌ [DRIVER] getTripDetails error:', error);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// PROFILE CONTROLLERS
// ═══════════════════════════════════════════════════════════════════════

exports.getProfile = async (req, res, next) => {
    try {
        const driver = await Account.findByPk(req.user.uuid, {
            attributes: { exclude: ['password_hash', 'password_algo'] },
            include: [{
                model:    DriverProfile,
                as:       'driverProfile',
                required: false,
            }],
        });
        if (!driver) return res.status(404).json({ error: 'Driver not found' });
        res.status(200).json({ message: 'Driver profile retrieved', data: { driver } });
    } catch (error) {
        console.error('❌ [DRIVER] getProfile error:', error);
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────
exports.updateProfile = async (req, res, next) => {
    try {
        console.log('✏️  [DRIVER] updateProfile — Driver:', req.user.uuid);

        const {
            first_name, last_name, email,
            vehicle_make_model, vehicle_color, vehicle_year,
            vehicle_plate, vehicle_type,
        } = req.body;

        const accountUpdates = {};
        if (first_name !== undefined) accountUpdates.first_name = first_name.trim();
        if (last_name  !== undefined) accountUpdates.last_name  = last_name.trim();
        if (email      !== undefined) accountUpdates.email      = email.trim().toLowerCase();

        const profileUpdates = {};
        if (vehicle_make_model !== undefined) profileUpdates.vehicle_make_model = vehicle_make_model;
        if (vehicle_color      !== undefined) profileUpdates.vehicle_color      = vehicle_color;
        if (vehicle_year       !== undefined) profileUpdates.vehicle_year       = parseInt(vehicle_year);
        if (vehicle_plate      !== undefined) profileUpdates.vehicle_plate      = vehicle_plate.toUpperCase().trim();
        if (vehicle_type       !== undefined) profileUpdates.vehicle_type       = vehicle_type;

        if (!Object.keys(accountUpdates).length && !Object.keys(profileUpdates).length) {
            return res.status(400).json({ error: 'No updatable fields provided' });
        }

        if (Object.keys(accountUpdates).length) {
            await Account.update(accountUpdates, { where: { uuid: req.user.uuid } });
        }
        if (Object.keys(profileUpdates).length) {
            await DriverProfile.update(profileUpdates, { where: { account_id: req.user.uuid } });
        }

        const updated = await Account.findByPk(req.user.uuid, {
            attributes: { exclude: ['password_hash', 'password_algo'] },
            include:    [{ model: DriverProfile, as: 'driverProfile', required: false }],
        });

        console.log('✅ [DRIVER] Profile updated successfully');
        res.status(200).json({ message: 'Profile updated successfully', data: { driver: updated } });

    } catch (error) {
        console.error('❌ [DRIVER] updateProfile error:', error);
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────
exports.getRatings = async (req, res, next) => {
    try {
        console.log('⭐ [DRIVER] getRatings — Driver:', req.user.uuid);
        const { page = 1, limit = 20 } = req.query;
        const driverId = req.user.uuid;
        const offset   = (parseInt(page) - 1) * parseInt(limit);

        const { count, rows: ratings } = await Rating.findAndCountAll({
            where: {
                ratedUser:  driverId,
                ratingType: 'PASSENGER_TO_DRIVER',
            },
            include: [{
                model:      Account,
                as:         'rater',
                attributes: ['uuid', 'first_name', 'last_name', 'avatar_url'],
                required:   false,
            }],
            order:  [['createdAt', 'DESC']],
            limit:  parseInt(limit),
            offset,
        });

        const average = count
            ? parseFloat((ratings.reduce((s, r) => s + r.rating, 0) / count).toFixed(2))
            : 0;

        const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        for (const r of ratings) {
            const star = Math.round(r.rating);
            if (distribution[star] !== undefined) distribution[star]++;
        }

        res.status(200).json({
            message: 'Ratings retrieved',
            data: {
                averageRating: average,
                totalRatings:  count,
                distribution,
                ratings: ratings.map(r => ({
                    id:        r.id,
                    rating:    r.rating,
                    review:    r.review || null,
                    createdAt: r.createdAt,
                    rater: r.rater ? {
                        uuid:      r.rater.uuid,
                        firstName: r.rater.first_name,
                        lastName:  r.rater.last_name,
                        avatar:    r.rater.avatar_url,
                    } : null,
                })),
                pagination: {
                    total:      count,
                    page:       parseInt(page),
                    limit:      parseInt(limit),
                    totalPages: Math.ceil(count / parseInt(limit)),
                },
            },
        });

    } catch (error) {
        console.error('❌ [DRIVER] getRatings error:', error);
        next(error);
    }
};