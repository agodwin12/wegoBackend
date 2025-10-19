// src/services/tripMatchingService.js
const locationService = require('./locationService');
const { redisClient, REDIS_KEYS, redisHelpers } = require('../config/redis');
const { Trip, TripEvent } = require('../models');
const { v4: uuidv4 } = require('uuid');

class TripMatchingService {
    constructor() {
        this.offerTtlMs = parseInt(process.env.OFFER_TTL_MS || 20000, 10);
        this.searchRadiusKm = parseFloat(process.env.DRIVER_SEARCH_RADIUS_KM || 5);
    }

    async broadcastTripToDrivers(tripId, io) {
        try {
            console.log(`📢 [MATCHING] Broadcasting trip ${tripId} to nearby drivers`);

            const trip = await redisHelpers.getJson(REDIS_KEYS.ACTIVE_TRIP(tripId));

            if (!trip) {
                console.log(`❌ [MATCHING] Trip ${tripId} not found in Redis`);
                return { success: false, reason: 'Trip not found' };
            }

            if (trip.status !== 'searching') {
                console.log(`⚠️ [MATCHING] Trip ${tripId} is not in searching status`);
                return { success: false, reason: 'Trip not in searching status' };
            }

            const nearbyDrivers = await locationService.findNearbyDrivers(
                parseFloat(trip.pickupLng),
                parseFloat(trip.pickupLat),
                this.searchRadiusKm
            );

            if (nearbyDrivers.length === 0) {
                console.log(`❌ [MATCHING] No drivers found near trip ${tripId}`);
                await redisClient.del(REDIS_KEYS.ACTIVE_TRIP(tripId));
                await redisClient.del(`passenger:active_trip:${trip.passengerId}`);
                return { success: false, reason: 'No drivers available', driversNotified: 0 };
            }

            console.log(`✅ [MATCHING] Found ${nearbyDrivers.length} drivers, broadcasting...`);

            const tripOffer = {
                tripId: trip.id,
                pickupLat: trip.pickupLat,
                pickupLng: trip.pickupLng,
                pickupAddress: trip.pickupAddress,
                dropoffLat: trip.dropoffLat,
                dropoffLng: trip.dropoffLng,
                dropoffAddress: trip.dropoffAddress,
                distance_m: trip.distance_m,
                duration_s: trip.duration_s,
                fare_estimate: trip.fare_estimate,
                payment_method: trip.payment_method,
                expiresAt: Date.now() + this.offerTtlMs
            };

            const notifiedDrivers = [];
            for (const driver of nearbyDrivers) {
                const socketId = await redisHelpers.getJson(REDIS_KEYS.USER_SOCKET(driver.driverId));

                if (socketId && io.sockets.sockets.get(socketId)) {
                    io.to(socketId).emit('trip:new_request', {
                        ...tripOffer,
                        distanceToPickup: driver.distance
                    });
                    notifiedDrivers.push(driver.driverId);
                    console.log(`📤 [MATCHING] Notified driver ${driver.driverId} (${driver.distance.toFixed(2)}km away)`);
                }
            }

            if (notifiedDrivers.length > 0) {
                await redisHelpers.setJson(
                    REDIS_KEYS.TRIP_OFFERS(tripId),
                    {
                        notifiedDrivers,
                        broadcastAt: Date.now(),
                        expiresAt: Date.now() + this.offerTtlMs
                    },
                    Math.ceil(this.offerTtlMs / 1000) + 60
                );
            }

            setTimeout(async () => {
                await this._checkTripTimeout(tripId);
            }, this.offerTtlMs);

            console.log(`✅ [MATCHING] Broadcast completed: ${notifiedDrivers.length} drivers notified`);
            return {
                success: true,
                driversNotified: notifiedDrivers.length,
                drivers: notifiedDrivers
            };
        } catch (error) {
            console.error(`❌ [MATCHING] Error broadcasting trip ${tripId}:`, error.message);
            throw error;
        }
    }

    async acceptTrip(tripId, driverId, io) {
        try {
            console.log(`🤝 [MATCHING] Driver ${driverId} attempting to accept trip ${tripId}`);

            const lockKey = REDIS_KEYS.TRIP_LOCK(tripId);
            const lockAcquired = await redisHelpers.acquireLock(lockKey, parseInt(process.env.LOCK_TTL_MS || 10000, 10));

            if (!lockAcquired) {
                console.log(`⚠️ [MATCHING] Trip ${tripId} is locked by another driver`);
                return { success: false, reason: 'Trip already being accepted by another driver' };
            }

            try {
                const tripData = await redisHelpers.getJson(REDIS_KEYS.ACTIVE_TRIP(tripId));

                if (!tripData) {
                    await redisHelpers.releaseLock(lockKey);
                    console.log(`❌ [MATCHING] Trip ${tripId} not found in Redis (may have expired)`);
                    return { success: false, reason: 'Trip no longer available' };
                }

                if (tripData.status !== 'searching') {
                    await redisHelpers.releaseLock(lockKey);
                    console.log(`⚠️ [MATCHING] Trip ${tripId} is no longer available (status: ${tripData.status})`);
                    return { success: false, reason: 'Trip no longer available' };
                }

                console.log(`💾 [MATCHING] Saving trip ${tripId} to DATABASE with matched status`);

                const trip = await Trip.create({
                    id: tripData.id,
                    passengerId: tripData.passengerId,
                    driverId,
                    status: 'matched',
                    pickupLat: tripData.pickupLat,
                    pickupLng: tripData.pickupLng,
                    pickupAddress: tripData.pickupAddress,
                    dropoffLat: tripData.dropoffLat,
                    dropoffLng: tripData.dropoffLng,
                    dropoffAddress: tripData.dropoffAddress,
                    routePolyline: tripData.routePolyline,
                    distance_m: tripData.distance_m,
                    duration_s: tripData.duration_s,
                    fare_estimate: tripData.fare_estimate,
                    payment_method: tripData.payment_method
                });

                console.log(`✅ [MATCHING] Trip ${tripId} saved to database`);

                await TripEvent.create({
                    id: uuidv4(),
                    tripId: trip.id,
                    type: 'trip_created',
                    payload: { passengerId: tripData.passengerId }
                });

                await TripEvent.create({
                    id: uuidv4(),
                    tripId: trip.id,
                    type: 'driver_matched',
                    payload: { driverId }
                });

                await locationService.updateDriverStatus(driverId, 'busy', tripId);

                tripData.driverId = driverId;
                tripData.status = 'matched';
                await redisHelpers.setJson(
                    REDIS_KEYS.ACTIVE_TRIP(tripId),
                    tripData,
                    3600
                );

                await redisClient.del(`passenger:active_trip:${tripData.passengerId}`);

                const offersKey = REDIS_KEYS.TRIP_OFFERS(tripId);
                const offers = await redisHelpers.getJson(offersKey);

                if (offers && offers.notifiedDrivers) {
                    for (const notifiedDriverId of offers.notifiedDrivers) {
                        if (notifiedDriverId !== driverId) {
                            const socketId = await redisHelpers.getJson(REDIS_KEYS.USER_SOCKET(notifiedDriverId));
                            if (socketId && io.sockets.sockets.get(socketId)) {
                                io.to(socketId).emit('trip:request_expired', { tripId });
                                console.log(`📤 [MATCHING] Notified driver ${notifiedDriverId} that trip is no longer available`);
                            }
                        }
                    }
                }

                const passengerSocketId = await redisHelpers.getJson(REDIS_KEYS.USER_SOCKET(tripData.passengerId));
                if (passengerSocketId && io.sockets.sockets.get(passengerSocketId)) {
                    const driverLocation = await locationService.getDriverLocation(driverId);
                    io.to(passengerSocketId).emit('trip:driver_assigned', {
                        tripId,
                        driverId,
                        trip: {
                            id: trip.id,
                            status: trip.status,
                            pickup: {
                                lat: trip.pickupLat,
                                lng: trip.pickupLng,
                                address: trip.pickupAddress
                            },
                            dropoff: {
                                lat: trip.dropoffLat,
                                lng: trip.dropoffLng,
                                address: trip.dropoffAddress
                            }
                        },
                        driverLocation
                    });
                    console.log(`📤 [MATCHING] Notified passenger ${tripData.passengerId} of driver assignment`);
                }

                await redisClient.del(offersKey);
                await redisHelpers.releaseLock(lockKey);

                console.log(`✅ [MATCHING] Trip ${tripId} successfully matched with driver ${driverId}`);
                return { success: true, trip };
            } catch (error) {
                await redisHelpers.releaseLock(lockKey);
                throw error;
            }
        } catch (error) {
            console.error(`❌ [MATCHING] Error accepting trip ${tripId}:`, error.message);
            throw error;
        }
    }

    async _checkTripTimeout(tripId) {
        try {
            const tripData = await redisHelpers.getJson(REDIS_KEYS.ACTIVE_TRIP(tripId));

            if (!tripData) {
                console.log(`⏱️ [MATCHING] Trip ${tripId} already removed from Redis`);
                return;
            }

            if (tripData.status === 'searching') {
                console.log(`⏱️ [MATCHING] Trip ${tripId} timed out, no driver accepted`);

                await redisClient.del(REDIS_KEYS.ACTIVE_TRIP(tripId));
                await redisClient.del(`passenger:active_trip:${tripData.passengerId}`);
                await redisClient.del(REDIS_KEYS.TRIP_OFFERS(tripId));

                const passengerSocketId = await redisHelpers.getJson(REDIS_KEYS.USER_SOCKET(tripData.passengerId));
                if (passengerSocketId) {
                    const io = require('../app').io;
                    if (io && io.sockets.sockets.get(passengerSocketId)) {
                        io.to(passengerSocketId).emit('trip:no_drivers', {
                            tripId,
                            message: 'No drivers accepted your trip. Please try again.'
                        });
                        console.log(`📤 [MATCHING] Notified passenger of timeout`);
                    }
                }

                console.log(`🗑️ [MATCHING] Trip ${tripId} removed from Redis (no database record)`);
            }
        } catch (error) {
            console.error(`❌ [MATCHING] Error checking timeout for trip ${tripId}:`, error.message);
        }
    }
}

module.exports = new TripMatchingService();