// src/controllers/tripController.js
const { v4: uuidv4 } = require('uuid');
const { Trip, TripEvent, Account } = require('../models');
const fareCalculatorService = require('../services/fareCalculatorService');
const tripMatchingService = require('../services/tripMatchingService');
const { redisClient, redisHelpers, REDIS_KEYS } = require('../config/redis');
const { getIO } = require('../sockets'); // ✅ FIXED: Changed from '../socket' to '../sockets'

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
                status: ['MATCHED', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS']
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
            parseFloat(pickupLat),
            parseFloat(pickupLng),
            parseFloat(dropoffLat),
            parseFloat(dropoffLng)
        );
        console.log('📏 [CREATE TRIP] Estimate:', estimate);

        // Generate trip ID
        const tripId = uuidv4();
        console.log('🆔 [CREATE TRIP] Generated tripId:', tripId);

        // Prepare trip data
        const tripData = {
            id: tripId,
            passengerId: req.user.uuid,
            status: 'SEARCHING',
            pickupLat: parseFloat(pickupLat),
            pickupLng: parseFloat(pickupLng),
            pickupAddress: pickupAddress || estimate.start_address,
            dropoffLat: parseFloat(dropoffLat),
            dropoffLng: parseFloat(dropoffLng),
            dropoffAddress: dropoffAddress || estimate.end_address,
            routePolyline: estimate.polyline,
            distanceM: estimate.distance_m,
            durationS: estimate.duration_s,
            fareEstimate: estimate.fare_estimate,
            paymentMethod: payment_method || 'CASH',
            createdAt: new Date().toISOString()
        };
        console.log('💾 [CREATE TRIP] Trip data prepared:', tripData);

        // Calculate TTL (time to live) for Redis
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
        const io = getIO(); // ✅ Get Socket.IO instance
        const broadcast = await tripMatchingService.broadcastTripToDrivers(tripId, io);
        console.log('📡 [CREATE TRIP] Broadcast result:', broadcast);

        // Handle no drivers available
        if (!broadcast.success && broadcast.reason === 'No drivers available') {
            console.log('❌ [CREATE TRIP] No drivers available. Cleaning Redis.');
            await redisClient.del(REDIS_KEYS.ACTIVE_TRIP(tripId));
            await redisClient.del(existingActiveTripKey);
            return res.status(200).json({
                error: true,
                message: 'No drivers available in your area. Please try again later.',
                data: null
            });
        }

        console.log('✅ [CREATE TRIP] Trip successfully created in Redis:', tripId);

        // Send success response
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
// GET TRIP DETAILS
// ═══════════════════════════════════════════════════════════════════════

exports.getTripDetails = async (req, res, next) => {
    console.log('========================');
    console.log('🔍 [TRIP_CONTROLLER:getTripDetails] Fetching trip details...');
    try {
        const { tripId } = req.params;
        console.log('🆔 Trip ID:', tripId);
        console.log('👤 Requesting User:', req.user.uuid);

        // Try to get trip from Redis first
        let trip = await redisHelpers.getJson(REDIS_KEYS.ACTIVE_TRIP(tripId));
        console.log('🧠 [REDIS] Fetched trip:', trip ? 'FOUND' : 'NOT FOUND');

        if (trip) {
            // Authorization check
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

        // If not in Redis, check database
        console.log('💽 [DB] Fetching trip from database...');
        trip = await Trip.findOne({ where: { id: tripId } });

        if (!trip) {
            console.log('❌ Trip not found in DB');
            const err = new Error('Trip not found');
            err.status = 404;
            throw err;
        }

        // Authorization check for database trip
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

        // For passengers, check Redis first
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

        // Check database for active trip
        console.log('💽 [DB] Checking for active trip in database...');
        const whereClause = req.user.user_type === 'PASSENGER'
            ? { passengerId: req.user.uuid }
            : { driverId: req.user.uuid };

        const activeTrip = await Trip.findOne({
            where: {
                ...whereClause,
                status: ['MATCHED', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS']
            },
            order: [['createdAt', 'DESC']]
        });

        if (!activeTrip) {
            console.log('⚠️ No active trip found.');
            return res.status(200).json({
                message: 'No active trip',
                data: { trip: null }
            });
        }

        console.log('✅ Active trip found in DB:', activeTrip.id);
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

        // Build where clause based on user type
        const whereClause = req.user.user_type === 'PASSENGER'
            ? { passengerId: req.user.uuid }
            : { driverId: req.user.uuid };

        // Fetch completed and canceled trips
        const { count, rows: trips } = await Trip.findAndCountAll({
            where: {
                ...whereClause,
                status: ['COMPLETED', 'CANCELED']
            },
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

        // Check if trip exists
        const trip = await Trip.findOne({ where: { id: tripId } });

        if (!trip) {
            console.log('❌ Trip not found in database');
            const err = new Error('Trip not found');
            err.status = 404;
            throw err;
        }

        // Authorization check
        if (trip.passengerId !== req.user.uuid && trip.driverId !== req.user.uuid) {
            console.log('⚠️ Unauthorized access to trip events by:', req.user.uuid);
            const err = new Error('Unauthorized to view trip events');
            err.status = 403;
            throw err;
        }

        // Fetch trip events
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