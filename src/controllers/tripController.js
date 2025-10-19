// src/controllers/trip.controller.js
const { v4: uuidv4 } = require('uuid');
const { Trip, TripEvent, Account } = require('../models');
const fareCalculatorService = require('../services/fareCalculatorService');
const tripMatchingService = require('../services/tripMatchingService');
const { redisClient, redisHelpers, REDIS_KEYS } = require('../config/redis');

exports.createTrip = async (req, res, next) => {
    console.log('========================');
    console.log('🚗 [TRIP_CONTROLLER:createTrip] Request initiated');
    try {
        console.log('👤 User UUID:', req.user.uuid);
        console.log('👤 User Type:', req.user.user_type);

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

        if (!pickupLat || !pickupLng || !dropoffLat || !dropoffLng) {
            console.log('❌ [CREATE TRIP] Missing coordinates.');
            const err = new Error('Pickup and dropoff coordinates are required');
            err.status = 400;
            throw err;
        }

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

        console.log('🔍 [DB] Checking for active trips in database...');
        const dbActiveTrip = await Trip.findOne({
            where: {
                passengerId: req.user.uuid,
                status: ['matched', 'driver_en_route', 'arrived_pickup', 'in_progress']
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

        console.log('📍 [CREATE TRIP] Estimating route and fare...');
        const estimate = await fareCalculatorService.estimateFullTrip(
            parseFloat(pickupLat),
            parseFloat(pickupLng),
            parseFloat(dropoffLat),
            parseFloat(dropoffLng)
        );
        console.log('📏 [CREATE TRIP] Estimate:', estimate);

        const tripId = uuidv4();
        console.log('🆔 [CREATE TRIP] Generated tripId:', tripId);

        const tripData = {
            id: tripId,
            passengerId: req.user.uuid,
            status: 'searching',
            pickupLat: parseFloat(pickupLat),
            pickupLng: parseFloat(pickupLng),
            pickupAddress: pickupAddress || estimate.start_address,
            dropoffLat: parseFloat(dropoffLat),
            dropoffLng: parseFloat(dropoffLng),
            dropoffAddress: dropoffAddress || estimate.end_address,
            routePolyline: estimate.polyline,
            distance_m: estimate.distance_m,
            duration_s: estimate.duration_s,
            fare_estimate: estimate.fare_estimate,
            payment_method: payment_method || 'cash',
            createdAt: new Date().toISOString()
        };
        console.log('💾 [CREATE TRIP] Trip data prepared:', tripData);

        const ttl = parseInt(process.env.OFFER_TTL_MS || 20000, 10) / 1000 + 60;
        console.log('⏳ [CREATE TRIP] TTL for Redis (seconds):', ttl);

        console.log('🧠 [REDIS] Saving trip data to Redis...');
        await redisHelpers.setJson(REDIS_KEYS.ACTIVE_TRIP(tripId), tripData, ttl);

        console.log('🧠 [REDIS] Saving passenger active trip reference...');
        await redisHelpers.setJson(existingActiveTripKey, { tripId, status: 'searching' }, ttl);

        console.log('📢 [CREATE TRIP] Broadcasting trip to nearby drivers...');
        const broadcast = await tripMatchingService.broadcastTripToDrivers(tripId, req.io);
        console.log('📡 [CREATE TRIP] Broadcast result:', broadcast);

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

// -------------------------------------------------

exports.getTripDetails = async (req, res, next) => {
    console.log('========================');
    console.log('🔍 [TRIP_CONTROLLER:getTripDetails] Fetching trip details...');
    try {
        const { tripId } = req.params;
        console.log('🆔 Trip ID:', tripId);
        console.log('👤 Requesting User:', req.user.uuid);

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

        console.log('💽 [DB] Fetching trip from database...');
        trip = await Trip.findOne({ where: { id: tripId } });

        if (!trip) {
            console.log('❌ Trip not found in DB');
            const err = new Error('Trip not found');
            err.status = 404;
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

// -------------------------------------------------

exports.getActiveTrip = async (req, res, next) => {
    console.log('========================');
    console.log('🔍 [TRIP_CONTROLLER:getActiveTrip] Checking for active trip...');
    try {
        console.log('👤 User UUID:', req.user.uuid);
        console.log('👤 User Type:', req.user.user_type);

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

        console.log('💽 [DB] Checking for active trip in database...');
        const whereClause = req.user.user_type === 'PASSENGER'
            ? { passengerId: req.user.uuid }
            : { driverId: req.user.uuid };

        const activeTrip = await Trip.findOne({
            where: {
                ...whereClause,
                status: ['matched', 'driver_en_route', 'arrived_pickup', 'in_progress']
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

// -------------------------------------------------

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
            where: { ...whereClause, status: ['completed', 'canceled'] },
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

// -------------------------------------------------

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
