// src/controllers/driver.controller.js

const { Account, Trip, TripEvent } = require('../models');const { Op } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const { redisClient, redisHelpers, acquireLock, releaseLock, REDIS_KEYS } = require('../config/redis');
const { getIO } = require('../sockets/index');

// ═══════════════════════════════════════════════════════════════════════
// DRIVER STATUS CONTROLLERS
// ═══════════════════════════════════════════════════════════════════════

exports.reportNoShow = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('⚠️ [DRIVER-CONTROLLER] Report No-Show');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('Driver UUID:', req.user.uuid);
        console.log('Trip ID:', req.params.tripId);

        const { tripId } = req.params;
        const { waitingTime, reason } = req.body;

        if (!waitingTime || waitingTime < 0) {
            console.log('❌ [DRIVER-CONTROLLER] Invalid waiting time');
            return res.status(400).json({
                error: 'Validation error',
                message: 'Valid waiting time is required',
            });
        }

        const trip = await Trip.findByPk(tripId);

        if (!trip) {
            console.log('❌ [DRIVER-CONTROLLER] Trip not found');
            return res.status(404).json({
                error: 'Trip not found',
                message: 'The requested trip does not exist',
            });
        }

        if (trip.driverId !== req.user.uuid) {
            console.log('❌ [DRIVER-CONTROLLER] Access denied - not driver\'s trip');
            return res.status(403).json({
                error: 'Access denied',
                message: 'You are not assigned to this trip',
            });
        }

        if (trip.status !== 'DRIVER_ARRIVED') {
            console.log('❌ [DRIVER-CONTROLLER] Invalid status for no-show');
            console.log('   Current Status:', trip.status);
            return res.status(400).json({
                error: 'Invalid status',
                message: 'Can only report no-show when status is DRIVER_ARRIVED',
                currentStatus: trip.status,
            });
        }

        const MIN_WAITING_TIME = 300;
        if (waitingTime < MIN_WAITING_TIME) {
            console.log('⚠️ [DRIVER-CONTROLLER] Waiting time below minimum');
            return res.status(400).json({
                error: 'Invalid waiting time',
                message: `Please wait at least ${MIN_WAITING_TIME / 60} minutes before reporting no-show`,
                minimumWaitingTime: MIN_WAITING_TIME,
                currentWaitingTime: waitingTime,
            });
        }

        trip.status = 'NO_SHOW';
        trip.cancelReason = reason || 'Passenger did not show up';
        trip.canceledBy = 'DRIVER';
        trip.canceledAt = new Date();

        await trip.save();

        console.log('✅ [DRIVER-CONTROLLER] No-show reported successfully');
        console.log('   Waiting Time:', waitingTime, 'seconds');
        console.log('   Reason:', trip.cancelReason);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(200).json({
            message: 'No-show reported successfully',
            data: {
                trip,
                waitingTime,
            },
        });

    } catch (error) {
        console.error('❌ [DRIVER-CONTROLLER] Report No-Show Error:', error);
        next(error);
    }
};

/**
 * Go Online - Set driver status to ONLINE
 * POST /api/driver/online
 */
exports.goOnline = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🟢 [DRIVER-CONTROLLER] Go Online Request');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('Driver UUID:', req.user.uuid);
        console.log('Driver Name:', req.user.first_name, req.user.last_name);
        console.log('Request Body:', req.body);

        const { lat, lng, heading } = req.body;

        // Validate required fields
        if (!lat || !lng) {
            console.log('❌ [DRIVER-CONTROLLER] Missing location data');
            return res.status(400).json({
                error: 'Validation error',
                message: 'Location (lat, lng) is required to go online',
            });
        }

        // Validate coordinates
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            console.log('❌ [DRIVER-CONTROLLER] Invalid coordinates');
            return res.status(400).json({
                error: 'Validation error',
                message: 'Invalid coordinates provided',
            });
        }

        // ✅ STEP 1: Update driver location in database (NOT Account.status!)
        const driver = await Account.findByPk(req.user.uuid);
        if (driver) {
            // ✅ DON'T CHANGE Account.status - it should stay 'ACTIVE'
            // Only update location fields if they exist
            if (driver.lastLatitude !== undefined) {
                driver.lastLatitude = lat;
            }
            if (driver.lastLongitude !== undefined) {
                driver.lastLongitude = lng;
            }
            await driver.save();
            console.log('✅ [DRIVER-CONTROLLER] Driver location updated in accounts table');
        }

        // ✅ STEP 2: Add driver location to Redis geospatial index (for nearby search)
        const geoRedisKey = 'drivers:locations';
        await redisClient.geoadd(
            geoRedisKey,
            parseFloat(lng),  // Redis expects longitude first
            parseFloat(lat),  // Then latitude
            req.user.uuid.toString()
        );

        console.log('✅ [DRIVER-CONTROLLER] Redis GEO location added');
        console.log('   Driver ID:', req.user.uuid);
        console.log('   Location:', lat, lng);

        // ✅ STEP 3: Store location as JSON (for trip acceptance)
        const driverLocationKey = `driver:location:${req.user.uuid}`;
        const locationData = {
            driverId: req.user.uuid,
            lat: parseFloat(lat),
            lng: parseFloat(lng),
            heading: heading || 0,
            lastUpdated: new Date().toISOString()
        };

        await redisHelpers.setJson(driverLocationKey, locationData, 3600); // 1 hour TTL

        console.log('✅ [DRIVER-CONTROLLER] Redis JSON location stored');
        console.log('   Location Key:', driverLocationKey);

        // ✅ STEP 4: Store driver metadata in Redis with ONLINE status
        const metadataKey = `driver:${req.user.uuid}:metadata`;
        const driverMetadata = {
            driverId: req.user.uuid,
            status: 'ONLINE',  // ✅ This is for Redis only, not DB
            isAvailable: true,
            firstName: req.user.first_name,
            lastName: req.user.last_name,
            phone: req.user.phone_e164,
            lastUpdated: new Date().toISOString()
        };

        await redisClient.setex(
            metadataKey,
            3600, // Expire after 1 hour
            JSON.stringify(driverMetadata)
        );

        console.log('✅ [DRIVER-CONTROLLER] Redis metadata saved (status: ONLINE)');
        console.log('   Metadata Key:', metadataKey);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(200).json({
            message: 'You are now online and ready to receive trips',
            data: {
                driver_id: req.user.uuid,
                is_online: true,
                location: { lat, lng, heading },
                timestamp: new Date().toISOString(),
            },
        });

    } catch (error) {
        console.error('❌ [DRIVER-CONTROLLER] Go Online Error:', error);
        next(error);
    }
};

/**
 * Go Offline - Set driver status to OFFLINE
 * POST /api/driver/offline
 */
exports.goOffline = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔴 [DRIVER-CONTROLLER] Go Offline Request');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('Driver UUID:', req.user.uuid);

        // ✅ DON'T update Account.status - it should stay 'ACTIVE'
        // Just clean up Redis data

        // Remove from Redis geospatial index
        const geoRedisKey = 'drivers:locations';
        await redisClient.zrem(geoRedisKey, req.user.uuid.toString());

        // Remove location JSON
        const driverLocationKey = `driver:location:${req.user.uuid}`;
        await redisClient.del(driverLocationKey);

        // Remove metadata
        const metadataKey = `driver:${req.user.uuid}:metadata`;
        await redisClient.del(metadataKey);

        console.log('✅ [DRIVER-CONTROLLER] Driver is now offline (Redis cleaned)');
        console.log('   Account status remains: ACTIVE');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(200).json({
            message: 'You are now offline. You will not receive trip requests.',
            data: {
                driver_id: req.user.uuid,
                is_online: false,
                timestamp: new Date().toISOString(),
            },
        });

    } catch (error) {
        console.error('❌ [DRIVER-CONTROLLER] Go Offline Error:', error);
        next(error);
    }
};
/**
 * Update Location - Update driver's current location
 * POST /api/driver/location
 */
exports.updateLocation = async (req, res, next) => {
    try {
        const { lat, lng, heading, speed, accuracy } = req.body;

        console.log('📍 [DRIVER-CONTROLLER] Location Update');
        console.log('   Driver:', req.user.uuid);
        console.log('   Location:', lat, lng);

        // Validate
        if (!lat || !lng) {
            return res.status(400).json({
                error: 'Validation error',
                message: 'Location (lat, lng) is required',
            });
        }

        // ✅ Update Redis geospatial index
        const geoRedisKey = 'drivers:locations';
        await redisClient.geoadd(
            geoRedisKey,
            parseFloat(lng),
            parseFloat(lat),
            req.user.uuid.toString()
        );

        // ✅ ALSO update JSON location
        const driverLocationKey = `driver:location:${req.user.uuid}`;
        const locationData = {
            driverId: req.user.uuid,
            lat: parseFloat(lat),
            lng: parseFloat(lng),
            heading: heading || 0,
            speed: speed || 0,
            accuracy: accuracy || 0,
            lastUpdated: new Date().toISOString()
        };

        await redisHelpers.setJson(driverLocationKey, locationData, 3600);

        console.log('📍 [REDIS] Driver location stored:', req.user.uuid, `(${lat}, ${lng})`);

        res.status(200).json({
            message: 'Location updated successfully',
            data: {
                lat,
                lng,
                heading,
                speed,
                timestamp: new Date().toISOString(),
            },
        });

    } catch (error) {
        console.error('❌ [DRIVER-CONTROLLER] Update Location Error:', error);
        next(error);
    }
};

/**
 * Get Status - Get driver's current online/offline status
 * GET /api/driver/status
 */
exports.getStatus = async (req, res, next) => {
    try {
        console.log('📊 [DRIVER-CONTROLLER] Get Status Request');
        console.log('   Driver:', req.user.uuid);

        const driver = await Account.findByPk(req.user.uuid);

        const status = {
            driver_id: req.user.uuid,
            is_online: driver?.status === 'ONLINE' || false,
            location: driver?.lastLatitude && driver?.lastLongitude ? {
                lat: driver.lastLatitude,
                lng: driver.lastLongitude
            } : null,
            last_updated: new Date().toISOString(),
        };

        res.status(200).json({
            message: 'Driver status retrieved',
            data: status,
        });

    } catch (error) {
        console.error('❌ [DRIVER-CONTROLLER] Get Status Error:', error);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// TRIP MANAGEMENT CONTROLLERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Get Current Trip - Get driver's active trip
 * GET /api/driver/current-trip
 */
exports.getCurrentTrip = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔍 [DRIVER-CONTROLLER] Get Current Trip');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('Driver UUID:', req.user.uuid);

        const trip = await Trip.findOne({
            where: {
                driverId: req.user.uuid,
                status: {
                    [Op.in]: ['MATCHED', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS'],
                },
            },
            order: [['createdAt', 'DESC']],
        });

        if (!trip) {
            console.log('ℹ️ [DRIVER-CONTROLLER] No active trip found');
            return res.status(200).json({
                message: 'No active trip',
                data: {
                    currentTrip: null,
                },
            });
        }

        console.log('✅ [DRIVER-CONTROLLER] Active trip found');
        console.log('   Trip ID:', trip.id);
        console.log('   Status:', trip.status);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(200).json({
            message: 'Current trip retrieved',
            data: {
                currentTrip: trip,
            },
        });

    } catch (error) {
        console.error('❌ [DRIVER-CONTROLLER] Get Current Trip Error:', error);
        next(error);
    }
};

/**
 * Accept Trip - Accept a trip offer
 * POST /api/driver/trips/:tripId/accept
 */
exports.acceptTrip = async (req, res, next) => {
    const { tripId } = req.params;
    const driverId = req.user.uuid;
    const driverName = `${req.user.first_name} ${req.user.last_name}`;

    const lockKey = `trip:lock:${tripId}`;
    const lockValue = uuidv4();
    const lockTTL = 10;

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🚕 [ACCEPT-TRIP] Processing acceptance request');
    console.log('🆔 Trip ID:', tripId);
    console.log('👤 Driver ID:', driverId);
    console.log('👤 Driver Name:', driverName);
    console.log('🔒 Lock Key:', lockKey);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    try {
        // ═══════════════════════════════════════════════════════════════
        // STEP 1: ACQUIRE ATOMIC LOCK
        // ═══════════════════════════════════════════════════════════════
        console.log('🔒 [ACCEPT-TRIP] Attempting to acquire lock...');

        const lockAcquired = await redisClient.set(
            lockKey,
            lockValue,
            'EX', lockTTL,
            'NX'
        );

        if (!lockAcquired) {
            console.log('❌ [ACCEPT-TRIP] Lock acquisition failed - another driver is processing');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
            return res.status(409).json({
                error: true,
                message: 'This trip is being accepted by another driver. Please try again.',
                code: 'TRIP_LOCKED'
            });
        }

        console.log('✅ [ACCEPT-TRIP] Lock acquired successfully');

        // ═══════════════════════════════════════════════════════════════
        // STEP 2: GET TRIP FROM REDIS
        // ═══════════════════════════════════════════════════════════════
        console.log('🔍 [ACCEPT-TRIP] Fetching trip from Redis...');

        const tripKey = REDIS_KEYS.ACTIVE_TRIP(tripId);
        const trip = await redisHelpers.getJson(tripKey);

        if (!trip) {
            console.log('❌ [ACCEPT-TRIP] Trip not found in Redis');
            await redisClient.del(lockKey);
            return res.status(404).json({
                error: true,
                message: 'Trip not found or already expired',
                code: 'TRIP_NOT_FOUND'
            });
        }

        console.log('📦 [ACCEPT-TRIP] Trip data:', {
            id: trip.id,
            status: trip.status,
            passengerId: trip.passengerId,
            driverId: trip.driverId
        });

        // ═══════════════════════════════════════════════════════════════
        // STEP 3: VALIDATE TRIP STATUS
        // ═══════════════════════════════════════════════════════════════
        console.log('🔍 [ACCEPT-TRIP] Validating trip status...');

        if (trip.status !== 'SEARCHING') {
            console.log(`❌ [ACCEPT-TRIP] Invalid status: ${trip.status}`);
            await redisClient.del(lockKey);

            return res.status(409).json({
                error: true,
                message: 'This trip is no longer available',
                code: 'TRIP_NOT_AVAILABLE',
                data: {
                    currentStatus: trip.status,
                    acceptedBy: trip.driverId || null
                }
            });
        }

        if (trip.driverId && trip.driverId !== driverId) {
            console.log(`❌ [ACCEPT-TRIP] Already assigned to driver: ${trip.driverId}`);
            await redisClient.del(lockKey);

            return res.status(409).json({
                error: true,
                message: 'This trip has already been accepted by another driver',
                code: 'TRIP_ALREADY_ACCEPTED'
            });
        }

        console.log('✅ [ACCEPT-TRIP] Trip is available for acceptance');

        // ═══════════════════════════════════════════════════════════════
        // STEP 4: GET DRIVER LOCATION FROM REDIS (JSON FORMAT)
        // ═══════════════════════════════════════════════════════════════
        console.log('📍 [ACCEPT-TRIP] Fetching driver location...');

        const driverLocationKey = `driver:location:${driverId}`;
        const driverLocationData = await redisHelpers.getJson(driverLocationKey);

        if (!driverLocationData) {
            console.log('⚠️ [ACCEPT-TRIP] Driver location not found');
            await redisClient.del(lockKey);

            return res.status(400).json({
                error: true,
                message: 'Cannot accept trip - driver location not available. Please ensure you are online.',
                code: 'DRIVER_LOCATION_MISSING'
            });
        }

        const driverLocation = {
            lat: parseFloat(driverLocationData.lat),
            lng: parseFloat(driverLocationData.lng)
        };

        console.log('✅ [ACCEPT-TRIP] Driver location:', driverLocation);

        // ═══════════════════════════════════════════════════════════════
        // STEP 5: UPDATE TRIP IN REDIS WITH NEW STATUS
        // ═══════════════════════════════════════════════════════════════
        console.log('💾 [ACCEPT-TRIP] Updating trip in Redis...');

        const updatedTrip = {
            ...trip,
            driverId,
            driverName,
            driverLocation,
            status: 'MATCHED',
            matchedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        await redisHelpers.setJson(tripKey, updatedTrip, 3600);

        console.log('✅ [ACCEPT-TRIP] Trip updated in Redis');

        // ═══════════════════════════════════════════════════════════════
        // STEP 6: SAVE TRIP TO DATABASE
        // ═══════════════════════════════════════════════════════════════
        console.log('💾 [ACCEPT-TRIP] Saving trip to database...');
        console.log('📦 [ACCEPT-TRIP] Trip data to save:', {
            id: trip.id,
            passengerId: trip.passengerId,
            driverId,
            status: 'MATCHED',
            pickupLat: trip.pickupLat,
            pickupLng: trip.pickupLng,
            pickupAddress: trip.pickupAddress,
            dropoffLat: trip.dropoffLat,
            dropoffLng: trip.dropoffLng,
            dropoffAddress: trip.dropoffAddress,
            distanceM: trip.distanceM,
            durationS: trip.durationS,
            fareEstimate: trip.fareEstimate,
            paymentMethod: trip.paymentMethod || 'CASH',
            routePolyline: trip.routePolyline,
            driverLocationLat: driverLocation.lat,
            driverLocationLng: driverLocation.lng,
            matchedAt: new Date()
        });

        let dbTrip;
        try {
            dbTrip = await Trip.create({
                id: trip.id,
                passengerId: trip.passengerId,
                driverId,
                status: 'MATCHED',
                pickupLat: trip.pickupLat,
                pickupLng: trip.pickupLng,
                pickupAddress: trip.pickupAddress,
                dropoffLat: trip.dropoffLat,
                dropoffLng: trip.dropoffLng,
                dropoffAddress: trip.dropoffAddress,
                distanceM: trip.distanceM,
                durationS: trip.durationS,
                fareEstimate: trip.fareEstimate,
                paymentMethod: trip.paymentMethod || 'CASH',
                routePolyline: trip.routePolyline,
                driverLocationLat: driverLocation.lat,
                driverLocationLng: driverLocation.lng,
                matchedAt: new Date()
            });

            console.log('✅ [ACCEPT-TRIP] Trip saved to database');
            console.log('✅ [ACCEPT-TRIP] Database Trip ID:', dbTrip.id);
        } catch (dbError) {
            console.error('❌ [ACCEPT-TRIP] Database save error:', dbError);
            console.error('❌ [ACCEPT-TRIP] Error name:', dbError.name);
            console.error('❌ [ACCEPT-TRIP] Error message:', dbError.message);

            if (dbError.original) {
                console.error('❌ [ACCEPT-TRIP] Original error:', dbError.original);
                console.error('❌ [ACCEPT-TRIP] SQL:', dbError.sql);
                console.error('❌ [ACCEPT-TRIP] Error code:', dbError.original.code);
                console.error('❌ [ACCEPT-TRIP] Error errno:', dbError.original.errno);
                console.error('❌ [ACCEPT-TRIP] SQL state:', dbError.original.sqlState);
                console.error('❌ [ACCEPT-TRIP] SQL message:', dbError.original.sqlMessage);
            }

            // Release lock before returning
            await redisClient.del(lockKey);

            return res.status(500).json({
                error: true,
                message: 'Failed to save trip to database',
                code: 'DATABASE_ERROR',
                details: dbError.message,
                sqlMessage: dbError.original?.sqlMessage || 'Unknown SQL error'
            });
        }

        // Create trip event (optional - don't fail if this doesn't work)
        try {
            const { TripEvent } = require('../models');

            if (TripEvent) {
                await TripEvent.create({
                    tripId: trip.id,
                    eventType: 'TRIP_MATCHED',
                    performedBy: driverId,
                    metadata: {
                        driverLocation,
                        matchedAt: new Date().toISOString()
                    }
                });
                console.log('✅ [ACCEPT-TRIP] Trip event created');
            }
        } catch (eventError) {
            console.warn('⚠️ [ACCEPT-TRIP] Failed to create trip event (non-critical):', eventError.message);
        }

        // ═══════════════════════════════════════════════════════════════
        // STEP 7: UPDATE PASSENGER'S ACTIVE TRIP REFERENCE
        // ═══════════════════════════════════════════════════════════════
        const passengerActiveTripKey = `passenger:active_trip:${trip.passengerId}`;
        await redisHelpers.setJson(passengerActiveTripKey, {
            tripId: trip.id,
            status: 'MATCHED',
            driverId,
            driverName
        }, 3600);

        console.log('✅ [ACCEPT-TRIP] Passenger active trip reference updated');

        // ═══════════════════════════════════════════════════════════════
        // STEP 8: CLEAN UP DRIVER OFFERS
        // ═══════════════════════════════════════════════════════════════
        console.log('🧹 [ACCEPT-TRIP] Cleaning up driver offers...');

        const driverOffersPattern = `driver:pending_offers:*`;
        const driverOfferKeys = await redisClient.keys(driverOffersPattern);

        for (const key of driverOfferKeys) {
            const offers = await redisHelpers.getJson(key);
            if (offers && Array.isArray(offers)) {
                const filteredOffers = offers.filter(o => o.tripId !== tripId);
                if (filteredOffers.length !== offers.length) {
                    await redisHelpers.setJson(key, filteredOffers, 3600);
                }
            }
        }

        console.log('✅ [ACCEPT-TRIP] Driver offers cleaned up');

        // ═══════════════════════════════════════════════════════════════
        // STEP 9: EMIT SOCKET EVENTS
        // ═══════════════════════════════════════════════════════════════
        console.log('📡 [ACCEPT-TRIP] Emitting socket events...');

        const io = getIO();

        // Notify passenger
        io.to(`passenger:${trip.passengerId}`).emit('trip:driver_assigned', {
            tripId: trip.id,
            driver: {
                id: driverId,
                name: driverName,
                location: driverLocation
            },
            trip: updatedTrip,
            timestamp: new Date().toISOString()
        });

        console.log('✅ [ACCEPT-TRIP] Passenger notified');

        // Notify the accepting driver
        io.to(`driver:${driverId}`).emit('trip:matched', {
            tripId: trip.id,
            trip: updatedTrip,
            passenger: {
                id: trip.passengerId,
                name: trip.passengerName || 'Passenger',
                phone: trip.passengerPhone || '',
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
            timestamp: new Date().toISOString()
        });

        console.log('✅ [ACCEPT-TRIP] Driver notified');

        // Notify other drivers that trip was taken
        io.emit('trip:taken', {
            tripId: trip.id,
            message: 'This trip has been accepted by another driver',
            timestamp: new Date().toISOString()
        });

        console.log('✅ [ACCEPT-TRIP] All drivers notified');
        console.log('✅ [ACCEPT-TRIP] Socket events emitted');

        // ═══════════════════════════════════════════════════════════════
        // STEP 10: RELEASE LOCK
        // ═══════════════════════════════════════════════════════════════
        console.log('🔓 [ACCEPT-TRIP] Releasing lock...');

        const currentLockValue = await redisClient.get(lockKey);
        if (currentLockValue === lockValue) {
            await redisClient.del(lockKey);
            console.log('✅ [ACCEPT-TRIP] Lock released');
        }

        // ═══════════════════════════════════════════════════════════════
        // STEP 11: FETCH PASSENGER INFO FROM DATABASE
        // ═══════════════════════════════════════════════════════════════
        console.log('🔍 [ACCEPT-TRIP] Fetching passenger information from database...');

        const passengerAccount = await Account.findOne({
            where: { uuid: trip.passengerId },
            attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url', 'rating_avg']
        });

        if (!passengerAccount) {
            console.error('❌ [ACCEPT-TRIP] Passenger account not found:', trip.passengerId);

            // Still release lock
            await redisClient.del(lockKey);

            return res.status(404).json({
                error: true,
                message: 'Passenger account not found',
                code: 'PASSENGER_NOT_FOUND'
            });
        }

        console.log('✅ [ACCEPT-TRIP] Passenger info retrieved:', {
            uuid: passengerAccount.uuid,
            name: `${passengerAccount.first_name} ${passengerAccount.last_name}`,
            phone: passengerAccount.phone_e164
        });

        // ✅ BUILD COMPLETE PASSENGER DATA OBJECT WITH MULTIPLE FIELD FORMATS
        const passengerData = {
            id: passengerAccount.uuid,
            uuid: passengerAccount.uuid,
            name: `${passengerAccount.first_name} ${passengerAccount.last_name}`.trim(),
            firstName: passengerAccount.first_name,
            lastName: passengerAccount.last_name,
            first_name: passengerAccount.first_name,
            last_name: passengerAccount.last_name,
            phone: passengerAccount.phone_e164,
            phone_e164: passengerAccount.phone_e164,
            phoneNumber: passengerAccount.phone_e164,
            avatar: passengerAccount.avatar_url,
            avatar_url: passengerAccount.avatar_url,
            rating: passengerAccount.rating_avg || 5.0,
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
        };

        console.log('✅ [ACCEPT-TRIP] Passenger data prepared:');
        console.log(JSON.stringify(passengerData, null, 2));

        // ═══════════════════════════════════════════════════════════════
        // STEP 12: SEND SUCCESS RESPONSE WITH COMPLETE DATA
        // ═══════════════════════════════════════════════════════════════
        console.log('✅ [ACCEPT-TRIP] Trip acceptance completed successfully');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({
            message: 'Trip accepted successfully',
            data: {
                driver_id: driverId,  // ✅ For socket emit
                trip: {
                    id: dbTrip.id,
                    status: dbTrip.status,
                    fare: trip.fareEstimate,
                    distance: trip.distanceM,
                    duration: trip.durationS,
                    matchedAt: dbTrip.matchedAt,
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
                passenger: passengerData  // ✅ COMPLETE passenger object from database
            }
        });

    } catch (error) {
        console.error('❌ [ACCEPT-TRIP] Unexpected error:', error);
        console.error('❌ [ACCEPT-TRIP] Error stack:', error.stack);

        // Release lock in case of error
        try {
            const currentLockValue = await redisClient.get(lockKey);
            if (currentLockValue === lockValue) {
                await redisClient.del(lockKey);
                console.log('🔓 [ACCEPT-TRIP] Lock released after error');
            }
        } catch (lockError) {
            console.error('❌ [ACCEPT-TRIP] Failed to release lock:', lockError);
        }

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        next(error);
    }
};

/**
 * Decline Trip
 * POST /api/driver/trips/:tripId/decline
 */
exports.declineTrip = async (req, res, next) => {
    const { tripId } = req.params;
    const driverId = req.user.uuid;

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🚫 [DECLINE-TRIP] Processing decline request');
    console.log('🆔 Trip ID:', tripId);
    console.log('👤 Driver ID:', driverId);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    try {
        const driverOffersKey = `driver:pending_offers:${driverId}`;
        const offers = await redisHelpers.getJson(driverOffersKey) || [];

        const filteredOffers = offers.filter(o => o.tripId !== tripId);
        await redisHelpers.setJson(driverOffersKey, filteredOffers, 3600);

        const declinedKey = `trip:declined:${tripId}`;
        await redisClient.sadd(declinedKey, driverId);
        await redisClient.expire(declinedKey, 300);

        console.log('✅ [DECLINE-TRIP] Trip declined successfully');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        const io = getIO();
        io.to(`driver:${driverId}`).emit('trip:decline:success', {
            tripId,
            message: 'Trip declined successfully',
            timestamp: new Date().toISOString()
        });

        return res.status(200).json({
            message: 'Trip declined successfully',
            data: { tripId }
        });

    } catch (error) {
        console.error('❌ [DECLINE-TRIP] Error:', error);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        next(error);
    }
};

/**
 * Arrived at Pickup
 * POST /api/driver/trips/:tripId/arrived
 */
exports.arrivedAtPickup = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📍 [DRIVER-CONTROLLER] Arrived at Pickup');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('Driver UUID:', req.user.uuid);
        console.log('Trip ID:', req.params.tripId);

        const { tripId } = req.params;

        const trip = await Trip.findByPk(tripId);

        if (!trip) {
            return res.status(404).json({
                error: 'Trip not found',
                message: 'The requested trip does not exist',
            });
        }

        if (trip.driverId !== req.user.uuid) {
            return res.status(403).json({
                error: 'Access denied',
                message: 'You are not assigned to this trip',
            });
        }

        trip.status = 'DRIVER_ARRIVED';
        await trip.save();

        console.log('✅ [DRIVER-CONTROLLER] Status updated to DRIVER_ARRIVED');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        const io = getIO();
        io.to(`passenger:${trip.passengerId}`).emit('trip:driver_arrived', {
            tripId: trip.id,
            arrivedAt: new Date(),
        });

        res.status(200).json({
            message: 'Status updated: Driver arrived at pickup',
            data: { trip },
        });

    } catch (error) {
        console.error('❌ [DRIVER-CONTROLLER] Arrived at Pickup Error:', error);
        next(error);
    }
};

/**
 * Start Trip
 * POST /api/driver/trips/:tripId/start
 */
exports.startTrip = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🚀 [DRIVER-CONTROLLER] Start Trip');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('Driver UUID:', req.user.uuid);
        console.log('Trip ID:', req.params.tripId);

        const { tripId } = req.params;

        const trip = await Trip.findByPk(tripId);

        if (!trip) {
            return res.status(404).json({
                error: 'Trip not found',
                message: 'The requested trip does not exist',
            });
        }

        if (trip.driverId !== req.user.uuid) {
            return res.status(403).json({
                error: 'Access denied',
                message: 'You are not assigned to this trip',
            });
        }

        trip.status = 'IN_PROGRESS';
        trip.tripStartedAt = new Date();
        await trip.save();

        console.log('✅ [DRIVER-CONTROLLER] Trip started');
        console.log('   Started At:', trip.tripStartedAt);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        const io = getIO();
        io.to(`passenger:${trip.passengerId}`).emit('trip:started', {
            tripId: trip.id,
            startedAt: trip.tripStartedAt,
        });

        res.status(200).json({
            message: 'Trip started successfully',
            data: { trip },
        });

    } catch (error) {
        console.error('❌ [DRIVER-CONTROLLER] Start Trip Error:', error);
        next(error);
    }
};

/**
 * Complete Trip
 * POST /api/driver/trips/:tripId/complete
 */
exports.completeTrip = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🏁 [DRIVER-CONTROLLER] Complete Trip');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('Driver UUID:', req.user.uuid);
        console.log('Trip ID:', req.params.tripId);

        const { tripId } = req.params;
        const { final_fare, notes } = req.body;

        const trip = await Trip.findByPk(tripId);

        if (!trip) {
            return res.status(404).json({
                error: 'Trip not found',
                message: 'The requested trip does not exist',
            });
        }

        if (trip.driverId !== req.user.uuid) {
            return res.status(403).json({
                error: 'Access denied',
                message: 'You are not assigned to this trip',
            });
        }

        trip.status = 'COMPLETED';
        trip.tripCompletedAt = new Date();
        if (final_fare) trip.fareFinal = final_fare;
        await trip.save();

        console.log('✅ [DRIVER-CONTROLLER] Trip completed');
        console.log('   Completed At:', trip.tripCompletedAt);
        console.log('   Final Fare:', trip.fareFinal);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        const io = getIO();
        io.to(`passenger:${trip.passengerId}`).emit('trip:completed', {
            tripId: trip.id,
            completedAt: trip.tripCompletedAt,
            finalFare: trip.fareFinal,
        });

        res.status(200).json({
            message: 'Trip completed successfully',
            data: { trip },
        });

    } catch (error) {
        console.error('❌ [DRIVER-CONTROLLER] Complete Trip Error:', error);
        next(error);
    }
};

/**
 * Cancel Trip
 * POST /api/driver/trips/:tripId/cancel
 */
exports.cancelTrip = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🚫 [DRIVER-CONTROLLER] Cancel Trip');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('Driver UUID:', req.user.uuid);
        console.log('Trip ID:', req.params.tripId);

        const { tripId } = req.params;
        const { reason } = req.body;

        if (!reason) {
            return res.status(400).json({
                error: 'Validation error',
                message: 'Cancellation reason is required',
            });
        }

        const trip = await Trip.findByPk(tripId);

        if (!trip) {
            return res.status(404).json({
                error: 'Trip not found',
                message: 'The requested trip does not exist',
            });
        }

        if (trip.driverId !== req.user.uuid) {
            return res.status(403).json({
                error: 'Access denied',
                message: 'You are not assigned to this trip',
            });
        }

        trip.status = 'CANCELED';
        trip.cancelReason = reason;
        trip.canceledBy = 'DRIVER';
        trip.canceledAt = new Date();
        await trip.save();

        console.log('✅ [DRIVER-CONTROLLER] Trip canceled');
        console.log('   Reason:', reason);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        const io = getIO();
        io.to(`passenger:${trip.passengerId}`).emit('trip:canceled', {
            tripId: trip.id,
            canceledBy: 'DRIVER',
            reason,
        });

        res.status(200).json({
            message: 'Trip canceled',
            data: { trip },
        });

    } catch (error) {
        console.error('❌ [DRIVER-CONTROLLER] Cancel Trip Error:', error);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// STATS & HISTORY CONTROLLERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Get Stats
 * GET /api/driver/stats
 */
exports.getStats = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📊 [DRIVER-CONTROLLER] Get Stats Request');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('Driver UUID:', req.user.uuid);

        const driverId = req.user.uuid;

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const weekStart = new Date(today);
        weekStart.setDate(today.getDate() - today.getDay());

        const todayTrips = await Trip.count({
            where: {
                driverId: driverId,
                status: 'COMPLETED',
                tripCompletedAt: {
                    [Op.gte]: today,
                    [Op.lt]: tomorrow,
                },
            },
        });

        const todayEarnings = await Trip.sum('fareFinal', {
            where: {
                driverId: driverId,
                status: 'COMPLETED',
                tripCompletedAt: {
                    [Op.gte]: today,
                    [Op.lt]: tomorrow,
                },
            },
        }) || 0;

        const weekTrips = await Trip.count({
            where: {
                driverId: driverId,
                status: 'COMPLETED',
                tripCompletedAt: {
                    [Op.gte]: weekStart,
                },
            },
        });

        const weekEarnings = await Trip.sum('fareFinal', {
            where: {
                driverId: driverId,
                status: 'COMPLETED',
                tripCompletedAt: {
                    [Op.gte]: weekStart,
                },
            },
        }) || 0;

        const totalTrips = await Trip.count({
            where: {
                driverId: driverId,
                status: 'COMPLETED',
            },
        });

        const totalEarnings = await Trip.sum('fareFinal', {
            where: {
                driverId: driverId,
                status: 'COMPLETED',
            },
        }) || 0;

        console.log('✅ [DRIVER-CONTROLLER] Stats retrieved successfully');
        console.log(`   Today: ${todayTrips} trips, ${todayEarnings} XAF`);
        console.log(`   Week: ${weekTrips} trips, ${weekEarnings} XAF`);
        console.log(`   Total: ${totalTrips} trips, ${totalEarnings} XAF`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(200).json({
            message: 'Driver stats retrieved successfully',
            data: {
                today: {
                    trips: todayTrips,
                    earnings: todayEarnings,
                },
                week: {
                    trips: weekTrips,
                    earnings: weekEarnings,
                },
                total: {
                    trips: totalTrips,
                    earnings: totalEarnings,
                },
            },
        });

    } catch (error) {
        console.error('❌ [DRIVER-CONTROLLER] Get Stats Error:', error);
        next(error);
    }
};

/**
 * Get Earnings
 * GET /api/driver/earnings
 */
exports.getEarnings = async (req, res, next) => {
    try {
        console.log('💰 [DRIVER-CONTROLLER] Get Earnings Request');

        const { period = 'all' } = req.query;
        const driverId = req.user.uuid;

        res.status(200).json({
            message: 'Earnings retrieved',
            data: {
                period,
                earnings: [],
                total: 0,
            },
        });

    } catch (error) {
        console.error('❌ [DRIVER-CONTROLLER] Get Earnings Error:', error);
        next(error);
    }
};

/**
 * Get Trip History
 * GET /api/driver/trips/history
 */
exports.getTripHistory = async (req, res, next) => {
    try {
        console.log('📜 [DRIVER-CONTROLLER] Get Trip History Request');

        const { page = 1, limit = 20, status } = req.query;
        const driverId = req.user.uuid;

        const offset = (page - 1) * limit;

        const where = {
            driverId: driverId,
        };

        if (status) {
            where.status = status;
        }

        const { count, rows: trips } = await Trip.findAndCountAll({
            where,
            limit: parseInt(limit),
            offset: parseInt(offset),
            order: [['createdAt', 'DESC']],
        });

        console.log('✅ [DRIVER-CONTROLLER] Trip history retrieved');
        console.log('   Total:', count);
        console.log('   Page:', page, 'of', Math.ceil(count / limit));

        res.status(200).json({
            message: 'Trip history retrieved',
            data: {
                trips,
                pagination: {
                    total: count,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    totalPages: Math.ceil(count / limit),
                },
            },
        });

    } catch (error) {
        console.error('❌ [DRIVER-CONTROLLER] Get Trip History Error:', error);
        next(error);
    }
};

/**
 * Get Trip Details
 * GET /api/driver/trips/:tripId
 */
exports.getTripDetails = async (req, res, next) => {
    try {
        console.log('🔍 [DRIVER-CONTROLLER] Get Trip Details Request');

        const { tripId } = req.params;
        const driverId = req.user.uuid;

        const trip = await Trip.findOne({
            where: {
                id: tripId,
                driverId: driverId,
            },
        });

        if (!trip) {
            return res.status(404).json({
                error: 'Trip not found',
                message: 'The requested trip does not exist or you are not assigned to it',
            });
        }

        console.log('✅ [DRIVER-CONTROLLER] Trip details retrieved');

        res.status(200).json({
            message: 'Trip details retrieved',
            data: { trip },
        });

    } catch (error) {
        console.error('❌ [DRIVER-CONTROLLER] Get Trip Details Error:', error);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// PROFILE CONTROLLERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Get Profile
 * GET /api/driver/profile
 */
exports.getProfile = async (req, res, next) => {
    try {
        console.log('👤 [DRIVER-CONTROLLER] Get Profile Request');

        const driver = await Account.findByPk(req.user.uuid, {
            attributes: { exclude: ['password_hash', 'password_algo'] },
        });

        if (!driver) {
            return res.status(404).json({
                error: 'Driver not found',
                message: 'Driver profile not found',
            });
        }

        res.status(200).json({
            message: 'Driver profile retrieved',
            data: { driver },
        });

    } catch (error) {
        console.error('❌ [DRIVER-CONTROLLER] Get Profile Error:', error);
        next(error);
    }
};

/**
 * Update Profile
 * PUT /api/driver/profile
 */
exports.updateProfile = async (req, res, next) => {
    try {
        console.log('✏️ [DRIVER-CONTROLLER] Update Profile Request');

        res.status(200).json({
            message: 'Profile updated successfully',
            data: {},
        });

    } catch (error) {
        console.error('❌ [DRIVER-CONTROLLER] Update Profile Error:', error);
        next(error);
    }
};

/**
 * Get Ratings
 * GET /api/driver/ratings
 */
exports.getRatings = async (req, res, next) => {
    try {
        console.log('⭐ [DRIVER-CONTROLLER] Get Ratings Request');

        res.status(200).json({
            message: 'Ratings retrieved',
            data: {
                averageRating: 4.8,
                totalRatings: 0,
                ratings: [],
            },
        });

    } catch (error) {
        console.error('❌ [DRIVER-CONTROLLER] Get Ratings Error:', error);
        next(error);
    }
};