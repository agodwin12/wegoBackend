// src/services/tripMatchingService.js

const locationService = require('./locationService');
const { redisClient, REDIS_KEYS, redisHelpers } = require('../config/redis');
const { Trip, TripEvent, Account, DriverProfile, Rating, Driver } = require('../models');
const { v4: uuidv4 } = require('uuid');

class TripMatchingService {
    constructor() {
        this.offerTtlMs      = parseInt(process.env.OFFER_TTL_MS       || 20000, 10);
        this.searchRadiusKm  = parseFloat(process.env.DRIVER_SEARCH_RADIUS_KM || 5);

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔧 [TRIP-MATCHING] Config:');
        console.log('   OFFER_TTL_MS:', this.offerTtlMs, 'ms');
        console.log('   SEARCH_RADIUS:', this.searchRadiusKm, 'km');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        // In-memory map of tripId → setTimeout handle
        this.activeTimeouts = new Map();
    }

    // ═══════════════════════════════════════════════════════════════════
    // BROADCAST TRIP TO NEARBY DRIVERS
    // ═══════════════════════════════════════════════════════════════════
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

            // ── Fetch passenger info ────────────────────────────────────
            const passengerAccount = await Account.findOne({
                where:      { uuid: trip.passengerId },
                attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'],
            });

            if (!passengerAccount) {
                console.error(`❌ [MATCHING] Passenger ${trip.passengerId} not found`);
                return { success: false, reason: 'Passenger not found' };
            }

            const passengerRating = await this._getPassengerRating(trip.passengerId);

            // ── Find nearby drivers from Redis geospatial index ─────────
            // NOTE: Redis returns ALL nearby online drivers regardless of mode.
            // We filter by current_mode='ride' in the next step.
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

            console.log(`🔍 [MATCHING] ${nearbyDrivers.length} drivers found in radius — filtering by mode...`);

            // ── ✅ FILTER: Only drivers in 'ride' mode ──────────────────
            // Redis geo index contains ALL online drivers (ride + delivery).
            // We must exclude delivery-mode drivers from ride requests.
            const nearbyDriverIds = nearbyDrivers.map(d => d.driverId);

            const rideReadyDrivers = await Driver.findAll({
                where: {
                    id:           nearbyDriverIds,
                    current_mode: 'ride',   // ✅ KEY FILTER — exclude delivery mode drivers
                },
                attributes: ['id', 'current_mode'],
            });

            // Build a Set for O(1) lookup
            const rideReadyIds = new Set(rideReadyDrivers.map(d => d.id));

            // Keep only drivers who are in ride mode
            const filteredDrivers = nearbyDrivers.filter(d => rideReadyIds.has(d.driverId));

            console.log(`✅ [MATCHING] ${filteredDrivers.length}/${nearbyDrivers.length} drivers in ride mode`);

            if (filteredDrivers.length === 0) {
                console.log(`❌ [MATCHING] No ride-mode drivers available for trip ${tripId}`);
                await redisClient.del(REDIS_KEYS.ACTIVE_TRIP(tripId));
                await redisClient.del(`passenger:active_trip:${trip.passengerId}`);
                return { success: false, reason: 'No drivers available', driversNotified: 0 };
            }

            // ── Build trip offer payload ────────────────────────────────
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

                distanceM:    trip.distanceM,
                durationS:    trip.durationS,
                fareEstimate: trip.fareEstimate,
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

            // ── Emit to each filtered (ride-mode) driver ────────────────
            const notifiedDriverIds = [];

            for (const driver of filteredDrivers) {
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
                    } else {
                        console.log(`⚠️  [MATCHING] Driver ${driverId} has no active socket — skipping`);
                    }

                } catch (emitError) {
                    console.error(`❌ [MATCHING] Error notifying driver ${driverId}:`, emitError.message);
                }
            }

            // ── Save notified drivers to Redis ──────────────────────────
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

            // ── Set expiry timeout ──────────────────────────────────────
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

    // ═══════════════════════════════════════════════════════════════════
    // ACCEPT TRIP
    // ═══════════════════════════════════════════════════════════════════
    async acceptTrip(tripId, driverId, io) {
        const lockKey = REDIS_KEYS.TRIP_LOCK ? REDIS_KEYS.TRIP_LOCK(tripId) : `trip:lock:${tripId}`;
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
                if (!tripData) {
                    return { success: false, reason: 'Trip no longer available' };
                }
                if (tripData.status !== 'SEARCHING') {
                    return { success: false, reason: 'Trip no longer available' };
                }

                // ── ✅ VERIFY driver is still in ride mode at accept time ──
                // Edge case: driver could switch mode between offer and accept
                const driver = await Driver.findOne({
                    where: { id: driverId },
                    attributes: ['id', 'current_mode', 'status'],
                });

                if (!driver || driver.current_mode !== 'ride') {
                    console.log(`⚠️  [MATCHING] Driver ${driverId} is no longer in ride mode — rejecting accept`);
                    return { success: false, reason: 'Driver switched to delivery mode' };
                }

                // ── Clear timeout ───────────────────────────────────────
                const timeoutId = this.activeTimeouts.get(tripId);
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    this.activeTimeouts.delete(tripId);
                    console.log(`✅ [MATCHING] JS timeout cleared for trip ${tripId}`);
                }
                await redisClient.del(`trip:timeout:${tripId}`);

                // ── Update Redis trip ───────────────────────────────────
                tripData.driverId  = driverId;
                tripData.status    = 'MATCHED';
                tripData.matchedAt = new Date().toISOString();
                await redisHelpers.setJson(REDIS_KEYS.ACTIVE_TRIP(tripId), tripData, 7200);

                await locationService.updateDriverStatus(driverId, 'busy', tripId);

                // ── Notify other drivers their offer expired ────────────
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
                    }
                }

                await redisClient.del(offersKey);

                // ── Fetch driver details ────────────────────────────────
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

                // ── Fetch passenger info ────────────────────────────────
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

                // ── Notify passenger ────────────────────────────────────
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

    // ═══════════════════════════════════════════════════════════════════
    // TRIP TIMEOUT HANDLER
    // ═══════════════════════════════════════════════════════════════════
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
                console.log(`⚠️  [MATCHING] Trip ${tripId} already gone from Redis`);
                await redisClient.del(`trip:timeout:${tripId}`);
                return;
            }

            if (tripData.status !== 'SEARCHING') {
                console.log(`✅ [MATCHING] Trip ${tripId} has status ${tripData.status} — no cleanup needed`);
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
            console.log(`🗑️  [MATCHING] Trip ${tripId} cleaned from Redis`);

        } catch (error) {
            console.error(`❌ [MATCHING] _checkTripTimeout error:`, error.message);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // HELPER: Real passenger rating from DB
    // ═══════════════════════════════════════════════════════════════════
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