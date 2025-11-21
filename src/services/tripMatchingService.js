// src/services/tripMatchingService.js
const locationService = require('./locationService');
const { redisClient, REDIS_KEYS, redisHelpers } = require('../config/redis');
const { Trip, TripEvent, Account, DriverProfile } = require('../models');
const { v4: uuidv4 } = require('uuid');

class TripMatchingService {
    constructor() {
        this.offerTtlMs = parseInt(process.env.OFFER_TTL_MS || 20000, 10);
        this.searchRadiusKm = parseFloat(process.env.DRIVER_SEARCH_RADIUS_KM || 5);

        // 🔍 DEBUG: Log the timeout value
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔧 [TRIP-MATCHING-SERVICE] Configuration:');
        console.log('   OFFER_TTL_MS from env:', process.env.OFFER_TTL_MS);
        console.log('   Parsed offerTtlMs:', this.offerTtlMs);
        console.log('   Timeout in minutes:', (this.offerTtlMs / 60000).toFixed(2));
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        // ✅ NEW: Store active timeouts in memory
        this.activeTimeouts = new Map();
    }

    async broadcastTripToDrivers(tripId, io) {
        try {
            console.log(`📢 [MATCHING] Broadcasting trip ${tripId} to nearby drivers`);

            const trip = await redisHelpers.getJson(REDIS_KEYS.ACTIVE_TRIP(tripId));

            if (!trip) {
                console.log(`❌ [MATCHING] Trip ${tripId} not found in Redis`);
                return { success: false, reason: 'Trip not found' };
            }

            if (trip.status !== 'SEARCHING') {
                console.log(`⚠️ [MATCHING] Trip ${tripId} is not in SEARCHING status`);
                return { success: false, reason: 'Trip not in searching status' };
            }

            // ═══════════════════════════════════════════════════════════
            // 🚨 FETCH PASSENGER INFORMATION
            // ═══════════════════════════════════════════════════════════
            console.log(`🔍 [MATCHING] Fetching passenger info for ${trip.passengerId}`);

            const passengerAccount = await Account.findOne({
                where: { uuid: trip.passengerId },
                attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url']
            });

            if (!passengerAccount) {
                console.error(`❌ [MATCHING] Passenger account not found: ${trip.passengerId}`);
                return { success: false, reason: 'Passenger not found' };
            }

            console.log(`✅ [MATCHING] Passenger found: ${passengerAccount.first_name} ${passengerAccount.last_name}`);

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

            // ═══════════════════════════════════════════════════════════
            // 🎯 BUILD TRIP OFFER WITH PASSENGER INFO
            // ═══════════════════════════════════════════════════════════
            const tripOffer = {
                tripId: trip.id,

                // Pickup location
                pickup: {
                    lat: trip.pickupLat,
                    lng: trip.pickupLng,
                    address: trip.pickupAddress,
                },

                // Dropoff location
                dropoff: {
                    lat: trip.dropoffLat,
                    lng: trip.dropoffLng,
                    address: trip.dropoffAddress,
                },

                // Trip details
                distance: trip.distanceM,
                distanceM: trip.distanceM,
                duration: trip.durationS,
                durationS: trip.durationS,
                fareEstimate: trip.fareEstimate,
                fare_estimate: trip.fareEstimate,
                paymentMethod: trip.paymentMethod,

                // 🎯 PASSENGER INFORMATION
                passenger: {
                    uuid: passengerAccount.uuid,
                    name: `${passengerAccount.first_name} ${passengerAccount.last_name}`.trim(),
                    firstName: passengerAccount.first_name,
                    lastName: passengerAccount.last_name,
                    first_name: passengerAccount.first_name,
                    last_name: passengerAccount.last_name,
                    phone: passengerAccount.phone_e164,
                    phone_e164: passengerAccount.phone_e164,
                    avatar: passengerAccount.avatar_url,
                    avatar_url: passengerAccount.avatar_url,
                    rating: 5.0,
                },

                // Expiry
                expiresAt: Date.now() + this.offerTtlMs,
                expiresIn: Math.floor(this.offerTtlMs / 1000),
                timestamp: new Date().toISOString(),
            };

            console.log(`📦 [MATCHING] Trip offer prepared with passenger: ${tripOffer.passenger.name}`);

            const notifiedDrivers = [];

            // ═══════════════════════════════════════════════════════════
            // 📤 EMIT TO EACH DRIVER
            // ═══════════════════════════════════════════════════════════
            for (const driver of nearbyDrivers) {
                try {
                    const driverId = driver.driverId;

                    console.log(`🔍 [MATCHING] Attempting to notify driver ${driverId}`);

                    const socketId = await redisClient.get(REDIS_KEYS.USER_SOCKET(driverId));
                    console.log(`   Socket ID from Redis: ${socketId || 'NOT FOUND'}`);

                    if (socketId) {
                        const socket = io.sockets.sockets.get(socketId);
                        console.log(`   Socket connected: ${socket ? 'YES' : 'NO'}`);
                        if (socket) {
                            console.log(`   Socket rooms: ${Array.from(socket.rooms).join(', ')}`);
                        }
                    }

                    // 🎯 ADD DISTANCE TO PICKUP FOR THIS SPECIFIC DRIVER
                    const tripOfferWithDistance = {
                        ...tripOffer,
                        distanceToPickup: Math.round(driver.distance * 1000),
                        distanceToPickupKm: driver.distance,
                    };

                    let emitted = false;

                    // Try emitting to driver room
                    const driverRoom = `driver:${driverId}`;
                    const roomSize = io.sockets.adapter.rooms.get(driverRoom)?.size || 0;
                    console.log(`   Room ${driverRoom} has ${roomSize} members`);

                    if (roomSize > 0) {
                        io.to(driverRoom).emit('trip:new_request', tripOfferWithDistance);
                        console.log(`   ✅ Emitted to room: ${driverRoom}`);
                        emitted = true;
                    }

                    // Try emitting to user room
                    const userRoom = `user:${driverId}`;
                    const userRoomSize = io.sockets.adapter.rooms.get(userRoom)?.size || 0;
                    console.log(`   Room ${userRoom} has ${userRoomSize} members`);

                    if (userRoomSize > 0) {
                        io.to(userRoom).emit('trip:new_request', tripOfferWithDistance);
                        console.log(`   ✅ Emitted to room: ${userRoom}`);
                        emitted = true;
                    }

                    // Try emitting to socket ID directly
                    if (socketId && io.sockets.sockets.get(socketId)) {
                        io.to(socketId).emit('trip:new_request', tripOfferWithDistance);
                        console.log(`   ✅ Emitted to socket ID: ${socketId}`);
                        emitted = true;
                    }

                    if (emitted) {
                        notifiedDrivers.push(driverId);
                        console.log(`📤 [MATCHING] ✅ Successfully notified driver ${driverId}`);
                        console.log(`   Distance to pickup: ${driver.distance.toFixed(2)} km`);
                        console.log(`   Passenger: ${tripOffer.passenger.name}`);
                    } else {
                        console.log(`⚠️ [MATCHING] Could not notify driver ${driverId} - no active connection`);
                    }

                } catch (emitError) {
                    console.error(`❌ [MATCHING] Error notifying driver ${driver.driverId}:`, emitError.message);
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

            // ═══════════════════════════════════════════════════════════
            // 🔥 CRITICAL FIX: Store timeout reference so it can be canceled
            // ═══════════════════════════════════════════════════════════
            console.log(`⏰ [MATCHING] Setting ${this.offerTtlMs}ms timeout for trip ${tripId}`);

            const timeoutId = setTimeout(async () => {
                console.log(`⏰ [MATCHING] Timeout triggered for trip ${tripId}`);
                await this._checkTripTimeout(tripId, io);

                // Clean up the timeout reference
                this.activeTimeouts.delete(tripId);
            }, this.offerTtlMs);

            // Store the timeout reference
            this.activeTimeouts.set(tripId, timeoutId);

            // Also store a flag in Redis for redundancy
            await redisClient.set(`trip:timeout:${tripId}`, '1', 'EX', Math.ceil(this.offerTtlMs / 1000) + 10);

            console.log(`✅ [MATCHING] Timeout stored for trip ${tripId}`);

            console.log(`✅ [MATCHING] Broadcast completed: ${notifiedDrivers.length} drivers notified`);
            console.log(`   Passenger: ${tripOffer.passenger.name}`);
            console.log(`   Fare: ${tripOffer.fareEstimate} XAF`);
            console.log(`   Distance: ${(tripOffer.distanceM / 1000).toFixed(2)} km`);

            return {
                success: true,
                driversNotified: notifiedDrivers.length,
                drivers: notifiedDrivers
            };
        } catch (error) {
            console.error(`❌ [MATCHING] Error broadcasting trip ${tripId}:`, error.message);
            console.error(error.stack);
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

                if (tripData.status !== 'SEARCHING') {
                    await redisHelpers.releaseLock(lockKey);
                    console.log(`⚠️ [MATCHING] Trip ${tripId} is no longer available (status: ${tripData.status})`);
                    return { success: false, reason: 'Trip no longer available' };
                }

                // ═══════════════════════════════════════════════════════════
                // 🔥 CRITICAL FIX: Clear the expiration timeout
                // ═══════════════════════════════════════════════════════════
                console.log(`⏰ [MATCHING] Clearing expiration timeout for trip ${tripId}`);

                // 1️⃣ Clear the JavaScript timeout
                const timeoutId = this.activeTimeouts.get(tripId);
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    this.activeTimeouts.delete(tripId);
                    console.log(`✅ [MATCHING] JavaScript timeout cleared for trip ${tripId}`);
                } else {
                    console.log(`⚠️ [MATCHING] No active timeout found in memory for trip ${tripId}`);
                }

                // 2️⃣ Clear the Redis timeout flag
                const timeoutKey = `trip:timeout:${tripId}`;
                const deleted = await redisClient.del(timeoutKey);

                if (deleted > 0) {
                    console.log(`✅ [MATCHING] Redis timeout flag cleared for trip ${tripId}`);
                } else {
                    console.log(`⚠️ [MATCHING] No Redis timeout flag found for trip ${tripId}`);
                }

                console.log(`✅ [MATCHING] Trip ${tripId} timeout fully cleared - trip will NOT expire`);

                console.log(`💾 [MATCHING] Saving trip ${tripId} to DATABASE with matched status`);

                const trip = await Trip.create({
                    id: tripData.id,
                    passengerId: tripData.passengerId,
                    driverId,
                    status: 'MATCHED',
                    pickupLat: tripData.pickupLat,
                    pickupLng: tripData.pickupLng,
                    pickupAddress: tripData.pickupAddress,
                    dropoffLat: tripData.dropoffLat,
                    dropoffLng: tripData.dropoffLng,
                    dropoffAddress: tripData.dropoffAddress,
                    routePolyline: tripData.routePolyline,
                    distanceM: tripData.distanceM,
                    durationS: tripData.durationS,
                    fareEstimate: tripData.fareEstimate,
                    paymentMethod: tripData.paymentMethod
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
                tripData.status = 'MATCHED';

                // Store with longer TTL since trip is now active
                await redisHelpers.setJson(
                    REDIS_KEYS.ACTIVE_TRIP(tripId),
                    tripData,
                    7200 // 2 hours instead of 1 hour for active trips
                );

                await redisClient.del(`passenger:active_trip:${tripData.passengerId}`);

                const offersKey = REDIS_KEYS.TRIP_OFFERS(tripId);
                const offers = await redisHelpers.getJson(offersKey);

                if (offers && offers.notifiedDrivers) {
                    for (const notifiedDriverId of offers.notifiedDrivers) {
                        if (notifiedDriverId !== driverId) {
                            io.to(`driver:${notifiedDriverId}`).emit('trip:request_expired', { tripId });
                            io.to(`user:${notifiedDriverId}`).emit('trip:request_expired', { tripId });

                            const socketId = await redisClient.get(REDIS_KEYS.USER_SOCKET(notifiedDriverId));
                            if (socketId && io.sockets.sockets.get(socketId)) {
                                io.to(socketId).emit('trip:request_expired', { tripId });
                            }

                            console.log(`📤 [MATCHING] Notified driver ${notifiedDriverId} that trip is no longer available`);
                        }
                    }
                }

                // ═══════════════════════════════════════════════════════════
                // 🚨 NEW: Fetch COMPLETE passenger information for driver
                // ═══════════════════════════════════════════════════════════
                console.log(`🔍 [MATCHING] Fetching complete passenger information for ${tripData.passengerId}`);

                const passengerAccount = await Account.findOne({
                    where: { uuid: tripData.passengerId },
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url']
                });

                if (!passengerAccount) {
                    console.error(`❌ [MATCHING] Passenger account not found: ${tripData.passengerId}`);
                }

                const passengerInfo = passengerAccount ? {
                    uuid: passengerAccount.uuid,
                    name: `${passengerAccount.first_name} ${passengerAccount.last_name}`.trim(),
                    firstName: passengerAccount.first_name,
                    lastName: passengerAccount.last_name,
                    first_name: passengerAccount.first_name,
                    last_name: passengerAccount.last_name,
                    phone: passengerAccount.phone_e164,
                    phone_e164: passengerAccount.phone_e164,
                    avatar: passengerAccount.avatar_url,
                    avatar_url: passengerAccount.avatar_url,
                    rating: 5.0,
                } : {
                    uuid: tripData.passengerId,
                    name: 'Passenger',
                    firstName: 'Passenger',
                    lastName: '',
                    phone: '',
                    rating: 5.0,
                };

                console.log(`✅ [MATCHING] Passenger info compiled: ${passengerInfo.name}`);

                // ═══════════════════════════════════════════════════════════
                // 🚨 Fetch COMPLETE driver information
                // ═══════════════════════════════════════════════════════════

                console.log(`🔍 [MATCHING] Fetching complete driver information for ${driverId}`);

                const driverAccount = await Account.findOne({
                    where: { uuid: driverId },
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url']
                });

                const driverProfile = await DriverProfile.findOne({
                    where: { account_id: driverId },
                    attributes: [
                        'rating_avg',
                        'rating_count',
                        'vehicle_type',
                        'vehicle_plate',
                        'vehicle_make_model',
                        'vehicle_color',
                        'vehicle_year',
                        'vehicle_photo_url',
                        'avatar_url'
                    ]
                });

                if (!driverAccount) {
                    console.error(`❌ [MATCHING] Driver account not found: ${driverId}`);
                    await redisHelpers.releaseLock(lockKey);
                    return { success: false, reason: 'Driver account not found' };
                }

                // Build comprehensive driver data object
                const driverInfo = {
                    id: driverAccount.uuid,
                    uuid: driverAccount.uuid,
                    firstName: driverAccount.first_name,
                    lastName: driverAccount.last_name,
                    first_name: driverAccount.first_name,
                    last_name: driverAccount.last_name,
                    name: `${driverAccount.first_name} ${driverAccount.last_name}`,
                    phone: driverAccount.phone_e164,
                    phone_e164: driverAccount.phone_e164,
                    avatar: driverAccount.avatar_url || driverProfile?.avatar_url,
                    avatar_url: driverAccount.avatar_url || driverProfile?.avatar_url,
                    rating: driverProfile?.rating_avg || 5.0,
                    rating_avg: driverProfile?.rating_avg || 5.0,
                    rating_count: driverProfile?.rating_count || 0,
                    // 🚗 COMPLETE Vehicle information
                    vehicle: {
                        type: driverProfile?.vehicle_type || 'Standard',
                        plate: driverProfile?.vehicle_plate || 'N/A',
                        makeModel: driverProfile?.vehicle_make_model || 'Vehicle',
                        color: driverProfile?.vehicle_color || 'Unknown',
                        year: driverProfile?.vehicle_year || null,
                        photo: driverProfile?.vehicle_photo_url || null,
                    },
                    // Backward compatibility fields
                    vehicleType: driverProfile?.vehicle_type || 'Standard',
                    vehiclePlate: driverProfile?.vehicle_plate || 'N/A',
                    vehicleMakeModel: driverProfile?.vehicle_make_model || 'Vehicle',
                    vehicleColor: driverProfile?.vehicle_color || 'Unknown',
                    vehicleYear: driverProfile?.vehicle_year || null,
                };

                console.log(`✅ [MATCHING] Driver info compiled:`, {
                    name: `${driverInfo.firstName} ${driverInfo.lastName}`,
                    phone: driverInfo.phone,
                    rating: driverInfo.rating,
                    vehicle: driverInfo.vehicle.type,
                    plate: driverInfo.vehicle.plate
                });

                // Get driver location
                const driverLocation = await locationService.getDriverLocation(driverId);

                // Build assignment data with COMPLETE driver and passenger information
                const assignmentData = {
                    tripId,
                    driverId,
                    driver: driverInfo, // 🎯 COMPLETE driver object
                    driverLocation,
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
                        },
                        fareEstimate: trip.fareEstimate,
                        distanceM: trip.distanceM,
                        durationS: trip.durationS,
                    }
                };

                console.log(`📤 [MATCHING] Sending driver assignment to passenger ${tripData.passengerId}`);

                // Emit to all possible passenger connections
                io.to(`passenger:${tripData.passengerId}`).emit('trip:driver_assigned', assignmentData);
                io.to(`user:${tripData.passengerId}`).emit('trip:driver_assigned', assignmentData);

                const passengerSocketId = await redisClient.get(REDIS_KEYS.USER_SOCKET(tripData.passengerId));
                if (passengerSocketId && io.sockets.sockets.get(passengerSocketId)) {
                    io.to(passengerSocketId).emit('trip:driver_assigned', assignmentData);
                }

                console.log(`✅ [MATCHING] Notified passenger with complete driver info`);

                await redisClient.del(offersKey);
                await redisHelpers.releaseLock(lockKey);

                console.log(`✅ [MATCHING] Trip ${tripId} successfully matched with driver ${driverId}`);

                // Return with BOTH driver and passenger info
                return {
                    success: true,
                    trip,
                    driver: driverInfo,
                    passenger: passengerInfo // ✅ Include passenger info
                };
            } catch (error) {
                await redisHelpers.releaseLock(lockKey);
                throw error;
            }
        } catch (error) {
            console.error(`❌ [MATCHING] Error accepting trip ${tripId}:`, error.message);
            throw error;
        }
    }

    async _checkTripTimeout(tripId, io) {
        try {
            console.log(`⏰ [MATCHING] Checking timeout for trip ${tripId}`);

            // Check if timeout was already cleared
            const timeoutKey = `trip:timeout:${tripId}`;
            const timeoutExists = await redisClient.exists(timeoutKey);

            if (!timeoutExists) {
                console.log(`✅ [MATCHING] Timeout was cleared for trip ${tripId} - trip was accepted`);
                return;
            }

            const tripData = await redisHelpers.getJson(REDIS_KEYS.ACTIVE_TRIP(tripId));

            if (!tripData) {
                console.log(`⏱️ [MATCHING] Trip ${tripId} already removed from Redis`);
                await redisClient.del(timeoutKey);
                return;
            }

            if (tripData.status === 'SEARCHING') {
                console.log(`⏱️ [MATCHING] Trip ${tripId} timed out, no driver accepted`);

                await redisClient.del(REDIS_KEYS.ACTIVE_TRIP(tripId));
                await redisClient.del(`passenger:active_trip:${tripData.passengerId}`);
                await redisClient.del(REDIS_KEYS.TRIP_OFFERS(tripId));
                await redisClient.del(timeoutKey);

                const timeoutData = {
                    tripId,
                    message: 'No drivers accepted your trip. Please try again.'
                };

                io.to(`passenger:${tripData.passengerId}`).emit('trip:no_drivers', timeoutData);
                io.to(`user:${tripData.passengerId}`).emit('trip:no_drivers', timeoutData);

                const passengerSocketId = await redisClient.get(REDIS_KEYS.USER_SOCKET(tripData.passengerId));
                if (passengerSocketId && io.sockets.sockets.get(passengerSocketId)) {
                    io.to(passengerSocketId).emit('trip:no_drivers', timeoutData);
                }

                console.log(`📤 [MATCHING] Notified passenger of timeout`);
                console.log(`🗑️ [MATCHING] Trip ${tripId} removed from Redis (no database record)`);
            } else {
                console.log(`✅ [MATCHING] Trip ${tripId} status is ${tripData.status} - not cleaning up`);
                await redisClient.del(timeoutKey);
            }
        } catch (error) {
            console.error(`❌ [MATCHING] Error checking timeout for trip ${tripId}:`, error.message);
        }
    }
}

module.exports = new TripMatchingService();