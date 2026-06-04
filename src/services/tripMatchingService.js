// src/services/tripMatchingService.js
'use strict';

const locationService                        = require('./locationService');
const { redisClient, REDIS_KEYS, redisHelpers } = require('../config/redis');
const {
    Trip, TripEvent, Account, DriverProfile,
    Rating, Driver, DriverWallet, EarningRule,
} = require('../models');
const { Op }    = require('sequelize');
const { v4: uuidv4 } = require('uuid');

// ── Notification service (lazy — avoids circular dep at startup) ──────────────
const getNotificationService = () => require('./NotificationService');

// ─── Shared cache key with EarningsEngineService ──────────────────────────────
const RULES_CACHE_KEY   = 'earnings:rules:active';
const RULES_CACHE_TTL_S = 300;

// ─── Fallback commission rate ─────────────────────────────────────────────────
const FALLBACK_COMMISSION_RATE = parseFloat(process.env.DEFAULT_COMMISSION_RATE || '0.10');

class TripMatchingService {

    constructor() {
        this.offerTtlMs     = parseInt(process.env.OFFER_TTL_MS            || 20000, 10);
        this.searchRadiusKm = parseFloat(process.env.DRIVER_SEARCH_RADIUS_KM || 5);

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔧 [TRIP-MATCHING] Config:');
        console.log('   OFFER_TTL_MS  :', this.offerTtlMs, 'ms');
        console.log('   SEARCH_RADIUS :', this.searchRadiusKm, 'km');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        this.activeTimeouts = new Map();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PUBLIC: BROADCAST TRIP TO NEARBY DRIVERS
    // ═══════════════════════════════════════════════════════════════════════

    async broadcastTripToDrivers(tripId, io) {
        try {
            console.log(`\n📢 [MATCHING] broadcastTripToDrivers(${tripId})`);

            const trip = await redisHelpers.getJson(REDIS_KEYS.ACTIVE_TRIP(tripId));
            if (!trip) {
                console.log(`❌ [MATCHING] Trip ${tripId} not found in Redis`);
                return { success: false, reason: 'Trip not found' };
            }
            if (trip.status !== 'SEARCHING') {
                console.log(`⚠️  [MATCHING] Trip ${tripId} status is ${trip.status}, expected SEARCHING`);
                return { success: false, reason: 'Trip not in searching status' };
            }

            const passengerAccount = await Account.findOne({
                where:      { uuid: trip.passengerId },
                attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'],
            });
            if (!passengerAccount) {
                console.error(`❌ [MATCHING] Passenger ${trip.passengerId} not found`);
                return { success: false, reason: 'Passenger not found' };
            }

            const passengerRating = await this._getPassengerRating(trip.passengerId);

            // ── STEP 1: Find nearby drivers ─────────────────────────────────
            const nearbyDrivers = await locationService.findNearbyDrivers(
                parseFloat(trip.pickupLng),
                parseFloat(trip.pickupLat),
                this.searchRadiusKm
            );

            if (!nearbyDrivers || nearbyDrivers.length === 0) {
                console.log(`❌ [MATCHING] No drivers near trip ${tripId}`);
                await redisClient.del(REDIS_KEYS.ACTIVE_TRIP(tripId));
                await redisClient.del(`passenger:active_trip:${trip.passengerId}`);
                return { success: false, reason: 'No drivers available', driversNotified: 0 };
            }

            console.log(`🔍 [MATCHING] ${nearbyDrivers.length} drivers found in radius`);

            // ── STEP 2: Filter by ride mode ─────────────────────────────────
            const nearbyDriverIds = nearbyDrivers.map(d => d.driverId);

            const rideReadyDrivers = await Driver.findAll({
                where: {
                    id:           { [Op.in]: nearbyDriverIds },
                    current_mode: 'ride',
                },
                attributes: ['id', 'current_mode'],
            });

            const rideReadyIds    = new Set(rideReadyDrivers.map(d => d.id));
            const rideModeDrivers = nearbyDrivers.filter(d => rideReadyIds.has(d.driverId));

            console.log(`✅ [MATCHING] ${rideModeDrivers.length}/${nearbyDrivers.length} drivers in ride mode`);

            if (rideModeDrivers.length === 0) {
                console.log(`❌ [MATCHING] No ride-mode drivers available for trip ${tripId}`);
                await redisClient.del(REDIS_KEYS.ACTIVE_TRIP(tripId));
                await redisClient.del(`passenger:active_trip:${trip.passengerId}`);
                return { success: false, reason: 'No drivers available', driversNotified: 0 };
            }

            // ── STEP 3: Wallet gate ─────────────────────────────────────────
            const fareEstimate       = Math.round(trip.fareEstimate || 0);
            const commissionRate     = await this._getCommissionRate(fareEstimate);
            const commissionRequired = Math.ceil(fareEstimate * commissionRate);

            console.log(`\n💰 [MATCHING] Wallet gate:`);
            console.log(`   Fare estimate     : ${fareEstimate} XAF`);
            console.log(`   Commission rate   : ${(commissionRate * 100).toFixed(1)}%`);
            console.log(`   Min balance needed: ${commissionRequired} XAF`);

            const rideModeDriverIds = rideModeDrivers.map(d => d.driverId);

            const wallets = await DriverWallet.findAll({
                where: {
                    driverId: { [Op.in]: rideModeDriverIds },
                    status:   'ACTIVE',
                },
                attributes: ['driverId', 'balance'],
            });

            const balanceMap = new Map(wallets.map(w => [w.driverId, w.balance]));

            const eligibleDrivers = rideModeDrivers.filter(d => {
                const balance  = balanceMap.get(d.driverId) ?? -1;
                const eligible = balance >= commissionRequired;
                if (!eligible) {
                    console.log(`   ⛔ Driver ${d.driverId} skipped — balance ${balance} XAF < ${commissionRequired} XAF required`);
                }
                return eligible;
            });

            console.log(`✅ [MATCHING] ${eligibleDrivers.length}/${rideModeDrivers.length} drivers have sufficient balance\n`);

            if (eligibleDrivers.length === 0) {
                console.log(`❌ [MATCHING] No drivers with sufficient wallet balance for trip ${tripId}`);
                await redisClient.del(REDIS_KEYS.ACTIVE_TRIP(tripId));
                await redisClient.del(`passenger:active_trip:${trip.passengerId}`);
                return { success: false, reason: 'No drivers available', driversNotified: 0 };
            }

            // ── STEP 4: Build trip offer payload ────────────────────────────
            const baseTripOffer = {
                tripId:        trip.id,
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
                distanceM:     trip.distanceM,
                durationS:     trip.durationS,
                fareEstimate:  trip.fareEstimate,
                fare_estimate: trip.fareEstimate,
                distance:      trip.distanceM,
                duration:      trip.durationS,
                paymentMethod: trip.paymentMethod,
                passenger: {
                    uuid:       passengerAccount.uuid,
                    name:       `${passengerAccount.first_name} ${passengerAccount.last_name}`.trim(),
                    firstName:  passengerAccount.first_name,
                    lastName:   passengerAccount.last_name,
                    first_name: passengerAccount.first_name,
                    last_name:  passengerAccount.last_name,
                    phone:      passengerAccount.phone_e164,
                    phone_e164: passengerAccount.phone_e164,
                    avatar:     passengerAccount.avatar_url,
                    avatar_url: passengerAccount.avatar_url,
                    rating:     passengerRating,
                },
                expiresAt: Date.now() + this.offerTtlMs,
                expiresIn: Math.floor(this.offerTtlMs / 1000),
                timestamp: new Date().toISOString(),
            };

            // ── STEP 5: Emit to each eligible driver ────────────────────────
            const notifiedDriverIds = [];

            for (const driver of eligibleDrivers) {
                const driverId = driver.driverId;
                try {
                    const offerWithDistance = {
                        ...baseTripOffer,
                        distanceToPickup:   Math.round(driver.distance * 1000),
                        distanceToPickupKm: driver.distance,
                    };

                    let emitted = false;

                    const driverRoom = `driver:${driverId}`;
                    if ((io.sockets.adapter.rooms.get(driverRoom)?.size || 0) > 0) {
                        io.to(driverRoom).emit('trip:new_request', offerWithDistance);
                        emitted = true;
                        console.log(`   ✅ → room ${driverRoom}`);
                    }

                    const userRoom = `user:${driverId}`;
                    if ((io.sockets.adapter.rooms.get(userRoom)?.size || 0) > 0) {
                        io.to(userRoom).emit('trip:new_request', offerWithDistance);
                        emitted = true;
                        console.log(`   ✅ → room ${userRoom}`);
                    }

                    const socketId = await redisClient.get(REDIS_KEYS.USER_SOCKET(driverId));
                    if (socketId && io.sockets.sockets.get(socketId)) {
                        io.to(socketId).emit('trip:new_request', offerWithDistance);
                        emitted = true;
                        console.log(`   ✅ → socket ${socketId}`);
                    }

                    if (emitted) {
                        notifiedDriverIds.push(driverId);
                        console.log(`📤 [MATCHING] Notified driver ${driverId} (${driver.distance.toFixed(2)} km away)`);

                        // ── 🔔 NOTIFICATION: Trip offer to driver ─────────────
                        // Fire-and-forget — socket is the primary real-time channel.
                        // Push notification is the fallback for drivers with app backgrounded.
                        getNotificationService().send({
                            accountUuid: driverId,
                            type:        'RIDE_TRIP_OFFER',
                            title:       '🚖 New trip offer!',
                            body:        `${trip.pickupAddress} → ${trip.dropoffAddress} · ${Math.round((trip.fareEstimate || 0)).toLocaleString()} XAF`,
                            data: {
                                screen:        'trip_offer',
                                trip_id:       String(trip.id),
                                fare_estimate: String(trip.fareEstimate || 0),
                                pickup:        trip.pickupAddress,
                                dropoff:       trip.dropoffAddress,
                            },
                        }).catch(e => console.warn(`⚠️  [MATCHING] Push to driver ${driverId} failed:`, e.message));

                    } else {
                        console.log(`⚠️  [MATCHING] Driver ${driverId} has no active socket — skipping`);
                    }

                } catch (emitError) {
                    console.error(`❌ [MATCHING] Error notifying driver ${driverId}:`, emitError.message);
                }
            }

            // ── STEP 6: Persist notified driver list to Redis ───────────────
            if (notifiedDriverIds.length > 0) {
                const ttlSeconds = Math.ceil(this.offerTtlMs / 1000) + 60;
                await redisHelpers.setJson(
                    REDIS_KEYS.TRIP_OFFERS(tripId),
                    {
                        drivers:         notifiedDriverIds,
                        notifiedDrivers: notifiedDriverIds,
                        broadcastAt:     Date.now(),
                        expiresAt:       Date.now() + this.offerTtlMs,
                    },
                    ttlSeconds
                );
                console.log(`✅ [MATCHING] Offers record saved — ${notifiedDriverIds.length} drivers`);
            }

            // ── STEP 7: Set expiry timeout ──────────────────────────────────
            console.log(`⏰ [MATCHING] Setting ${this.offerTtlMs}ms expiry for trip ${tripId}`);

            const timeoutId = setTimeout(async () => {
                console.log(`⏰ [MATCHING] Timeout fired for trip ${tripId}`);
                await this._checkTripTimeout(tripId, io);
                this.activeTimeouts.delete(tripId);
            }, this.offerTtlMs);

            this.activeTimeouts.set(tripId, timeoutId);

            await redisClient.set(
                `trip:timeout:${tripId}`,
                '1',
                'EX', Math.ceil(this.offerTtlMs / 1000) + 10
            );

            console.log(`✅ [MATCHING] Broadcast done — ${notifiedDriverIds.length} drivers notified`);

            return {
                success:         notifiedDriverIds.length > 0,
                driversNotified: notifiedDriverIds.length,
                drivers:         notifiedDriverIds,
                ...(notifiedDriverIds.length === 0 && { reason: 'No drivers available' }),
            };

        } catch (error) {
            console.error(`❌ [MATCHING] broadcastTripToDrivers error:`, error.message);
            console.error(error.stack);
            throw error;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PUBLIC: ACCEPT TRIP
    // ═══════════════════════════════════════════════════════════════════════

    async acceptTrip(tripId, driverId, io) {
        const lockKey   = REDIS_KEYS.TRIP_LOCK ? REDIS_KEYS.TRIP_LOCK(tripId) : `trip:lock:${tripId}`;
        const lockValue = uuidv4();

        try {
            console.log(`\n🤝 [MATCHING] acceptTrip(${tripId}, ${driverId})`);

            const lockAcquired = await redisClient.set(lockKey, lockValue, 'EX', 10, 'NX');
            if (!lockAcquired) {
                console.log(`⚠️  [MATCHING] Trip ${tripId} locked by another process`);
                return { success: false, reason: 'Trip already being accepted by another driver' };
            }

            try {
                const tripData = await redisHelpers.getJson(REDIS_KEYS.ACTIVE_TRIP(tripId));
                if (!tripData || tripData.status !== 'SEARCHING') {
                    return { success: false, reason: 'Trip no longer available' };
                }

                const driver = await Driver.findOne({
                    where:      { id: driverId },
                    attributes: ['id', 'current_mode', 'status'],
                });
                if (!driver || driver.current_mode !== 'ride') {
                    console.log(`⚠️  [MATCHING] Driver ${driverId} no longer in ride mode — rejecting`);
                    return { success: false, reason: 'Driver switched to delivery mode' };
                }

                // ── Re-check wallet ─────────────────────────────────────────
                const fareEstimate       = Math.round(tripData.fareEstimate || 0);
                const commissionRate     = await this._getCommissionRate(fareEstimate);
                const commissionRequired = Math.ceil(fareEstimate * commissionRate);

                const wallet = await DriverWallet.findOne({
                    where:      { driverId, status: 'ACTIVE' },
                    attributes: ['balance', 'status'],
                });

                const currentBalance = wallet?.balance ?? 0;
                if (currentBalance < commissionRequired) {
                    console.log(`⛔ [MATCHING] Driver ${driverId} wallet insufficient at accept time`);
                    return {
                        success: false,
                        reason:  'Insufficient wallet balance',
                        code:    'INSUFFICIENT_WALLET_BALANCE',
                    };
                }

                // ── Clear timeout ───────────────────────────────────────────
                const timeoutId = this.activeTimeouts.get(tripId);
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    this.activeTimeouts.delete(tripId);
                }
                await redisClient.del(`trip:timeout:${tripId}`);

                // ── Update Redis trip ───────────────────────────────────────
                tripData.driverId  = driverId;
                tripData.status    = 'MATCHED';
                tripData.matchedAt = new Date().toISOString();
                await redisHelpers.setJson(REDIS_KEYS.ACTIVE_TRIP(tripId), tripData, 7200);
                await locationService.updateDriverStatus(driverId, 'busy', tripId);

                // ── Notify other drivers offer expired ──────────────────────
                const offersKey  = REDIS_KEYS.TRIP_OFFERS(tripId);
                const offersData = await redisHelpers.getJson(offersKey);
                const others     = offersData?.notifiedDrivers || offersData?.drivers || [];

                for (const otherId of others) {
                    if (otherId !== driverId) {
                        io.to(`driver:${otherId}`).emit('trip:request_expired', { tripId });
                        io.to(`user:${otherId}`).emit('trip:request_expired', { tripId });
                        const sid = await redisClient.get(REDIS_KEYS.USER_SOCKET(otherId));
                        if (sid && io.sockets.sockets.get(sid)) {
                            io.to(sid).emit('trip:request_expired', { tripId });
                        }

                        // ── 🔔 NOTIFICATION: Offer expired to other drivers ─────
                        getNotificationService().send({
                            accountUuid: otherId,
                            type:        'RIDE_OFFER_EXPIRED',
                            title:       'Trip offer expired',
                            body:        'Another driver accepted this trip.',
                            data: {
                                screen:  'home',
                                trip_id: String(tripId),
                            },
                        }).catch(() => {});
                    }
                }
                await redisClient.del(offersKey);

                // ── Fetch driver details ────────────────────────────────────
                const driverAccount = await Account.findOne({
                    where:      { uuid: driverId },
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'],
                });
                const driverProfile = await DriverProfile.findOne({
                    where:      { account_id: driverId },
                    attributes: [
                        'rating_avg', 'rating_count', 'vehicle_type', 'vehicle_plate',
                        'vehicle_make_model', 'vehicle_color', 'vehicle_year', 'vehicle_photo_url',
                    ],
                });

                const driverInfo = driverAccount ? {
                    id:         driverAccount.uuid,
                    uuid:       driverAccount.uuid,
                    name:       `${driverAccount.first_name} ${driverAccount.last_name}`.trim(),
                    firstName:  driverAccount.first_name,
                    lastName:   driverAccount.last_name,
                    phone:      driverAccount.phone_e164,
                    avatar:     driverAccount.avatar_url || driverProfile?.avatar_url,
                    rating:     driverProfile?.rating_avg || null,
                    vehicle: {
                        type:      driverProfile?.vehicle_type       || null,
                        plate:     driverProfile?.vehicle_plate      || null,
                        makeModel: driverProfile?.vehicle_make_model || null,
                        color:     driverProfile?.vehicle_color      || null,
                        year:      driverProfile?.vehicle_year       || null,
                        photo:     driverProfile?.vehicle_photo_url  || null,
                    },
                } : { uuid: driverId, name: 'Driver' };

                const driverLocation = await locationService.getDriverLocation(driverId);

                // ── Fetch passenger info ────────────────────────────────────
                const passengerAccount = await Account.findOne({
                    where:      { uuid: tripData.passengerId },
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'],
                });
                const passengerRating = await this._getPassengerRating(tripData.passengerId);

                const passengerInfo = passengerAccount ? {
                    uuid:      passengerAccount.uuid,
                    name:      `${passengerAccount.first_name} ${passengerAccount.last_name}`.trim(),
                    firstName: passengerAccount.first_name,
                    lastName:  passengerAccount.last_name,
                    phone:     passengerAccount.phone_e164,
                    avatar:    passengerAccount.avatar_url,
                    rating:    passengerRating,
                } : { uuid: tripData.passengerId, name: 'Passenger' };

                // ── Emit driver assigned to passenger ───────────────────────
                const assignmentData = {
                    tripId,
                    driverId,
                    driver:         driverInfo,
                    driverLocation,
                    trip: {
                        id:           tripId,
                        status:       'MATCHED',
                        fareEstimate: tripData.fareEstimate,
                        distanceM:    tripData.distanceM,
                        durationS:    tripData.durationS,
                        pickup:  { lat: tripData.pickupLat,  lng: tripData.pickupLng,  address: tripData.pickupAddress  },
                        dropoff: { lat: tripData.dropoffLat, lng: tripData.dropoffLng, address: tripData.dropoffAddress },
                    },
                };

                io.to(`passenger:${tripData.passengerId}`).emit('trip:driver_assigned', assignmentData);
                io.to(`user:${tripData.passengerId}`).emit('trip:driver_assigned', assignmentData);

                const pSid = await redisClient.get(REDIS_KEYS.USER_SOCKET(tripData.passengerId));
                if (pSid && io.sockets.sockets.get(pSid)) {
                    io.to(pSid).emit('trip:driver_assigned', assignmentData);
                }

                // ── 🔔 NOTIFICATION: Driver matched → passenger ─────────────
                const driverName = driverInfo.firstName || driverInfo.name || 'Your driver';
                const plate      = driverInfo.vehicle?.plate || '';
                const makeModel  = driverInfo.vehicle?.makeModel || '';
                const vehicleStr = [makeModel, plate].filter(Boolean).join(' · ');

                getNotificationService().send({
                    accountUuid: tripData.passengerId,
                    type:        'RIDE_DRIVER_MATCHED',
                    title:       '🚖 Driver on the way!',
                    body:        vehicleStr
                        ? `${driverName} is heading to you · ${vehicleStr}`
                        : `${driverName} is heading to your pickup.`,
                    data: {
                        screen:    'trip_tracking',
                        trip_id:   String(tripId),
                        driver_id: driverId,
                    },
                }).catch(e => console.warn(`⚠️  [MATCHING] Push to passenger failed:`, e.message));

                console.log(`✅ [MATCHING] Trip ${tripId} matched with driver ${driverId}`);

                return {
                    success:   true,
                    driver:    driverInfo,
                    passenger: passengerInfo,
                };

            } finally {
                const cur = await redisClient.get(lockKey);
                if (cur === lockValue) await redisClient.del(lockKey);
            }

        } catch (error) {
            console.error(`❌ [MATCHING] acceptTrip error:`, error.message);
            throw error;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PRIVATE: GET COMMISSION RATE
    // ═══════════════════════════════════════════════════════════════════════

    async _getCommissionRate(fareEstimate) {
        let rules = [];

        try {
            const cached = await redisClient.get(RULES_CACHE_KEY);
            if (cached) {
                rules = JSON.parse(cached);
                console.log(`🧠 [MATCHING] Commission rules loaded from cache (${rules.length} rules)`);
            }
        } catch (e) {
            console.warn('⚠️  [MATCHING] Redis cache miss for rules — loading from DB');
        }

        if (rules.length === 0) {
            const today   = new Date().toISOString().split('T')[0];
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
            } catch (e) {
                console.warn('⚠️  [MATCHING] Failed to cache commission rules');
            }
        }

        for (const rule of rules) {
            if (rule.type !== 'COMMISSION_PERCENT') continue;
            if (!rule.isActive) continue;

            const c = rule.conditions || {};
            if (c.min_fare !== undefined && fareEstimate < c.min_fare) continue;
            if (c.max_fare !== undefined && fareEstimate > c.max_fare) continue;

            const rate = parseFloat(rule.value);
            console.log(`   💡 [MATCHING] Commission rule: "${rule.name}" (${(rate * 100).toFixed(1)}%)`);
            return rate;
        }

        console.log(`   ⚠️  [MATCHING] No rule matched — fallback ${(FALLBACK_COMMISSION_RATE * 100)}%`);
        return FALLBACK_COMMISSION_RATE;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PRIVATE: TRIP TIMEOUT HANDLER
    // ═══════════════════════════════════════════════════════════════════════

    async _checkTripTimeout(tripId, io) {
        try {
            console.log(`⏰ [MATCHING] _checkTripTimeout(${tripId})`);

            const timeoutExists = await redisClient.exists(`trip:timeout:${tripId}`);
            if (!timeoutExists) {
                console.log(`✅ [MATCHING] Timeout key gone — trip ${tripId} was accepted`);
                return;
            }

            const tripData = await redisHelpers.getJson(REDIS_KEYS.ACTIVE_TRIP(tripId));
            if (!tripData) {
                await redisClient.del(`trip:timeout:${tripId}`);
                return;
            }

            if (tripData.status !== 'SEARCHING') {
                await redisClient.del(`trip:timeout:${tripId}`);
                return;
            }

            console.log(`⏱️  [MATCHING] Trip ${tripId} timed out with no driver`);

            await redisClient.del(REDIS_KEYS.ACTIVE_TRIP(tripId));
            await redisClient.del(`passenger:active_trip:${tripData.passengerId}`);
            await redisClient.del(REDIS_KEYS.TRIP_OFFERS(tripId));
            await redisClient.del(`trip:timeout:${tripId}`);

            const noDriverPayload = {
                tripId,
                message:   'No drivers accepted your trip. Please try again.',
                timestamp: new Date().toISOString(),
            };

            io.to(`passenger:${tripData.passengerId}`).emit('trip:no_drivers', noDriverPayload);
            io.to(`user:${tripData.passengerId}`).emit('trip:no_drivers', noDriverPayload);

            const pSid = await redisClient.get(REDIS_KEYS.USER_SOCKET(tripData.passengerId));
            if (pSid && io.sockets.sockets.get(pSid)) {
                io.to(pSid).emit('trip:no_drivers', noDriverPayload);
            }

            console.log(`📤 [MATCHING] trip:no_drivers sent to passenger ${tripData.passengerId}`);

        } catch (error) {
            console.error(`❌ [MATCHING] _checkTripTimeout error:`, error.message);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PRIVATE: GET PASSENGER RATING
    // ═══════════════════════════════════════════════════════════════════════

    async _getPassengerRating(passengerId) {
        try {
            const rows = await Rating.findAll({
                where:      { ratedUser: passengerId, ratingType: 'DRIVER_TO_PASSENGER' },
                attributes: ['rating'],
            });
            if (!rows || rows.length === 0) return null;
            const avg = rows.reduce((s, r) => s + r.rating, 0) / rows.length;
            return parseFloat(avg.toFixed(1));
        } catch {
            return null;
        }
    }
}

module.exports = new TripMatchingService();