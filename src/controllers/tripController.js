// src/controllers/tripController.js

const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize'); // ✅ FIX STEP 2: Added missing Op import
const { Trip, TripEvent, Account, DriverProfile } = require('../models'); // ✅ FIX STEP 2: Added DriverProfile (was 'Driver' which doesn't exist)
const fareCalculatorService = require('../services/fareCalculatorService');
const tripMatchingService = require('../services/tripMatchingService');
const locationService = require('../services/locationService'); // ✅ FIX LOW: Moved from dynamic require() inside cancelTrip
const { redisClient, redisHelpers, REDIS_KEYS } = require('../config/redis');
const { getIO } = require('../sockets');

// ═══════════════════════════════════════════════════════════════════════
// CREATE TRIP (PASSENGER)
// ═══════════════════════════════════════════════════════════════════════

exports.createTrip = async (req, res, next) => {
    console.log('========================');
    console.log('🚗 [TRIP_CONTROLLER:createTrip] Request initiated');
    try {
        console.log('👤 User UUID:', req.user.uuid);
        console.log('👤 User Type:', req.user.user_type);

        // Authorization check
        if (req.user.user_type !== 'PASSENGER') {
            console.log('❌ [CREATE TRIP] Access denied. User type is not PASSENGER.');
            const err = new Error('Only passengers can create trips');
            err.status = 403;
            throw err;
        }

        const {
            pickupLat,
            pickupLng,
            pickupAddress,
            dropoffLat,
            dropoffLng,
            dropoffAddress,
            payment_method
        } = req.body;

        console.log('📦 [CREATE TRIP] Received body:', req.body);

        // Validate coordinates
        if (!pickupLat || !pickupLng || !dropoffLat || !dropoffLng) {
            console.log('❌ [CREATE TRIP] Missing coordinates.');
            const err = new Error('Pickup and dropoff coordinates are required');
            err.status = 400;
            throw err;
        }

        // Validate coordinate ranges
        const pLat = parseFloat(pickupLat);
        const pLng = parseFloat(pickupLng);
        const dLat = parseFloat(dropoffLat);
        const dLng = parseFloat(dropoffLng);

        if (isNaN(pLat) || isNaN(pLng) || isNaN(dLat) || isNaN(dLng)) {
            const err = new Error('Coordinates must be valid numbers');
            err.status = 400;
            throw err;
        }

        if (pLat < -90 || pLat > 90 || dLat < -90 || dLat > 90) {
            const err = new Error('Latitude must be between -90 and 90');
            err.status = 400;
            throw err;
        }

        if (pLng < -180 || pLng > 180 || dLng < -180 || dLng > 180) {
            const err = new Error('Longitude must be between -180 and 180');
            err.status = 400;
            throw err;
        }

        // Check for existing active trip in Redis
        const existingActiveTripKey = `passenger:active_trip:${req.user.uuid}`;
        const existingActiveTrip = await redisHelpers.getJson(existingActiveTripKey);
        console.log('🔍 [REDIS] Checking for existing active trip key:', existingActiveTripKey);

        if (existingActiveTrip) {
            console.log('⚠️ [CREATE TRIP] Active trip already found in Redis:', existingActiveTrip);
            return res.status(409).json({
                error: true,
                message: 'You already have an active trip',
                data: { tripId: existingActiveTrip.tripId }
            });
        }

        // Check for existing active trip in Database
        console.log('🔍 [DB] Checking for active trips in database...');
        const dbActiveTrip = await Trip.findOne({
            where: {
                passengerId: req.user.uuid,
                status: {
                    [Op.in]: ['MATCHED', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS']
                }
            }
        });

        if (dbActiveTrip) {
            console.log('⚠️ [CREATE TRIP] Active trip found in DB:', dbActiveTrip.id);
            return res.status(409).json({
                error: true,
                message: 'You already have an active trip',
                data: { tripId: dbActiveTrip.id }
            });
        }

        // Calculate route and fare estimate
        console.log('📍 [CREATE TRIP] Estimating route and fare...');
        const estimate = await fareCalculatorService.estimateFullTrip(
            pLat,
            pLng,
            dLat,
            dLng
        );
        console.log('📏 [CREATE TRIP] Estimate:', estimate);

        // ✅ Handle fare/route errors gracefully
        if (estimate.error) {
            console.log('❌ [CREATE TRIP] Fare estimation failed:', estimate.message);
            return res.status(estimate.status || 400).json({
                error: true,
                message: estimate.message || 'Failed to calculate route. Please check your pickup and dropoff locations.',
                data: null
            });
        }

        // Generate trip ID
        const tripId = uuidv4();
        console.log('🆔 [CREATE TRIP] Generated tripId:', tripId);

        // Prepare trip data
        const tripData = {
            id: tripId,
            passengerId: req.user.uuid,
            status: 'SEARCHING',
            pickupLat: pLat,
            pickupLng: pLng,
            pickupAddress: pickupAddress || estimate.start_address,
            dropoffLat: dLat,
            dropoffLng: dLng,
            dropoffAddress: dropoffAddress || estimate.end_address,
            routePolyline: estimate.polyline,
            distanceM: estimate.distance_m,
            durationS: estimate.duration_s,
            fareEstimate: estimate.fare_estimate,
            fareBreakdown: estimate.breakdown || null, // ✅ Store breakdown for Flutter
            paymentMethod: payment_method || 'CASH',
            createdAt: new Date().toISOString()
        };
        console.log('💾 [CREATE TRIP] Trip data prepared:', {
            id: tripData.id,
            fareEstimate: tripData.fareEstimate,
            distanceM: tripData.distanceM,
            durationS: tripData.durationS
        });

        // Calculate TTL for Redis
        const ttl = parseInt(process.env.OFFER_TTL_MS || 20000, 10) / 1000 + 60;
        console.log('⏳ [CREATE TRIP] TTL for Redis (seconds):', ttl);

        // Save trip to Redis
        console.log('🧠 [REDIS] Saving trip data to Redis...');
        await redisHelpers.setJson(REDIS_KEYS.ACTIVE_TRIP(tripId), tripData, ttl);

        // Save passenger active trip reference
        console.log('🧠 [REDIS] Saving passenger active trip reference...');
        await redisHelpers.setJson(existingActiveTripKey, { tripId, status: 'SEARCHING' }, ttl);

        // Broadcast trip to nearby drivers
        console.log('📢 [CREATE TRIP] Broadcasting trip to nearby drivers...');
        const io = getIO();
        const broadcast = await tripMatchingService.broadcastTripToDrivers(tripId, io);
        console.log('📡 [CREATE TRIP] Broadcast result:', broadcast);

        if (!broadcast.success && broadcast.reason === 'No drivers available') {
            console.log('⚠️ [CREATE TRIP] No drivers notified via socket — keeping trip alive for HTTP accept.');
            // DO NOT delete Redis — driver can still accept via POST /api/driver/trips/:tripId/accept
        }

        console.log('✅ [CREATE TRIP] Trip successfully created in Redis:', tripId);

        res.status(201).json({
            message: 'Trip created successfully, searching for drivers...',
            data: {
                trip: tripData,
                driversNotified: broadcast.driversNotified
            }
        });

    } catch (error) {
        console.error('❌ [CREATE TRIP] Error:', error.stack || error.message);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET RECENT TRIPS — ✅ FULLY FIXED (Steps 2 + 3)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Get recent completed/canceled trips for the logged-in passenger
 * GET /api/trips/recent
 */
exports.getRecentTrips = async (req, res) => {
    try {
        const userId = req.user.uuid;
        const limit = parseInt(req.query.limit) || 10;

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📋 [RECENT TRIPS] Fetching recent trips');
        console.log(`👤 User ID: ${userId}`);
        console.log(`📊 Limit: ${limit}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        // ✅ FIX STEP 2+3: Op is now imported — this query works
        // ✅ FIX STEP 2+3: model: DriverProfile (was model: Driver which crashed)
        const trips = await Trip.findAll({
            where: {
                passengerId: userId,
                status: {
                    [Op.in]: ['COMPLETED', 'CANCELED']
                }
            },
            include: [
                {
                    model: Account,
                    as: 'driver',
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'],
                    required: false, // LEFT JOIN — some trips may have no driver (e.g. canceled while searching)
                    include: [
                        {
                            model: DriverProfile,      // ✅ FIXED: was 'Driver' (undefined) → DriverProfile
                            as: 'driverProfile',
                            attributes: [
                                'vehicle_type',
                                'vehicle_plate',
                                'vehicle_make_model',
                                'vehicle_color',
                                'vehicle_year',
                                'rating_avg',
                                'total_trips'
                            ],
                            required: false
                        }
                    ]
                }
            ],
            order: [['updatedAt', 'DESC']],
            limit: limit
        });

        console.log(`✅ [RECENT TRIPS] Found ${trips.length} trips\n`);

        // ✅ FIX STEP 3: ALL field names corrected from snake_case → camelCase
        // Sequelize auto-converts DB column names (snake_case) to camelCase in JS objects.
        // e.g. DB column pickup_address → trip.pickupAddress in JS
        const formattedTrips = trips.map(trip => ({
            tripId:        trip.id,               // ✅ was trip.trip_id       → trip.id
            status:        trip.status,
            pickupAddress: trip.pickupAddress,     // ✅ was trip.pickup_address
            dropoffAddress:trip.dropoffAddress,    // ✅ was trip.dropoff_address
            pickupLat:     trip.pickupLat,         // ✅ was trip.pickup_lat
            pickupLng:     trip.pickupLng,         // ✅ was trip.pickup_lng
            dropoffLat:    trip.dropoffLat,        // ✅ was trip.dropoff_lat
            dropoffLng:    trip.dropoffLng,        // ✅ was trip.dropoff_lng
            fareEstimate:  trip.fareEstimate,      // ✅ was trip.fare_estimate
            finalFare:     trip.fareFinal,         // ✅ was trip.final_fare → trip.fareFinal
            distanceM:     trip.distanceM,         // ✅ was trip.distance_m
            durationS:     trip.durationS,         // ✅ was trip.duration_s
            paymentMethod: trip.paymentMethod,
            createdAt:     trip.createdAt,
            updatedAt:     trip.updatedAt,

            driver: trip.driver ? {
                uuid:      trip.driver.uuid,
                firstName: trip.driver.first_name,
                lastName:  trip.driver.last_name,
                phone:     trip.driver.phone_e164,
                avatar:    trip.driver.avatar_url,

                vehicle: trip.driver.driverProfile ? {
                    type:      trip.driver.driverProfile.vehicle_type,
                    plate:     trip.driver.driverProfile.vehicle_plate,
                    makeModel: trip.driver.driverProfile.vehicle_make_model,
                    color:     trip.driver.driverProfile.vehicle_color,
                    year:      trip.driver.driverProfile.vehicle_year,
                } : null,

                rating:     trip.driver.driverProfile?.rating_avg    || null,
                totalTrips: trip.driver.driverProfile?.total_trips || 0,
            } : null
        }));

        res.status(200).json({
            success: true,
            data: {
                trips: formattedTrips,
                count: formattedTrips.length
            }
        });

    } catch (error) {
        console.error('❌ [RECENT TRIPS] Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch recent trips',
            error: error.message
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET FARE ESTIMATE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Estimate fare before booking a trip
 * GET /api/trips/estimate?pickupLat=&pickupLng=&dropoffLat=&dropoffLng=
 */
exports.getFareEstimate = async (req, res, next) => {
    console.log('========================');
    console.log('💰 [TRIP_CONTROLLER:getFareEstimate] Request initiated');
    try {
        const { pickupLat, pickupLng, dropoffLat, dropoffLng } = req.query;

        if (!pickupLat || !pickupLng || !dropoffLat || !dropoffLng) {
            return res.status(400).json({
                error: true,
                message: 'pickupLat, pickupLng, dropoffLat, dropoffLng are all required'
            });
        }

        const pLat = parseFloat(pickupLat);
        const pLng = parseFloat(pickupLng);
        const dLat = parseFloat(dropoffLat);
        const dLng = parseFloat(dropoffLng);

        if (isNaN(pLat) || isNaN(pLng) || isNaN(dLat) || isNaN(dLng)) {
            return res.status(400).json({ error: true, message: 'Coordinates must be valid numbers' });
        }

        console.log(`📍 Estimating: (${pLat}, ${pLng}) → (${dLat}, ${dLng})`);

        const estimate = await fareCalculatorService.estimateFullTrip(pLat, pLng, dLat, dLng);

        if (estimate.error) {
            console.log('❌ [FARE ESTIMATE] Error:', estimate.message);
            return res.status(estimate.status || 400).json({
                error: true,
                message: estimate.message
            });
        }

        console.log(`✅ [FARE ESTIMATE] Fare: ${estimate.fare_estimate} XAF`);

        res.status(200).json({
            success: true,
            data: {
                fareEstimate:  estimate.fare_estimate,
                distanceM:     estimate.distance_m,
                durationS:     estimate.duration_s,
                distanceText:  estimate.distance_text,
                durationText:  estimate.duration_text,
                startAddress:  estimate.start_address,
                endAddress:    estimate.end_address,
                polyline:      estimate.polyline,
                currency:      'XAF',
                breakdown: {
                    base:            estimate.breakdown?.base            || 0,
                    distanceCharge:  estimate.breakdown?.distance_charge || 0,
                    timeCharge:      estimate.breakdown?.time_charge     || 0,
                    surgeMultiplier: estimate.breakdown?.surge_multiplier || 1.0,
                    minFare:         estimate.breakdown?.min_fare        || 0,
                }
            }
        });

    } catch (error) {
        console.error('❌ [FARE ESTIMATE] Error:', error.stack || error.message);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET TRIP DETAILS
// ═══════════════════════════════════════════════════════════════════════

exports.getTripDetails = async (req, res, next) => {
    console.log('========================');
    console.log('🔍 [TRIP_CONTROLLER:getTripDetails] Fetching trip details...');
    try {
        const { tripId } = req.params;
        console.log('🆔 Trip ID:', tripId);
        console.log('👤 Requesting User:', req.user.uuid);

        // Try Redis first (fast path for active trips)
        let trip = await redisHelpers.getJson(REDIS_KEYS.ACTIVE_TRIP(tripId));
        console.log('🧠 [REDIS] Fetched trip:', trip ? 'FOUND' : 'NOT FOUND');

        if (trip) {
            if (trip.passengerId !== req.user.uuid && trip.driverId !== req.user.uuid) {
                console.log('⚠️ Unauthorized access attempt:', req.user.uuid);
                const err = new Error('Unauthorized to view this trip');
                err.status = 403;
                throw err;
            }

            return res.status(200).json({
                message: 'Trip retrieved successfully',
                data: { trip, source: 'redis' }
            });
        }

        // Fallback to DB
        console.log('💽 [DB] Fetching trip from database...');
        trip = await Trip.findOne({
            where: { id: tripId },
            include: [
                {
                    model: Account,
                    as: 'driver',
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'],
                    required: false,
                    include: [
                        {
                            model: DriverProfile,
                            as: 'driverProfile',
                            attributes: [
                                'vehicle_type', 'vehicle_plate',
                                'vehicle_make_model', 'vehicle_color',
                                'vehicle_year', 'vehicle_photo_url',
                                'rating_avg', 'total_trips'
                            ],
                            required: false
                        }
                    ]
                }
            ]
        });

        if (!trip) {
            console.log('❌ Trip not found in DB');
            const err = new Error('Trip not found');
            err.status = 404;
            throw err;
        }

        if (trip.passengerId !== req.user.uuid && trip.driverId !== req.user.uuid) {
            console.log('⚠️ Unauthorized access attempt:', req.user.uuid);
            const err = new Error('Unauthorized to view this trip');
            err.status = 403;
            throw err;
        }

        console.log('✅ Trip found in database. Returning response.');
        res.status(200).json({
            message: 'Trip retrieved successfully',
            data: { trip, source: 'database' }
        });

    } catch (error) {
        console.error('❌ [GET TRIP] Error:', error.stack || error.message);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET ACTIVE TRIP
// ═══════════════════════════════════════════════════════════════════════

exports.getActiveTrip = async (req, res, next) => {
    console.log('========================');
    console.log('🔍 [TRIP_CONTROLLER:getActiveTrip] Checking for active trip...');
    try {
        console.log('👤 User UUID:', req.user.uuid);
        console.log('👤 User Type:', req.user.user_type);

        // For passengers: check Redis first (SEARCHING trips only exist here)
        if (req.user.user_type === 'PASSENGER') {
            const activeTripKey = `passenger:active_trip:${req.user.uuid}`;
            const activeTripRef = await redisHelpers.getJson(activeTripKey);
            console.log('🧠 [REDIS] Active trip reference:', activeTripRef);

            if (activeTripRef && activeTripRef.tripId) {
                const tripData = await redisHelpers.getJson(REDIS_KEYS.ACTIVE_TRIP(activeTripRef.tripId));
                if (tripData) {
                    console.log('✅ Active trip found in Redis:', activeTripRef.tripId);
                    return res.status(200).json({
                        message: 'Active trip retrieved',
                        data: { trip: tripData, source: 'redis' }
                    });
                }
            }
        }

        // Check DB for MATCHED and beyond (these are always in DB)
        console.log('💽 [DB] Checking for active trip in database...');
        const whereClause = req.user.user_type === 'PASSENGER'
            ? { passengerId: req.user.uuid }
            : { driverId: req.user.uuid };

        const activeTrip = await Trip.findOne({
            where: {
                ...whereClause,
                status: {
                    [Op.in]: ['MATCHED', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS']
                }
            },
            include: [
                {
                    model: Account,
                    as: 'driver',
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'],
                    required: false,
                    include: [
                        {
                            model: DriverProfile,
                            as: 'driverProfile',
                            attributes: [
                                'vehicle_type', 'vehicle_plate',
                                'vehicle_make_model', 'vehicle_color',
                                'vehicle_year', 'vehicle_photo_url',
                                'rating_avg'
                            ],
                            required: false
                        }
                    ]
                }
            ],
            order: [['createdAt', 'DESC']]
        });

        if (!activeTrip) {
            console.log('⚠️ No active trip found.');
            return res.status(200).json({
                message: 'No active trip',
                data: { trip: null }
            });
        }

        console.log('✅ Active trip found in DB:', activeTrip.id, '— Status:', activeTrip.status);
        res.status(200).json({
            message: 'Active trip retrieved',
            data: { trip: activeTrip, source: 'database' }
        });

    } catch (error) {
        console.error('❌ [ACTIVE TRIP] Error:', error.stack || error.message);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET TRIP HISTORY
// ═══════════════════════════════════════════════════════════════════════

exports.getTripHistory = async (req, res, next) => {
    console.log('========================');
    console.log('📜 [TRIP_CONTROLLER:getTripHistory] Fetching trip history...');
    try {
        const { page = 1, limit = 20 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        console.log(`🔢 Page: ${page}, Limit: ${limit}, Offset: ${offset}`);
        console.log('👤 User UUID:', req.user.uuid);

        const whereClause = req.user.user_type === 'PASSENGER'
            ? { passengerId: req.user.uuid }
            : { driverId: req.user.uuid };

        const { count, rows: trips } = await Trip.findAndCountAll({
            where: {
                ...whereClause,
                status: {
                    [Op.in]: ['COMPLETED', 'CANCELED']
                }
            },
            include: [
                {
                    model: Account,
                    as: 'driver',
                    attributes: ['uuid', 'first_name', 'last_name', 'avatar_url'],
                    required: false,
                    include: [
                        {
                            model: DriverProfile,
                            as: 'driverProfile',
                            attributes: ['vehicle_type', 'vehicle_plate', 'vehicle_make_model', 'rating_avg'],
                            required: false
                        }
                    ]
                }
            ],
            order: [['createdAt', 'DESC']],
            limit: parseInt(limit),
            offset
        });

        console.log(`✅ Retrieved ${trips.length} trips (Total: ${count})`);

        res.status(200).json({
            message: 'Trip history retrieved',
            data: {
                trips,
                pagination: {
                    total: count,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    totalPages: Math.ceil(count / parseInt(limit))
                }
            }
        });

    } catch (error) {
        console.error('❌ [TRIP HISTORY] Error:', error.stack || error.message);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET TRIP EVENTS
// ═══════════════════════════════════════════════════════════════════════

exports.getTripEvents = async (req, res, next) => {
    console.log('========================');
    console.log('📋 [TRIP_CONTROLLER:getTripEvents] Fetching trip events...');
    try {
        const { tripId } = req.params;
        console.log('🆔 Trip ID:', tripId);

        const trip = await Trip.findOne({ where: { id: tripId } });

        if (!trip) {
            console.log('❌ Trip not found in database');
            const err = new Error('Trip not found');
            err.status = 404;
            throw err;
        }

        if (trip.passengerId !== req.user.uuid && trip.driverId !== req.user.uuid) {
            console.log('⚠️ Unauthorized access to trip events by:', req.user.uuid);
            const err = new Error('Unauthorized to view trip events');
            err.status = 403;
            throw err;
        }

        console.log('💽 [DB] Fetching trip events...');
        const events = await TripEvent.findAll({
            where: { tripId },
            order: [['createdAt', 'ASC']]
        });

        console.log(`✅ Retrieved ${events.length} events for trip ${tripId}`);

        res.status(200).json({
            message: 'Trip events retrieved',
            data: { events }
        });

    } catch (error) {
        console.error('❌ [TRIP EVENTS] Error:', error.stack || error.message);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// CANCEL TRIP (PASSENGER OR DRIVER)
// ═══════════════════════════════════════════════════════════════════════

exports.cancelTrip = async (req, res, next) => {
    console.log('========================');
    console.log('🚫 [TRIP_CONTROLLER:cancelTrip] Request initiated');
    try {
        const { tripId } = req.params;
        const { reason } = req.body;
        const userId = req.user.uuid;
        const userType = req.user.user_type;

        console.log('🆔 Trip ID:', tripId);
        console.log('👤 User:', userId);
        console.log('👤 User Type:', userType);
        console.log('📝 Reason:', reason || 'No reason provided');

        // Try Redis first
        let trip = await redisHelpers.getJson(REDIS_KEYS.ACTIVE_TRIP(tripId));
        let fromRedis = true;

        if (!trip) {
            console.log('💽 [DB] Trip not in Redis, checking database...');
            trip = await Trip.findOne({ where: { id: tripId } });
            fromRedis = false;

            if (!trip) {
                console.log('❌ Trip not found');
                const err = new Error('Trip not found');
                err.status = 404;
                throw err;
            }
        }

        // Authorization check
        const isPassenger = trip.passengerId === userId;
        const isDriver    = trip.driverId    === userId;

        if (!isPassenger && !isDriver) {
            console.log('⚠️ Unauthorized cancellation attempt');
            const err = new Error('Unauthorized to cancel this trip');
            err.status = 403;
            throw err;
        }

        // Check if status allows cancellation
        const cancelableStatuses = ['SEARCHING', 'MATCHED', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED'];
        if (!cancelableStatuses.includes(trip.status)) {
            console.log(`⚠️ Cannot cancel trip in status: ${trip.status}`);
            return res.status(400).json({
                success: false,
                message: `Cannot cancel a trip that is already ${trip.status}`
            });
        }

        const canceledBy = isPassenger ? 'PASSENGER' : 'DRIVER';
        console.log(`🚫 Trip being canceled by: ${canceledBy}`);

        // ── CASE 1: Trip only in Redis (still SEARCHING, no driver yet) ──────
        if (fromRedis && trip.status === 'SEARCHING') {
            console.log('🧠 [REDIS] Canceling SEARCHING trip from Redis');

            await redisClient.del(REDIS_KEYS.ACTIVE_TRIP(tripId));
            await redisClient.del(`passenger:active_trip:${trip.passengerId}`);
            await redisClient.del(REDIS_KEYS.TRIP_OFFERS(tripId));
            await redisClient.del(`trip:timeout:${tripId}`);

            const io = getIO();
            const cancelPayload = { tripId, canceledBy, reason: reason || 'Trip canceled' };

            io.to(`passenger:${trip.passengerId}`).emit('trip:canceled', cancelPayload);
            io.to(`user:${trip.passengerId}`).emit('trip:canceled', cancelPayload);

            console.log('✅ SEARCHING trip canceled (Redis only)');

            return res.status(200).json({
                success: true,
                message: 'Trip canceled successfully',
                data: { tripId, status: 'CANCELED', canceledBy }
            });
        }

        // ── CASE 2: Trip in database (MATCHED or beyond) ─────────────────────
        console.log('💽 [DB] Updating trip status to CANCELED');

        let dbTrip = trip;
        if (fromRedis) {
            dbTrip = await Trip.findOne({ where: { id: tripId } });
            if (!dbTrip) {
                const err = new Error('Trip not found in database');
                err.status = 404;
                throw err;
            }
        }

        dbTrip.status     = 'CANCELED';
        dbTrip.canceledBy = canceledBy;
        dbTrip.cancelReason = reason || null;
        dbTrip.canceledAt = new Date();
        await dbTrip.save();

        // Create audit event
        await TripEvent.create({
            id: uuidv4(),
            tripId: tripId,
            type: 'trip_canceled',
            payload: {
                canceledBy,
                reason: reason || 'No reason provided'
            }
        });

        // ✅ FIX LOW: locationService is now imported at top — no dynamic require()
        if (dbTrip.driverId) {
            await locationService.updateDriverStatus(dbTrip.driverId, 'available', null);
            console.log(`✅ Driver ${dbTrip.driverId} status reset to available`);
        }

        // Clean up all Redis keys
        await redisClient.del(REDIS_KEYS.ACTIVE_TRIP(tripId));
        await redisClient.del(`passenger:active_trip:${dbTrip.passengerId}`);
        await redisClient.del(`trip:timeout:${tripId}`);
        await redisClient.del(`trip:accepting:${tripId}`);
        await redisClient.del(`trip:no_expire:${tripId}`);
        if (dbTrip.driverId) {
            await redisClient.del(`driver:active_trip:${dbTrip.driverId}`);
        }

        // Notify all parties via Socket.IO
        const io = getIO();
        const cancelData = {
            tripId,
            status: 'CANCELED',
            canceledBy,
            reason: reason || 'Trip canceled'
        };

        io.to(`passenger:${dbTrip.passengerId}`).emit('trip:canceled', cancelData);
        io.to(`user:${dbTrip.passengerId}`).emit('trip:canceled', cancelData);

        if (dbTrip.driverId) {
            io.to(`driver:${dbTrip.driverId}`).emit('trip:canceled', cancelData);
            io.to(`user:${dbTrip.driverId}`).emit('trip:canceled', cancelData);
        }

        console.log('✅ Trip canceled successfully');

        res.status(200).json({
            success: true,
            message: 'Trip canceled successfully',
            data: {
                tripId,
                status: 'CANCELED',
                canceledBy,
                canceledAt: dbTrip.canceledAt
            }
        });

    } catch (error) {
        console.error('❌ [CANCEL TRIP] Error:', error.stack || error.message);
        next(error);
    }
};