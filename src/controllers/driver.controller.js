// src/controllers/driver.controller.js

const { Account, Trip } = require('../models');
const { Op } = require('sequelize');

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

        // Validate waiting time
        if (!waitingTime || waitingTime < 0) {
            console.log('❌ [DRIVER-CONTROLLER] Invalid waiting time');
            return res.status(400).json({
                error: 'Validation error',
                message: 'Valid waiting time is required',
            });
        }

        // Find the trip
        const trip = await Trip.findByPk(tripId);

        if (!trip) {
            console.log('❌ [DRIVER-CONTROLLER] Trip not found');
            return res.status(404).json({
                error: 'Trip not found',
                message: 'The requested trip does not exist',
            });
        }

        // ✅ FIXED: Verify driver owns this trip using camelCase
        if (trip.driverId !== req.user.uuid) {
            console.log('❌ [DRIVER-CONTROLLER] Access denied - not driver\'s trip');
            return res.status(403).json({
                error: 'Access denied',
                message: 'You are not assigned to this trip',
            });
        }

        // Verify trip status is DRIVER_ARRIVED
        if (trip.status !== 'DRIVER_ARRIVED') {
            console.log('❌ [DRIVER-CONTROLLER] Invalid status for no-show');
            console.log('   Current Status:', trip.status);
            return res.status(400).json({
                error: 'Invalid status',
                message: 'Can only report no-show when status is DRIVER_ARRIVED',
                currentStatus: trip.status,
            });
        }

        // Optional: Check minimum waiting time (e.g., at least 5 minutes)
        const MIN_WAITING_TIME = 300; // 5 minutes in seconds
        if (waitingTime < MIN_WAITING_TIME) {
            console.log('⚠️ [DRIVER-CONTROLLER] Waiting time below minimum');
            return res.status(400).json({
                error: 'Invalid waiting time',
                message: `Please wait at least ${MIN_WAITING_TIME / 60} minutes before reporting no-show`,
                minimumWaitingTime: MIN_WAITING_TIME,
                currentWaitingTime: waitingTime,
            });
        }

        // ✅ FIXED: Update trip status using camelCase
        trip.status = 'NO_SHOW';
        trip.cancelReason = reason || 'Passenger did not show up';
        trip.canceledBy = 'DRIVER';
        trip.canceledAt = new Date();

        // If you have a waitingTime field in your Trip model, uncomment this:
        // trip.waitingTime = waitingTime;

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

        // TODO: Create/Update DriverLocation record
        // const driverLocation = await DriverLocation.upsert({
        //   driverId: req.user.uuid,
        //   lat,
        //   lng,
        //   heading: heading || 0,
        //   isOnline: true,
        //   lastUpdated: new Date(),
        // });

        console.log('✅ [DRIVER-CONTROLLER] Driver is now online');
        console.log('   Location:', lat, lng);
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

        // TODO: Update DriverLocation record
        // await DriverLocation.update(
        //   { isOnline: false, lastUpdated: new Date() },
        //   { where: { driverId: req.user.uuid } }
        // );

        console.log('✅ [DRIVER-CONTROLLER] Driver is now offline');
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
        const { lat, lng, heading, speed } = req.body;

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

        // TODO: Update DriverLocation record
        // await DriverLocation.update(
        //   {
        //     lat,
        //     lng,
        //     heading: heading || 0,
        //     speed: speed || 0,
        //     lastUpdated: new Date(),
        //   },
        //   { where: { driverId: req.user.uuid } }
        // );

        // TODO: Emit socket event to notify passengers tracking this driver
        // io.to(`trip-${activeTripId}`).emit('driver:location', { lat, lng, heading });

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

        // TODO: Fetch from DriverLocation
        // const driverLocation = await DriverLocation.findOne({
        //   where: { driverId: req.user.uuid },
        // });

        // Mock response for now
        const mockStatus = {
            driver_id: req.user.uuid,
            is_online: false, // TODO: Get from database
            location: null,
            last_updated: new Date().toISOString(),
        };

        res.status(200).json({
            message: 'Driver status retrieved',
            data: mockStatus,
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

        // ✅ FIXED: Using camelCase column names
        const trip = await Trip.findOne({
            where: {
                driverId: req.user.uuid,
                status: {
                    [Op.in]: ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS'],
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
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ [DRIVER-CONTROLLER] Accept Trip Request');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('Driver UUID:', req.user.uuid);
        console.log('Trip ID:', req.params.tripId);

        const { tripId } = req.params;

        // Find the trip
        const trip = await Trip.findByPk(tripId);

        if (!trip) {
            console.log('❌ [DRIVER-CONTROLLER] Trip not found');
            return res.status(404).json({
                error: 'Trip not found',
                message: 'The requested trip does not exist',
            });
        }

        // Check if trip is still available
        if (trip.status !== 'SEARCHING' && trip.status !== 'MATCHED') {
            console.log('❌ [DRIVER-CONTROLLER] Trip not available');
            console.log('   Current Status:', trip.status);
            return res.status(400).json({
                error: 'Trip not available',
                message: 'This trip is no longer available',
                currentStatus: trip.status,
            });
        }

        // Check if driver already has an active trip
        const activeTrip = await Trip.findOne({
            where: {
                driverId: req.user.uuid,
                status: {
                    [Op.in]: ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS'],
                },
            },
        });

        if (activeTrip) {
            console.log('❌ [DRIVER-CONTROLLER] Driver already has active trip');
            return res.status(400).json({
                error: 'Active trip exists',
                message: 'You already have an active trip',
                activeTripId: activeTrip.id,
            });
        }

        // ✅ FIXED: Assign driver to trip using camelCase
        trip.driverId = req.user.uuid;
        trip.status = 'DRIVER_ASSIGNED';
        // Add timestamp if you have this field
        // trip.driverAssignedAt = new Date();
        await trip.save();

        console.log('✅ [DRIVER-CONTROLLER] Trip accepted successfully');
        console.log('   Trip Status:', trip.status);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        // TODO: Emit socket event to passenger
        // io.to(`passenger-${trip.passengerId}`).emit('trip:matched', {
        //   tripId: trip.id,
        //   driver: {
        //     id: req.user.uuid,
        //     name: `${req.user.first_name} ${req.user.last_name}`,
        //     phone: req.user.phone_e164,
        //     rating: 4.8,
        //   },
        // });

        res.status(200).json({
            message: 'Trip accepted successfully',
            data: {
                trip,
            },
        });

    } catch (error) {
        console.error('❌ [DRIVER-CONTROLLER] Accept Trip Error:', error);
        next(error);
    }
};

/**
 * Decline Trip - Decline a trip offer
 * POST /api/driver/trips/:tripId/decline
 */
exports.declineTrip = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('❌ [DRIVER-CONTROLLER] Decline Trip Request');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('Driver UUID:', req.user.uuid);
        console.log('Trip ID:', req.params.tripId);

        const { tripId } = req.params;

        // Find the trip
        const trip = await Trip.findByPk(tripId);

        if (!trip) {
            console.log('❌ [DRIVER-CONTROLLER] Trip not found');
            return res.status(404).json({
                error: 'Trip not found',
                message: 'The requested trip does not exist',
            });
        }

        console.log('✅ [DRIVER-CONTROLLER] Trip declined');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        // TODO: Add driver to declined_by list
        // TODO: Offer to next available driver

        res.status(200).json({
            message: 'Trip declined',
            data: {
                tripId: trip.id,
            },
        });

    } catch (error) {
        console.error('❌ [DRIVER-CONTROLLER] Decline Trip Error:', error);
        next(error);
    }
};

/**
 * Arrived at Pickup - Mark driver has arrived at pickup location
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

        // Find the trip
        const trip = await Trip.findByPk(tripId);

        if (!trip) {
            return res.status(404).json({
                error: 'Trip not found',
                message: 'The requested trip does not exist',
            });
        }

        // ✅ FIXED: Verify driver owns this trip using camelCase
        if (trip.driverId !== req.user.uuid) {
            return res.status(403).json({
                error: 'Access denied',
                message: 'You are not assigned to this trip',
            });
        }

        // Update trip status
        trip.status = 'DRIVER_ARRIVED';
        // Add timestamp if you have this field
        // trip.driverArrivedAt = new Date();
        await trip.save();

        console.log('✅ [DRIVER-CONTROLLER] Status updated to DRIVER_ARRIVED');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        // TODO: Emit socket event to passenger
        // io.to(`passenger-${trip.passengerId}`).emit('trip:driver-arrived', {
        //   tripId: trip.id,
        //   arrivedAt: new Date(),
        // });

        res.status(200).json({
            message: 'Status updated: Driver arrived at pickup',
            data: {
                trip,
            },
        });

    } catch (error) {
        console.error('❌ [DRIVER-CONTROLLER] Arrived at Pickup Error:', error);
        next(error);
    }
};

/**
 * Start Trip - Start the trip (passenger on board)
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

        // Find the trip
        const trip = await Trip.findByPk(tripId);

        if (!trip) {
            return res.status(404).json({
                error: 'Trip not found',
                message: 'The requested trip does not exist',
            });
        }

        // ✅ FIXED: Verify driver owns this trip
        if (trip.driverId !== req.user.uuid) {
            return res.status(403).json({
                error: 'Access denied',
                message: 'You are not assigned to this trip',
            });
        }

        // ✅ FIXED: Update trip status using camelCase
        trip.status = 'IN_PROGRESS';
        trip.tripStartedAt = new Date();
        await trip.save();

        console.log('✅ [DRIVER-CONTROLLER] Trip started');
        console.log('   Started At:', trip.tripStartedAt);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        // TODO: Emit socket event to passenger
        // io.to(`passenger-${trip.passengerId}`).emit('trip:started', {
        //   tripId: trip.id,
        //   startedAt: trip.tripStartedAt,
        // });

        res.status(200).json({
            message: 'Trip started successfully',
            data: {
                trip,
            },
        });

    } catch (error) {
        console.error('❌ [DRIVER-CONTROLLER] Start Trip Error:', error);
        next(error);
    }
};

/**
 * Complete Trip - Complete the trip (arrived at destination)
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

        // Find the trip
        const trip = await Trip.findByPk(tripId);

        if (!trip) {
            return res.status(404).json({
                error: 'Trip not found',
                message: 'The requested trip does not exist',
            });
        }

        // ✅ FIXED: Verify driver owns this trip
        if (trip.driverId !== req.user.uuid) {
            return res.status(403).json({
                error: 'Access denied',
                message: 'You are not assigned to this trip',
            });
        }

        // ✅ FIXED: Update trip status using camelCase
        trip.status = 'COMPLETED';
        trip.tripCompletedAt = new Date();
        if (final_fare) trip.fare_final = final_fare;
        // Add notes field if you have it
        // if (notes) trip.driverNotes = notes;
        await trip.save();

        console.log('✅ [DRIVER-CONTROLLER] Trip completed');
        console.log('   Completed At:', trip.tripCompletedAt);
        console.log('   Final Fare:', trip.fare_final);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        // TODO: Emit socket event to passenger
        // io.to(`passenger-${trip.passengerId}`).emit('trip:completed', {
        //   tripId: trip.id,
        //   completedAt: trip.tripCompletedAt,
        //   finalFare: trip.fare_final,
        // });

        res.status(200).json({
            message: 'Trip completed successfully',
            data: {
                trip,
            },
        });

    } catch (error) {
        console.error('❌ [DRIVER-CONTROLLER] Complete Trip Error:', error);
        next(error);
    }
};

/**
 * Cancel Trip - Cancel a trip
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

        // Find the trip
        const trip = await Trip.findByPk(tripId);

        if (!trip) {
            return res.status(404).json({
                error: 'Trip not found',
                message: 'The requested trip does not exist',
            });
        }

        // ✅ FIXED: Verify driver owns this trip
        if (trip.driverId !== req.user.uuid) {
            return res.status(403).json({
                error: 'Access denied',
                message: 'You are not assigned to this trip',
            });
        }

        // ✅ FIXED: Update trip status
        trip.status = 'CANCELED';
        trip.cancel_reason = reason;
        // Add these fields if you have them in your model
        // trip.canceledBy = 'DRIVER';
        // trip.canceledAt = new Date();
        await trip.save();

        console.log('✅ [DRIVER-CONTROLLER] Trip canceled');
        console.log('   Reason:', reason);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        // TODO: Emit socket event to passenger
        // io.to(`passenger-${trip.passengerId}`).emit('trip:canceled', {
        //   tripId: trip.id,
        //   canceledBy: 'DRIVER',
        //   reason,
        // });

        res.status(200).json({
            message: 'Trip canceled',
            data: {
                trip,
            },
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
 * Get Stats - Get driver statistics
 * GET /api/driver/stats
 */
exports.getStats = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📊 [DRIVER-CONTROLLER] Get Stats Request');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('Driver UUID:', req.user.uuid);

        const driverId = req.user.uuid;

        // 🗓️ Get date ranges
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        // Get week start (Sunday)
        const weekStart = new Date(today);
        weekStart.setDate(today.getDate() - today.getDay());

        // ✅ Today's completed trips
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

        // ✅ Today's total earnings (use correct camelCase: fareFinal)
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

        // ✅ This week's completed trips
        const weekTrips = await Trip.count({
            where: {
                driverId: driverId,
                status: 'COMPLETED',
                tripCompletedAt: {
                    [Op.gte]: weekStart,
                },
            },
        });

        // ✅ This week's total earnings
        const weekEarnings = await Trip.sum('fareFinal', {
            where: {
                driverId: driverId,
                status: 'COMPLETED',
                tripCompletedAt: {
                    [Op.gte]: weekStart,
                },
            },
        }) || 0;

        // ✅ Total completed trips (all time)
        const totalTrips = await Trip.count({
            where: {
                driverId: driverId,
                status: 'COMPLETED',
            },
        });

        // ✅ Total earnings (all time)
        const totalEarnings = await Trip.sum('fareFinal', {
            where: {
                driverId: driverId,
                status: 'COMPLETED',
            },
        }) || 0;

        // ✅ Log and respond
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
 * Get Earnings - Get detailed earnings breakdown
 * GET /api/driver/earnings
 */
exports.getEarnings = async (req, res, next) => {
    try {
        console.log('💰 [DRIVER-CONTROLLER] Get Earnings Request');

        const { period = 'all' } = req.query;
        const driverId = req.user.uuid;

        // TODO: Implement detailed earnings breakdown
        // Group by day, week, month, etc.

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
 * Get Trip History - Get paginated trip history
 * GET /api/driver/trips/history
 */
exports.getTripHistory = async (req, res, next) => {
    try {
        console.log('📜 [DRIVER-CONTROLLER] Get Trip History Request');

        const { page = 1, limit = 20, status } = req.query;
        const driverId = req.user.uuid;

        const offset = (page - 1) * limit;

        const where = {
            driverId: driverId, // ✅ FIXED: Using camelCase
        };

        if (status) {
            where.status = status;
        }

        // ✅ FIXED: Using camelCase in order clause
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
 * Get Trip Details - Get details of a specific trip
 * GET /api/driver/trips/:tripId
 */
exports.getTripDetails = async (req, res, next) => {
    try {
        console.log('🔍 [DRIVER-CONTROLLER] Get Trip Details Request');

        const { tripId } = req.params;
        const driverId = req.user.uuid;

        // ✅ FIXED: Using camelCase
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
            data: {
                trip,
            },
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
 * Get Profile - Get driver profile
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
            data: {
                driver,
            },
        });

    } catch (error) {
        console.error('❌ [DRIVER-CONTROLLER] Get Profile Error:', error);
        next(error);
    }
};

/**
 * Update Profile - Update driver profile
 * PUT /api/driver/profile
 */
exports.updateProfile = async (req, res, next) => {
    try {
        console.log('✏️ [DRIVER-CONTROLLER] Update Profile Request');

        // TODO: Implement profile update logic

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
 * Get Ratings - Get driver ratings and reviews
 * GET /api/driver/ratings
 */
exports.getRatings = async (req, res, next) => {
    try {
        console.log('⭐ [DRIVER-CONTROLLER] Get Ratings Request');

        // TODO: Implement ratings retrieval

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

}



