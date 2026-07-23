// src/controllers/tripController.js

const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize');
const { Trip, TripEvent, Account, DriverProfile, Coupon, CouponUsage } = require('../models');
const couponService = require('../services/couponService');
const fareCalculatorService = require('../services/fareCalculatorService');

// Ride commission rate — coupons are capped at the commission so WeGo (which
// never touches the P2P fare) never has to pay the driver.
const RIDE_COMMISSION_RATE = parseFloat(process.env.COMMISSION_RATE || '0.15');
const tripMatchingService   = require('../services/tripMatchingService');
const locationService       = require('../services/locationService');
// CamPay is NOT used for rides — the fare is paid directly to the driver.
const { redisClient, redisHelpers, REDIS_KEYS } = require('../config/redis');
const { getIO } = require('../sockets');

// ── Notification service (lazy — avoids circular dep at startup) ──────────────
const getNotificationService = () => require('../services/NotificationService');

// Payment methods that require CamPay confirmation before driver matching starts

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
            vehicle_type,
            promo_code,   // mobile field
            coupon_code,  // accepted alias
        } = req.body;
        const couponInput = promo_code || coupon_code;

        // Requested ride tier — STRICT matching sends the offer only to drivers
        // of this tier. Normalize to the canonical lowercase tiers.
        const RIDE_TIERS = ['economy', 'comfort', 'luxury'];
        let requestedTier = String(vehicle_type || 'economy').trim().toLowerCase();
        if (!RIDE_TIERS.includes(requestedTier)) requestedTier = 'economy';

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

        // ── Coupon (platform-funded via commission) ───────────────────────
        // The discount is capped at the commission (fare × rate) so the driver
        // is always kept whole and WeGo never has to pay the driver.
        const grossFare = Math.round(estimate.fare_estimate);
        let couponRow = null, couponDiscount = 0;
        if (couponInput && String(couponInput).trim()) {
            const commissionCap = Math.floor(grossFare * RIDE_COMMISSION_RATE);
            const evalResult = await couponService.evaluate({
                code: couponInput, userUuid: req.user.uuid,
                grossAmount: grossFare, maxDiscount: commissionCap,
            });
            if (!evalResult.ok) {
                return res.status(400).json({ error: true, message: evalResult.message, code: 'COUPON_INVALID', data: null });
            }
            couponRow      = evalResult.coupon;
            couponDiscount = evalResult.discount;
        }
        const payableFare = Math.max(0, grossFare - couponDiscount);

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
            fareEstimate:   grossFare,
            payableFare,                       // what the passenger pays the driver
            discountAmount: couponDiscount,
            couponCode:     couponRow?.code || null,
            vehicleType:    requestedTier,     // strict tier matching
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
            fareEstimate:   grossFare,
            routePolyline:  estimate.polyline,
            paymentMethod,
            vehicleType:    requestedTier,
            couponId:       couponRow?.id   || null,
            couponCode:     couponRow?.code || null,
            discountAmount: couponDiscount,
            originalFare:   couponDiscount > 0 ? grossFare : null,
        });
        console.log('✅ [DB] Trip persisted with status=SEARCHING');

        // Record the redemption (best-effort — never fail a trip over this).
        if (couponRow && couponDiscount > 0) {
            try {
                await CouponUsage.create({
                    coupon_id: couponRow.id, user_id: req.user.uuid,
                    trip_id: tripId, discount_applied: couponDiscount,
                });
                await couponRow.incrementUsage();
            } catch (e) {
                console.warn('⚠️ [CREATE TRIP] coupon usage record failed:', e.message);
            }
        }

        console.log('🧠 [REDIS] Saving trip data to Redis...');
        await redisHelpers.setJson(REDIS_KEYS.ACTIVE_TRIP(tripId), tripData, ttl);
        await redisHelpers.setJson(existingActiveTripKey, { tripId, status: 'SEARCHING' }, ttl);

        // The fare is paid directly to the driver (cash / MoMo / OM are all P2P
        // and never touch WeGo). Matching ALWAYS starts immediately — there is
        // no upfront payment to WeGo for a ride. The recorded paymentMethod is
        // only how the passenger will settle with the driver at the end.
        console.log(`📢 [CREATE TRIP] Broadcasting to nearby drivers (paymentMethod=${paymentMethod})...`);
        const io        = getIO();
        const broadcast = await tripMatchingService.broadcastTripToDrivers(tripId, io);
        console.log('📡 [CREATE TRIP] Broadcast result:', broadcast);
        const driversNotified = broadcast.driversNotified || 0;

        console.log('✅ [CREATE TRIP] Trip successfully created:', tripId);

        res.status(201).json({
            message:         'Trip created successfully, searching for drivers...',
            requiresPayment: false,
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

// ═══════════════════════════════════════════════════════════════════════════
// 🆘 SOS — panic button (passenger or driver)
// ═══════════════════════════════════════════════════════════════════════════
// The app dials the local emergency number itself; this records the alert with
// the caller's live location, pushes it to the OTHER party and to ops in
// realtime, and returns the number to dial so it is configurable server-side.
// Must be dependable — never throws on a notify failure.
exports.raiseSos = async (req, res, next) => {
    try {
        const { tripId }   = req.params;
        const callerUuid   = req.user.uuid;
        const { lat, lng } = req.body || {};

        const trip = await Trip.findByPk(tripId);
        if (!trip) {
            return res.status(404).json({ success: false, message: 'Trip not found.' });
        }
        // Only a participant of THIS trip can raise its alarm.
        const isPassenger = trip.passengerId === callerUuid;
        const isDriver    = trip.driverId === callerUuid;
        if (!isPassenger && !isDriver) {
            return res.status(403).json({ success: false, message: 'Not a participant of this trip.' });
        }

        const role = isPassenger ? 'PASSENGER' : 'DRIVER';
        const location = {
            lat: Number(lat) || null,
            lng: Number(lng) || null,
        };

        // Immutable audit trail.
        await TripEvent.create({
            id:      uuidv4(),
            tripId,
            type:    'SOS_RAISED',
            payload: { by: role, callerUuid, location, at: new Date().toISOString() },
        });
        console.warn(`🆘 [SOS] Trip ${tripId} — raised by ${role} ${callerUuid} @ ${location.lat},${location.lng}`);

        // Realtime fan-out: the other participant + an ops room. Never fatal.
        try {
            const io = getIO();
            if (io) {
                const otherId = isPassenger ? trip.driverId : trip.passengerId;
                const alert = { tripId, by: role, location, at: new Date().toISOString() };
                if (otherId) io.to(`user:${otherId}`).emit('trip:sos', alert);
                io.to('ops:safety').emit('trip:sos', { ...alert, callerUuid });
            }
        } catch (e) {
            console.error('⚠️ [SOS] realtime fan-out failed:', e.message);
        }

        // Push notification to the other party. Never fatal.
        try {
            const otherId = isPassenger ? trip.driverId : trip.passengerId;
            if (otherId) {
                getNotificationService().send({
                    accountUuid: otherId,
                    type:        'TRIP_SOS',
                    title:       '🆘 Alerte de sécurité',
                    body:        "Une alerte d'urgence a été déclenchée pendant votre course. Restez prudent.",
                    data:        { tripId, screen: 'trip' },
                });
            }
        } catch (_) { /* non-critical */ }

        return res.status(200).json({
            success: true,
            message: 'Alerte enregistrée.',
            data: {
                // Cameroon emergency numbers (police 117, gendarmerie 113).
                emergency_number: process.env.EMERGENCY_PHONE || '117',
            },
        });
    } catch (error) {
        console.error('❌ [SOS] Error:', error.stack || error.message);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// 🔗 Share trip — issue a tokenised tracking link for a live trip
// ═══════════════════════════════════════════════════════════════════════════
exports.shareTrip = async (req, res, next) => {
    try {
        const { tripId } = req.params;
        const trip = await Trip.findByPk(tripId);
        if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });
        if (trip.passengerId !== req.user.uuid && trip.driverId !== req.user.uuid) {
            return res.status(403).json({ success: false, message: 'Not a participant of this trip.' });
        }

        // A signed, expiring token keeps the public tracking page from being
        // guessable or reusable after the ride.
        const jwt = require('jsonwebtoken');
        const token = jwt.sign(
            { tripId, purpose: 'trip_share' },
            process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET,
            { expiresIn: '6h' }
        );
        const base = process.env.PUBLIC_WEB_URL || 'https://wego.cm';
        return res.status(200).json({
            success: true,
            data: { url: `${base}/t/${token}` },
        });
    } catch (error) {
        console.error('❌ [SHARE TRIP] Error:', error.stack || error.message);
        next(error);
    }
};