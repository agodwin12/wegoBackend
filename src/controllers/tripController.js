// src/controllers/tripController.js

const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize');
const { Trip, TripEvent, Account, DriverProfile } = require('../models');
const fareCalculatorService = require('../services/fareCalculatorService');
const tripMatchingService   = require('../services/tripMatchingService');
const locationService       = require('../services/locationService');
const campayService         = require('../services/campay/campayService');
const { redisClient, redisHelpers, REDIS_KEYS } = require('../config/redis');
const { getIO } = require('../sockets');

// ── Notification service (lazy — avoids circular dep at startup) ──────────────
const getNotificationService = () => require('../services/NotificationService');

// Payment methods that require CamPay confirmation before driver matching starts
const DIGITAL_PAYMENT_METHODS = ['MOMO', 'OM'];

// ═══════════════════════════════════════════════════════════════════════
// CREATE TRIP (PASSENGER)
// ═══════════════════════════════════════════════════════════════════════

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
            payment_method,
        } = req.body;

        console.log('📦 [CREATE TRIP] Received body:', req.body);

        if (!pickupLat || !pickupLng || !dropoffLat || !dropoffLng) {
            console.log('❌ [CREATE TRIP] Missing coordinates.');
            const err = new Error('Pickup and dropoff coordinates are required');
            err.status = 400;
            throw err;
        }

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

        const existingActiveTripKey = `passenger:active_trip:${req.user.uuid}`;
        const existingActiveTrip    = await redisHelpers.getJson(existingActiveTripKey);
        console.log('🔍 [REDIS] Checking for existing active trip key:', existingActiveTripKey);

        if (existingActiveTrip) {
            console.log('⚠️ [CREATE TRIP] Active trip already found in Redis:', existingActiveTrip);
            return res.status(409).json({
                error:   true,
                message: 'You already have an active trip',
                data:    { tripId: existingActiveTrip.tripId },
            });
        }

        console.log('🔍 [DB] Checking for active trips in database...');
        const dbActiveTrip = await Trip.findOne({
            where: {
                passengerId: req.user.uuid,
                status: {
                    [Op.in]: ['SEARCHING', 'MATCHED', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS'],
                },
            },
        });

        if (dbActiveTrip) {
            console.log('⚠️ [CREATE TRIP] Active trip found in DB:', dbActiveTrip.id);
            return res.status(409).json({
                error:   true,
                message: 'You already have an active trip',
                data:    { tripId: dbActiveTrip.id },
            });
        }

        console.log('📍 [CREATE TRIP] Estimating route and fare...');
        const estimate = await fareCalculatorService.estimateFullTrip(pLat, pLng, dLat, dLng);
        console.log('📏 [CREATE TRIP] Estimate:', estimate);

        if (estimate.error) {
            console.log('❌ [CREATE TRIP] Fare estimation failed:', estimate.message);
            return res.status(estimate.status || 400).json({
                error:   true,
                message: estimate.message || 'Failed to calculate route. Please check your pickup and dropoff locations.',
                data:    null,
            });
        }

        const tripId        = uuidv4();
        const paymentMethod = (payment_method || 'CASH').toUpperCase();

        console.log('🆔 [CREATE TRIP] Generated tripId:', tripId);
        console.log('💳 [CREATE TRIP] Payment method:', paymentMethod);

        const tripData = {
            id:             tripId,
            passengerId:    req.user.uuid,
            status:         'SEARCHING',
            pickupLat:      pLat,
            pickupLng:      pLng,
            pickupAddress:  pickupAddress  || estimate.start_address,
            dropoffLat:     dLat,
            dropoffLng:     dLng,
            dropoffAddress: dropoffAddress || estimate.end_address,
            routePolyline:  estimate.polyline,
            distanceM:      estimate.distance_m,
            durationS:      estimate.duration_s,
            fareEstimate:   estimate.fare_estimate,
            fareBreakdown:  estimate.breakdown || null,
            paymentMethod,
            createdAt:      new Date().toISOString(),
        };

        const ttl = parseInt(process.env.OFFER_TTL_MS || 20000, 10) / 1000 + 60;
        console.log('⏳ [CREATE TRIP] TTL for Redis (seconds):', ttl);

        console.log('💾 [DB] Persisting SEARCHING trip to database...');
        await Trip.create({
            id:             tripId,
            passengerId:    req.user.uuid,
            status:         'SEARCHING',
            pickupLat:      pLat,
            pickupLng:      pLng,
            pickupAddress:  tripData.pickupAddress,
            dropoffLat:     dLat,
            dropoffLng:     dLng,
            dropoffAddress: tripData.dropoffAddress,
            distanceM:      estimate.distance_m,
            durationS:      estimate.duration_s,
            fareEstimate:   estimate.fare_estimate,
            routePolyline:  estimate.polyline,
            paymentMethod,
        });
        console.log('✅ [DB] Trip persisted with status=SEARCHING');

        console.log('🧠 [REDIS] Saving trip data to Redis...');
        await redisHelpers.setJson(REDIS_KEYS.ACTIVE_TRIP(tripId), tripData, ttl);
        await redisHelpers.setJson(existingActiveTripKey, { tripId, status: 'SEARCHING' }, ttl);

        const isDigitalPayment = DIGITAL_PAYMENT_METHODS.includes(paymentMethod);
        let driversNotified    = 0;

        if (!isDigitalPayment) {
            console.log('📢 [CREATE TRIP] Cash payment — broadcasting to nearby drivers...');
            const io        = getIO();
            const broadcast = await tripMatchingService.broadcastTripToDrivers(tripId, io);
            console.log('📡 [CREATE TRIP] Broadcast result:', broadcast);
            driversNotified = broadcast.driversNotified || 0;
        } else {
            console.log(`💳 [CREATE TRIP] Digital payment (${paymentMethod}) — holding matching until payment confirmed`);
        }

        console.log('✅ [CREATE TRIP] Trip successfully created:', tripId);

        res.status(201).json({
            message: isDigitalPayment
                ? 'Trip created. Please complete your mobile money payment to find a driver.'
                : 'Trip created successfully, searching for drivers...',
            requiresPayment: isDigitalPayment,
            data: {
                trip:            tripData,
                driversNotified,
            },
        });

    } catch (error) {
        console.error('❌ [CREATE TRIP] Error:', error.stack || error.message);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// INITIATE TRIP PAYMENT
// ═══════════════════════════════════════════════════════════════════════

exports.initiatePayment = async (req, res, next) => {
    console.log('========================');
    console.log('💳 [TRIP_CONTROLLER:initiatePayment] Request initiated');
    try {
        const { tripId }  = req.params;
        const { phone }   = req.body;
        const passengerId = req.user.uuid;

        console.log(`🆔 Trip: ${tripId} | Passenger: ${passengerId} | Phone: ${phone}`);

        if (!phone) {
            return res.status(400).json({
                success: false,
                error:   'MISSING_PHONE',
                message: 'phone is required — the mobile money number to charge.',
            });
        }

        const trip = await Trip.findOne({
            where:      { id: tripId, passengerId },
            attributes: ['id', 'passengerId', 'status', 'paymentMethod', 'fareEstimate'],
        });

        if (!trip) {
            return res.status(404).json({
                success: false,
                error:   'TRIP_NOT_FOUND',
                message: 'Trip not found.',
            });
        }

        if (!DIGITAL_PAYMENT_METHODS.includes(trip.paymentMethod)) {
            return res.status(400).json({
                success: false,
                error:   'NOT_DIGITAL_PAYMENT',
                message: 'This trip uses cash payment — no mobile money charge required.',
            });
        }

        if (trip.status !== 'SEARCHING') {
            return res.status(409).json({
                success: false,
                error:   'TRIP_NOT_SEARCHING',
                message: `Trip is already ${trip.status} — payment may have already been processed.`,
            });
        }

        const { WegoPayment } = require('../models');
        const existingPayment = await WegoPayment.findOne({
            where: {
                vertical:    'trip',
                vertical_id: tripId,
                status:      { [Op.in]: ['PENDING', 'SUCCESSFUL'] },
            },
        });

        if (existingPayment) {
            return res.status(409).json({
                success: false,
                error:   'PAYMENT_ALREADY_INITIATED',
                message: existingPayment.status === 'SUCCESSFUL'
                    ? 'Payment already confirmed — your trip is being matched.'
                    : 'Payment already initiated. Please approve the prompt on your phone.',
                data: {
                    paymentId: existingPayment.id,
                    campayRef: existingPayment.campay_ref,
                    status:    existingPayment.status,
                },
            });
        }

        const campayResult = await campayService.initiateCollection({
            vertical:    'trip',
            verticalId:  tripId,
            phone,
            initiatedBy: passengerId,
        });

        console.log(`✅ [PAY TRIP] Payment initiated — campayRef: ${campayResult.campayRef}`);

        return res.status(200).json({
            success: true,
            data: {
                pending:     true,
                paymentId:   campayResult.paymentId,
                campayRef:   campayResult.campayRef,
                externalRef: campayResult.externalRef,
                ussdCode:    campayResult.ussdCode  || null,
                operator:    campayResult.operator  || null,
                amount:      trip.fareEstimate,
                currency:    'XAF',
                message:     'A payment prompt has been sent to your phone. Approve it to find a driver.',
            },
        });

    } catch (error) {
        console.error('❌ [PAY TRIP] Error:', error.message);
        if (error.message?.includes('[CAMPAY')) {
            return res.status(502).json({
                success: false,
                error:   'CAMPAY_ERROR',
                message: 'Could not initiate payment. Please check your number and try again.',
            });
        }
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET RECENT TRIPS
// ═══════════════════════════════════════════════════════════════════════

exports.getRecentTrips = async (req, res) => {
    try {
        const userId = req.user.uuid;
        const limit  = parseInt(req.query.limit) || 10;

        const trips = await Trip.findAll({
            where: {
                passengerId: userId,
                status:      { [Op.in]: ['COMPLETED', 'CANCELED'] },
            },
            include: [
                {
                    model:      Account,
                    as:         'driver',
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'],
                    required:   false,
                    include: [
                        {
                            model:      DriverProfile,
                            as:         'driverProfile',
                            attributes: [
                                'vehicle_type', 'vehicle_plate', 'vehicle_make_model',
                                'vehicle_color', 'vehicle_year', 'rating_avg', 'total_trips',
                            ],
                            required: false,
                        },
                    ],
                },
            ],
            order: [['updatedAt', 'DESC']],
            limit,
        });

        const formattedTrips = trips.map(trip => ({
            tripId:         trip.id,
            status:         trip.status,
            pickupAddress:  trip.pickupAddress,
            dropoffAddress: trip.dropoffAddress,
            pickupLat:      trip.pickupLat,
            pickupLng:      trip.pickupLng,
            dropoffLat:     trip.dropoffLat,
            dropoffLng:     trip.dropoffLng,
            fareEstimate:   trip.fareEstimate,
            finalFare:      trip.fareFinal,
            distanceM:      trip.distanceM,
            durationS:      trip.durationS,
            paymentMethod:  trip.paymentMethod,
            createdAt:      trip.createdAt,
            updatedAt:      trip.updatedAt,
            driver: trip.driver ? {
                uuid:       trip.driver.uuid,
                firstName:  trip.driver.first_name,
                lastName:   trip.driver.last_name,
                phone:      trip.driver.phone_e164,
                avatar:     trip.driver.avatar_url,
                vehicle: trip.driver.driverProfile ? {
                    type:      trip.driver.driverProfile.vehicle_type,
                    plate:     trip.driver.driverProfile.vehicle_plate,
                    makeModel: trip.driver.driverProfile.vehicle_make_model,
                    color:     trip.driver.driverProfile.vehicle_color,
                    year:      trip.driver.driverProfile.vehicle_year,
                } : null,
                rating:     trip.driver.driverProfile?.rating_avg  || null,
                totalTrips: trip.driver.driverProfile?.total_trips || 0,
            } : null,
        }));

        res.status(200).json({
            success: true,
            data:    { trips: formattedTrips, count: formattedTrips.length },
        });

    } catch (error) {
        console.error('❌ [RECENT TRIPS] Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch recent trips',
            error:   error.message,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET FARE ESTIMATE
// ═══════════════════════════════════════════════════════════════════════

exports.getFareEstimate = async (req, res, next) => {
    console.log('========================');
    console.log('💰 [TRIP_CONTROLLER:getFareEstimate] Request initiated');
    try {
        const { pickupLat, pickupLng, dropoffLat, dropoffLng } = req.query;

        if (!pickupLat || !pickupLng || !dropoffLat || !dropoffLng) {
            return res.status(400).json({
                error:   true,
                message: 'pickupLat, pickupLng, dropoffLat, dropoffLng are all required',
            });
        }

        const pLat = parseFloat(pickupLat);
        const pLng = parseFloat(pickupLng);
        const dLat = parseFloat(dropoffLat);
        const dLng = parseFloat(dropoffLng);

        if (isNaN(pLat) || isNaN(pLng) || isNaN(dLat) || isNaN(dLng)) {
            return res.status(400).json({ error: true, message: 'Coordinates must be valid numbers' });
        }

        const estimate = await fareCalculatorService.estimateFullTrip(pLat, pLng, dLat, dLng);

        if (estimate.error) {
            return res.status(estimate.status || 400).json({ error: true, message: estimate.message });
        }

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
                    base:            estimate.breakdown?.base             || 0,
                    distanceCharge:  estimate.breakdown?.distance_charge  || 0,
                    timeCharge:      estimate.breakdown?.time_charge      || 0,
                    surgeMultiplier: estimate.breakdown?.surge_multiplier || 1.0,
                    minFare:         estimate.breakdown?.min_fare         || 0,
                },
            },
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
    try {
        const { tripId } = req.params;

        let trip = await redisHelpers.getJson(REDIS_KEYS.ACTIVE_TRIP(tripId));

        if (trip) {
            if (trip.passengerId !== req.user.uuid && trip.driverId !== req.user.uuid) {
                const err = new Error('Unauthorized to view this trip');
                err.status = 403;
                throw err;
            }
            return res.status(200).json({
                message: 'Trip retrieved successfully',
                data:    { trip, source: 'redis' },
            });
        }

        trip = await Trip.findOne({
            where:   { id: tripId },
            include: [
                {
                    model:      Account,
                    as:         'driver',
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'],
                    required:   false,
                    include: [
                        {
                            model:      DriverProfile,
                            as:         'driverProfile',
                            attributes: [
                                'vehicle_type', 'vehicle_plate', 'vehicle_make_model',
                                'vehicle_color', 'vehicle_year', 'vehicle_photo_url',
                                'rating_avg', 'total_trips',
                            ],
                            required: false,
                        },
                    ],
                },
            ],
        });

        if (!trip) {
            const err = new Error('Trip not found');
            err.status = 404;
            throw err;
        }

        if (trip.passengerId !== req.user.uuid && trip.driverId !== req.user.uuid) {
            const err = new Error('Unauthorized to view this trip');
            err.status = 403;
            throw err;
        }

        res.status(200).json({
            message: 'Trip retrieved successfully',
            data:    { trip, source: 'database' },
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
    try {
        if (req.user.user_type === 'PASSENGER') {
            const activeTripKey = `passenger:active_trip:${req.user.uuid}`;
            const activeTripRef = await redisHelpers.getJson(activeTripKey);

            if (activeTripRef && activeTripRef.tripId) {
                const tripData = await redisHelpers.getJson(REDIS_KEYS.ACTIVE_TRIP(activeTripRef.tripId));
                if (tripData) {
                    return res.status(200).json({
                        message: 'Active trip retrieved',
                        data:    { trip: tripData, source: 'redis' },
                    });
                }
            }
        }

        const whereClause = req.user.user_type === 'PASSENGER'
            ? { passengerId: req.user.uuid }
            : { driverId:    req.user.uuid };

        const activeTrip = await Trip.findOne({
            where: {
                ...whereClause,
                status: {
                    [Op.in]: ['SEARCHING', 'MATCHED', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS'],
                },
            },
            include: [
                {
                    model:      Account,
                    as:         'driver',
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'],
                    required:   false,
                    include: [
                        {
                            model:      DriverProfile,
                            as:         'driverProfile',
                            attributes: [
                                'vehicle_type', 'vehicle_plate', 'vehicle_make_model',
                                'vehicle_color', 'vehicle_year', 'vehicle_photo_url', 'rating_avg',
                            ],
                            required: false,
                        },
                    ],
                },
            ],
            order: [['createdAt', 'DESC']],
        });

        if (!activeTrip) {
            return res.status(200).json({
                message: 'No active trip',
                data:    { trip: null },
            });
        }

        res.status(200).json({
            message: 'Active trip retrieved',
            data:    { trip: activeTrip, source: 'database' },
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
    try {
        const { page = 1, limit = 20 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        const whereClause = req.user.user_type === 'PASSENGER'
            ? { passengerId: req.user.uuid }
            : { driverId:    req.user.uuid };

        const { count, rows: trips } = await Trip.findAndCountAll({
            where: {
                ...whereClause,
                status: { [Op.in]: ['COMPLETED', 'CANCELED'] },
            },
            include: [
                {
                    model:      Account,
                    as:         'driver',
                    attributes: ['uuid', 'first_name', 'last_name', 'avatar_url'],
                    required:   false,
                    include: [
                        {
                            model:      DriverProfile,
                            as:         'driverProfile',
                            attributes: ['vehicle_type', 'vehicle_plate', 'vehicle_make_model', 'rating_avg'],
                            required:   false,
                        },
                    ],
                },
            ],
            order:  [['createdAt', 'DESC']],
            limit:  parseInt(limit),
            offset,
        });

        res.status(200).json({
            message: 'Trip history retrieved',
            data: {
                trips,
                pagination: {
                    total:      count,
                    page:       parseInt(page),
                    limit:      parseInt(limit),
                    totalPages: Math.ceil(count / parseInt(limit)),
                },
            },
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
    try {
        const { tripId } = req.params;

        const trip = await Trip.findOne({ where: { id: tripId } });

        if (!trip) {
            const err = new Error('Trip not found');
            err.status = 404;
            throw err;
        }

        if (trip.passengerId !== req.user.uuid && trip.driverId !== req.user.uuid) {
            const err = new Error('Unauthorized to view trip events');
            err.status = 403;
            throw err;
        }

        const events = await TripEvent.findAll({
            where: { tripId },
            order: [['createdAt', 'ASC']],
        });

        res.status(200).json({
            message: 'Trip events retrieved',
            data:    { events },
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
        const userId     = req.user.uuid;
        const userType   = req.user.user_type;

        console.log('🆔 Trip ID:', tripId);
        console.log('👤 User:', userId, '| Type:', userType);
        console.log('📝 Reason:', reason || 'No reason provided');

        let trip      = await redisHelpers.getJson(REDIS_KEYS.ACTIVE_TRIP(tripId));
        let fromRedis = !!trip;

        if (!trip) {
            const dbTrip = await Trip.findOne({ where: { id: tripId } });
            if (!dbTrip) {
                const err = new Error('Trip not found');
                err.status = 404;
                throw err;
            }
            trip = dbTrip.toJSON ? dbTrip.toJSON() : dbTrip;
        }

        const isPassenger = trip.passengerId === userId;
        const isDriver    = trip.driverId    === userId;

        if (!isPassenger && !isDriver) {
            const err = new Error('Unauthorized to cancel this trip');
            err.status = 403;
            throw err;
        }

        const cancelableStatuses = ['SEARCHING', 'MATCHED', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED'];
        if (!cancelableStatuses.includes(trip.status)) {
            return res.status(400).json({
                success: false,
                message: `Cannot cancel a trip that is already ${trip.status}`,
            });
        }

        const canceledBy = isPassenger ? 'PASSENGER' : 'DRIVER';
        console.log(`🚫 Trip being canceled by: ${canceledBy}`);

        await Trip.update(
            {
                status:       'CANCELED',
                canceledBy,
                cancelReason: reason || null,
                canceledAt:   new Date(),
            },
            { where: { id: tripId } }
        );

        try {
            await TripEvent.create({
                id:      uuidv4(),
                tripId,
                type:    'trip_canceled',
                payload: { canceledBy, reason: reason || 'No reason provided' },
            });
        } catch (e) {
            console.warn('⚠️  TripEvent create failed (non-fatal):', e.message);
        }

        if (trip.driverId) {
            await locationService.updateDriverStatus(trip.driverId, 'available', null);
        }

        // ── Clean up Redis ────────────────────────────────────────────
        await redisClient.del(REDIS_KEYS.ACTIVE_TRIP(tripId));
        await redisClient.del(`passenger:active_trip:${trip.passengerId}`);
        await redisClient.del(REDIS_KEYS.TRIP_OFFERS ? REDIS_KEYS.TRIP_OFFERS(tripId) : `trip:offers:${tripId}`);
        await redisClient.del(`trip:timeout:${tripId}`);
        await redisClient.del(`trip:accepting:${tripId}`);
        await redisClient.del(`trip:no_expire:${tripId}`);
        if (trip.driverId) {
            await redisClient.del(`driver:active_trip:${trip.driverId}`);
        }

        // ── Emit socket events ────────────────────────────────────────
        const io         = getIO();
        const cancelData = {
            tripId,
            status:     'CANCELED',
            canceledBy,
            reason:     reason || 'Trip canceled',
        };

        io.to(`passenger:${trip.passengerId}`).emit('trip:canceled', cancelData);
        io.to(`user:${trip.passengerId}`).emit('trip:canceled', cancelData);

        if (trip.driverId) {
            io.to(`driver:${trip.driverId}`).emit('trip:canceled', cancelData);
            io.to(`user:${trip.driverId}`).emit('trip:canceled', cancelData);
        }

        // ── 🔔 NOTIFICATIONS: Push to the OTHER party ─────────────────
        const NS = getNotificationService();

        if (canceledBy === 'PASSENGER' && trip.driverId) {
            // Passenger cancelled → notify driver
            NS.send({
                accountUuid: trip.driverId,
                type:        'RIDE_CANCELLED',
                title:       'Trip cancelled',
                body:        'The passenger cancelled this trip.',
                data: {
                    screen:      'home',
                    trip_id:     String(tripId),
                    canceled_by: 'PASSENGER',
                },
            }).catch(e => console.warn('⚠️  [CANCEL] Push to driver failed:', e.message));
        }

        if (canceledBy === 'DRIVER') {
            // Driver cancelled → notify passenger
            NS.send({
                accountUuid: trip.passengerId,
                type:        'RIDE_CANCELLED',
                title:       'Trip cancelled',
                body:        'Your driver cancelled the trip. Please request a new ride.',
                data: {
                    screen:      'home',
                    trip_id:     String(tripId),
                    canceled_by: 'DRIVER',
                },
            }).catch(e => console.warn('⚠️  [CANCEL] Push to passenger failed:', e.message));
        }

        console.log('✅ Trip canceled successfully');

        res.status(200).json({
            success: true,
            message: 'Trip canceled successfully',
            data: {
                tripId,
                status:     'CANCELED',
                canceledBy,
                canceledAt: new Date(),
            },
        });

    } catch (error) {
        console.error('❌ [CANCEL TRIP] Error:', error.stack || error.message);
        next(error);
    }
};