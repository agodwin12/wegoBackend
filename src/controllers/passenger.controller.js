// src/controllers/passenger.controller.js

const { Trip } = require('../models');
const {
    findAndOfferTrip,
    calculateDistance,
    calculateFare,
    calculateEstimatedTime,
} = require('../services/tripMatching.service');

// ═══════════════════════════════════════════════════════════════════════
// PASSENGER TRIP CONTROLLERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Request a new trip
 * POST /api/passenger/trips/request
 */
exports.requestTrip = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🚕 [PASSENGER-CONTROLLER] New trip request');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('Passenger UUID:', req.user.uuid);
        console.log('Request Body:', JSON.stringify(req.body, null, 2));
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        const {
            pickup_location,
            dropoff_location,
            vehicle_type = 'STANDARD',
            payment_method = 'CASH',
            notes,
        } = req.body;

        // Validate required fields
        if (!pickup_location || !dropoff_location) {
            return res.status(400).json({
                error: 'Validation error',
                message: 'Pickup and dropoff locations are required',
            });
        }

        // Validate coordinates
        if (
            !pickup_location.lat ||
            !pickup_location.lng ||
            !dropoff_location.lat ||
            !dropoff_location.lng
        ) {
            return res.status(400).json({
                error: 'Validation error',
                message: 'Valid coordinates are required for pickup and dropoff',
            });
        }

        // Check if passenger already has an active trip
        const existingTrip = await Trip.findOne({
            where: {
                passenger_id: req.user.uuid,
                status: [
                    'PENDING',
                    'DRIVER_ASSIGNED',
                    'DRIVER_EN_ROUTE',
                    'DRIVER_ARRIVED',
                    'IN_PROGRESS',
                ],
            },
        });

        if (existingTrip) {
            console.log('⚠️ [PASSENGER-CONTROLLER] Passenger already has active trip');
            return res.status(400).json({
                error: 'Active trip exists',
                message: 'You already have an active trip',
                activeTripId: existingTrip.uuid,
            });
        }

        // Calculate distance
        const distanceKm = calculateDistance(
            pickup_location.lat,
            pickup_location.lng,
            dropoff_location.lat,
            dropoff_location.lng
        );

        console.log(`📏 [PASSENGER-CONTROLLER] Distance: ${distanceKm.toFixed(2)} km`);

        // Calculate fare
        const fareEstimate = calculateFare(distanceKm);
        console.log(`💰 [PASSENGER-CONTROLLER] Fare estimate: ${fareEstimate} XAF`);

        // Calculate estimated time
        const estimatedTimeMinutes = calculateEstimatedTime(distanceKm);
        console.log(`⏱️ [PASSENGER-CONTROLLER] Estimated time: ${estimatedTimeMinutes} minutes`);

        // Create trip
        const trip = await Trip.create({
            passenger_id: req.user.uuid,
            pickup_location,
            dropoff_location,
            distance_km: distanceKm,
            fare_estimate: fareEstimate,
            estimated_duration_minutes: estimatedTimeMinutes,
            vehicle_type,
            payment_method,
            status: 'PENDING',
            notes,
        });

        console.log('✅ [PASSENGER-CONTROLLER] Trip created');
        console.log('   Trip ID:', trip.uuid);
        console.log('   Status:', trip.status);

        // Find and offer trip to nearby drivers
        const io = req.app.io;
        if (io) {
            console.log('🔍 [PASSENGER-CONTROLLER] Finding nearby drivers...');

            // Run async without blocking response
            findAndOfferTrip(io, trip, 5, 10).catch(err => {
                console.error('❌ [PASSENGER-CONTROLLER] Error finding drivers:', err);
            });
        } else {
            console.error('⚠️ [PASSENGER-CONTROLLER] Socket.IO not available');
        }

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        // Return trip details
        res.status(201).json({
            message: 'Trip request created successfully',
            data: {
                trip: {
                    uuid: trip.uuid,
                    status: trip.status,
                    pickup_location: trip.pickup_location,
                    dropoff_location: trip.dropoff_location,
                    distance_km: trip.distance_km,
                    fare_estimate: trip.fare_estimate,
                    estimated_duration_minutes: trip.estimated_duration_minutes,
                    vehicle_type: trip.vehicle_type,
                    payment_method: trip.payment_method,
                    created_at: trip.created_at,
                },
            },
        });
    } catch (error) {
        console.error('❌ [PASSENGER-CONTROLLER] Request trip error:', error);
        next(error);
    }
};

/**
 * Get current active trip
 * GET /api/passenger/current-trip
 */
exports.getCurrentTrip = async (req, res, next) => {
    try {
        console.log('🔍 [PASSENGER-CONTROLLER] Get current trip');
        console.log('   Passenger:', req.user.uuid);

        const trip = await Trip.findOne({
            where: {
                passenger_id: req.user.uuid,
                status: [
                    'PENDING',
                    'DRIVER_ASSIGNED',
                    'DRIVER_EN_ROUTE',
                    'DRIVER_ARRIVED',
                    'IN_PROGRESS',
                ],
            },
            order: [['created_at', 'DESC']],
        });

        if (!trip) {
            return res.status(200).json({
                message: 'No active trip',
                data: {
                    currentTrip: null,
                },
            });
        }

        console.log('✅ [PASSENGER-CONTROLLER] Active trip found:', trip.uuid);

        res.status(200).json({
            message: 'Current trip retrieved',
            data: {
                currentTrip: trip,
            },
        });
    } catch (error) {
        console.error('❌ [PASSENGER-CONTROLLER] Get current trip error:', error);
        next(error);
    }
};

/**
 * Cancel a trip
 * POST /api/passenger/trips/:tripId/cancel
 */
exports.cancelTrip = async (req, res, next) => {
    try {
        console.log('\n🚫 [PASSENGER-CONTROLLER] Cancel trip request');
        console.log('   Passenger:', req.user.uuid);
        console.log('   Trip ID:', req.params.tripId);

        const { tripId } = req.params;
        const { reason } = req.body;

        if (!reason) {
            return res.status(400).json({
                error: 'Validation error',
                message: 'Cancellation reason is required',
            });
        }

        // Find the trip
        const trip = await Trip.findByPk(tripId);

        if (!trip) {
            return res.status(404).json({
                error: 'Trip not found',
                message: 'The requested trip does not exist',
            });
        }

        // Verify passenger owns this trip
        if (trip.passenger_id !== req.user.uuid) {
            return res.status(403).json({
                error: 'Access denied',
                message: 'You can only cancel your own trips',
            });
        }

        // Check if trip can be canceled
        if (trip.status === 'COMPLETED' || trip.status === 'CANCELED') {
            return res.status(400).json({
                error: 'Cannot cancel',
                message: `Trip is already ${trip.status.toLowerCase()}`,
            });
        }

        // Cancel the trip
        trip.status = 'CANCELED';
        trip.canceled_by = 'PASSENGER';
        trip.cancellation_reason = reason;
        trip.canceled_at = new Date();
        await trip.save();

        console.log('✅ [PASSENGER-CONTROLLER] Trip canceled');

        // Notify driver if assigned
        const io = req.app.io;
        if (io && trip.driver_id) {
            io.to(`driver:${trip.driver_id}`).emit('trip:canceled', {
                tripId: trip.uuid,
                canceledBy: 'PASSENGER',
                reason,
                timestamp: new Date().toISOString(),
            });
        }

        res.status(200).json({
            message: 'Trip canceled successfully',
            data: {
                trip: {
                    uuid: trip.uuid,
                    status: trip.status,
                    canceled_by: trip.canceled_by,
                    cancellation_reason: trip.cancellation_reason,
                    canceled_at: trip.canceled_at,
                },
            },
        });
    } catch (error) {
        console.error('❌ [PASSENGER-CONTROLLER] Cancel trip error:', error);
        next(error);
    }
};

/**
 * Get trip history
 * GET /api/passenger/trips/history
 */
exports.getTripHistory = async (req, res, next) => {
    try {
        console.log('📜 [PASSENGER-CONTROLLER] Get trip history');

        const { page = 1, limit = 20, status } = req.query;
        const offset = (page - 1) * limit;

        const where = {
            passenger_id: req.user.uuid,
        };

        if (status) {
            where.status = status;
        }

        const { count, rows: trips } = await Trip.findAndCountAll({
            where,
            limit: parseInt(limit),
            offset: parseInt(offset),
            order: [['created_at', 'DESC']],
        });

        console.log('✅ [PASSENGER-CONTROLLER] Trip history retrieved');
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
        console.error('❌ [PASSENGER-CONTROLLER] Get trip history error:', error);
        next(error);
    }
};

/**
 * Get trip details
 * GET /api/passenger/trips/:tripId
 */
exports.getTripDetails = async (req, res, next) => {
    try {
        console.log('🔍 [PASSENGER-CONTROLLER] Get trip details');

        const { tripId } = req.params;

        const trip = await Trip.findOne({
            where: {
                uuid: tripId,
                passenger_id: req.user.uuid,
            },
        });

        if (!trip) {
            return res.status(404).json({
                error: 'Trip not found',
                message: 'The requested trip does not exist or you do not have access to it',
            });
        }

        console.log('✅ [PASSENGER-CONTROLLER] Trip details retrieved');

        res.status(200).json({
            message: 'Trip details retrieved',
            data: {
                trip,
            },
        });
    } catch (error) {
        console.error('❌ [PASSENGER-CONTROLLER] Get trip details error:', error);
        next(error);
    }
};

/**
 * Rate a completed trip
 * POST /api/passenger/trips/:tripId/rate
 */
exports.rateTrip = async (req, res, next) => {
    try {
        console.log('⭐ [PASSENGER-CONTROLLER] Rate trip');

        const { tripId } = req.params;
        const { rating, feedback } = req.body;

        // Validate rating
        if (!rating || rating < 1 || rating > 5) {
            return res.status(400).json({
                error: 'Validation error',
                message: 'Rating must be between 1 and 5',
            });
        }

        const trip = await Trip.findOne({
            where: {
                uuid: tripId,
                passenger_id: req.user.uuid,
            },
        });

        if (!trip) {
            return res.status(404).json({
                error: 'Trip not found',
                message: 'The requested trip does not exist or you do not have access to it',
            });
        }

        if (trip.status !== 'COMPLETED') {
            return res.status(400).json({
                error: 'Cannot rate',
                message: 'You can only rate completed trips',
            });
        }

        // TODO: Create Rating model and save rating
        // For now, just update trip
        trip.passenger_rating = rating;
        trip.passenger_feedback = feedback;
        await trip.save();

        console.log('✅ [PASSENGER-CONTROLLER] Trip rated');

        res.status(200).json({
            message: 'Trip rated successfully',
            data: {
                tripId: trip.uuid,
                rating,
                feedback,
            },
        });
    } catch (error) {
        console.error('❌ [PASSENGER-CONTROLLER] Rate trip error:', error);
        next(error);
    }
};