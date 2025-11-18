// src/socket/driver.socket.js

const { DriverLocation, Trip, Account } = require('../models');
const { Op } = require('sequelize');

/**
 * Driver Socket Handlers
 * Handles all real-time communication with driver clients
 */

// Store active driver sockets (driver_id -> socket.id)
const activeDrivers = new Map();

/**
 * Initialize driver socket handlers
 */
const initializeDriverSocket = (io, socket) => {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🚗 [DRIVER-SOCKET] Driver connected');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Socket ID:', socket.id);
    console.log('Driver ID:', socket.userId);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Register driver
    if (socket.userId) {
        activeDrivers.set(socket.userId, socket.id);
        console.log(`✅ [DRIVER-SOCKET] Driver ${socket.userId} registered`);
        console.log(`📊 [DRIVER-SOCKET] Active drivers: ${activeDrivers.size}`);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // DRIVER EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Driver goes online
     * Event: 'driver:online'
     * Data: { lat, lng, heading, accuracy, battery_level, app_version }
     *
     * ✅ FIXED: Now saves driver metadata to Redis for trip matching
     */
    socket.on('driver:online', async (data) => {
        try {
            console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('🟢 [SOCKET-DRIVER] Driver going online');
            console.log('👤 Driver ID:', socket.userId);
            console.log('📍 Location:', data.lat, data.lng);
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            const { lat, lng, heading, accuracy, battery_level, app_version } = data;

            // Validate
            if (!lat || !lng) {
                socket.emit('error', {
                    event: 'driver:online',
                    message: 'Location (lat, lng) is required',
                });
                return;
            }

            // ✅ STEP 1: Update driver location in database
            await DriverLocation.upsertLocation(socket.userId, {
                lat,
                lng,
                heading,
                accuracy,
                battery_level,
                app_version,
            });

            // ✅ STEP 2: Set driver as online in database
            await DriverLocation.setOnline(socket.userId);
            console.log('🔍 [DEBUG] Step 2 completed - Driver set online');

            // ✅ STEP 3: Get driver info from database
            console.log('🔍 [DEBUG] Step 3 starting - Finding driver account...');
            const driver = await Account.findByPk(socket.userId);
            console.log('🔍 [DEBUG] Step 3 - Driver found:', driver ? 'YES' : 'NO');

            if (!driver) {
                console.log('❌ [SOCKET-DRIVER] Driver not found in database');
                socket.emit('error', {
                    event: 'driver:online',
                    message: 'Driver account not found',
                });
                return;
            }

            console.log('🔍 [DEBUG] Driver details:', {
                id: driver.uuid,
                firstName: driver.first_name,
                lastName: driver.last_name,
                phone: driver.phone_e164
            });

            // ✅ STEP 4: Save driver metadata to Redis (THE MISSING PIECE!)
            console.log('🔍 [DEBUG] Step 4 starting - Saving metadata to Redis...');
            const { redisClient } = require('../config/redis');
            const metadataKey = `driver:${socket.userId}:metadata`;
            const driverMetadata = {
                driverId: socket.userId,
                status: 'ONLINE',
                isAvailable: true,
                firstName: driver.first_name,
                lastName: driver.last_name,
                phone: driver.phone_e164,
                lastUpdated: new Date().toISOString()
            };

            await redisClient.setex(
                metadataKey,
                3600, // Expire after 1 hour
                JSON.stringify(driverMetadata)
            );

            console.log('✅ [SOCKET-DRIVER] Driver metadata saved to Redis');
            console.log('   Key:', metadataKey);
            console.log('🔍 [DEBUG] Metadata value:', JSON.stringify(driverMetadata));

            // Join driver room for broadcasting
            socket.join(`driver-${socket.userId}`);
            console.log('🔍 [DEBUG] Joined room: driver-' + socket.userId);

            console.log('✅ [SOCKET-DRIVER] Driver is now online\n');

            // Confirm to driver
            socket.emit('driver:online:success', {
                message: 'You are now online',
                location: { lat, lng, heading },
                timestamp: new Date().toISOString(),
            });

        } catch (error) {
            console.error('❌ [SOCKET-DRIVER] Online error:', error);
            console.error('🔍 [DEBUG] Error stack:', error.stack);
            console.error('🔍 [DEBUG] Error message:', error.message);
            socket.emit('error', {
                event: 'driver:online',
                message: 'Failed to go online',
            });
        }
    });

    /**
     * Driver goes offline
     * Event: 'driver:offline'
     */
    socket.on('driver:offline', async () => {
        try {
            console.log('\n🔴 [DRIVER-SOCKET] Driver going offline');
            console.log('Driver:', socket.userId);

            // Set driver as offline
            await DriverLocation.setOffline(socket.userId);

            // Delete driver metadata from Redis
            const { redisClient } = require('../config/redis');
            const metadataKey = `driver:${socket.userId}:metadata`;
            await redisClient.del(metadataKey);

            console.log('✅ [SOCKET-DRIVER] Driver metadata removed from Redis');

            // Leave driver room
            socket.leave(`driver-${socket.userId}`);

            console.log('✅ [DRIVER-SOCKET] Driver is now offline');

            // Confirm to driver
            socket.emit('driver:offline:success', {
                message: 'You are now offline',
                timestamp: new Date().toISOString(),
            });

        } catch (error) {
            console.error('❌ [DRIVER-SOCKET] Offline error:', error);
            socket.emit('error', {
                event: 'driver:offline',
                message: 'Failed to go offline',
            });
        }
    });

    /**
     * Driver location update
     * Event: 'driver:location'
     * Data: { lat, lng, heading, speed, accuracy }
     */
    socket.on('driver:location', async (data) => {
        try {
            const { lat, lng, heading, speed, accuracy } = data;

            console.log('📍 [DRIVER-SOCKET] Location update');
            console.log('Driver:', socket.userId);
            console.log('Location:', lat, lng);

            // Validate
            if (!lat || !lng) {
                return;
            }

            // Update driver location
            await DriverLocation.upsertLocation(socket.userId, {
                lat,
                lng,
                heading,
                speed,
                accuracy,
            });

            // Check if driver has active trip
            const activeTrip = await Trip.findOne({
                where: {
                    driver_id: socket.userId,
                    status: {
                        [Op.in]: ['DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS'],
                    },
                },
            });

            // If driver has active trip, broadcast location to passenger
            if (activeTrip) {
                io.to(`passenger-${activeTrip.passenger_id}`).emit('driver:location', {
                    tripId: activeTrip.uuid,
                    location: {
                        lat,
                        lng,
                        heading,
                        speed,
                    },
                    timestamp: new Date().toISOString(),
                });

                console.log('📡 [DRIVER-SOCKET] Location broadcasted to passenger');
            }

        } catch (error) {
            console.error('❌ [DRIVER-SOCKET] Location update error:', error);
        }
    });

    /**
     * Driver accepts trip
     * Event: 'trip:accept'
     * Data: { tripId }
     */
    socket.on('trip:accept', async (data) => {
        try {
            console.log('\n✅ [DRIVER-SOCKET] Trip accept request');
            console.log('Driver:', socket.userId);
            console.log('Trip:', data.tripId);

            const { tripId } = data;

            if (!tripId) {
                return socket.emit('trip:accept:error', {
                    message: 'Trip ID is required'
                });
            }

            // ✅ Use the tripMatchingService which has ALL the logic
            const tripMatchingService = require('../services/tripMatchingService');
            const result = await tripMatchingService.acceptTrip(tripId, socket.userId, io);

            if (!result.success) {
                console.log(`⚠️ [DRIVER-SOCKET] Could not accept trip: ${result.reason}`);
                return socket.emit('trip:accept:error', {
                    tripId,
                    message: result.reason
                });
            }

            console.log('✅ [DRIVER-SOCKET] Trip accepted successfully');

            // Notify driver of success
            socket.emit('trip:accept:success', {
                tripId: result.trip.id,
                trip: result.trip,
                driver: result.driver, // ✅ Complete driver info returned
                message: 'Trip accepted successfully'
            });

            // Join trip room for real-time updates
            socket.join(`trip-${result.trip.id}`);

            console.log('📡 [DRIVER-SOCKET] Driver notified and joined trip room');

        } catch (error) {
            console.error('❌ [DRIVER-SOCKET] Accept trip error:', error);
            socket.emit('trip:accept:error', {
                message: 'Failed to accept trip',
                error: error.message
            });
        }
    });
    /**
     * Driver declines trip
     * Event: 'trip:decline'
     * Data: { tripId, reason }
     */
    socket.on('trip:decline', async (data) => {
        try {
            console.log('\n❌ [DRIVER-SOCKET] Trip decline request');
            console.log('Driver:', socket.userId);
            console.log('Trip:', data.tripId);
            console.log('Reason:', data.reason);

            const { tripId, reason } = data;

            // Find the trip
            const trip = await Trip.findByPk(tripId);

            if (!trip) {
                socket.emit('trip:decline:error', {
                    tripId,
                    message: 'Trip not found',
                });
                return;
            }

            console.log('✅ [DRIVER-SOCKET] Trip declined');

            // Confirm to driver
            socket.emit('trip:decline:success', {
                tripId,
                message: 'Trip declined',
            });

            // TODO: Add driver to declined_by list
            // TODO: Find and notify next available driver

        } catch (error) {
            console.error('❌ [DRIVER-SOCKET] Decline trip error:', error);
            socket.emit('trip:decline:error', {
                message: 'Failed to decline trip',
            });
        }
    });

    /**
     * Driver arrived at pickup
     * Event: 'trip:arrived'
     * Data: { tripId }
     */
    socket.on('trip:arrived', async (data) => {
        try {
            console.log('\n📍 [DRIVER-SOCKET] Driver arrived at pickup');
            console.log('Driver:', socket.userId);
            console.log('Trip:', data.tripId);

            const { tripId } = data;

            const trip = await Trip.findByPk(tripId);

            if (!trip) {
                socket.emit('trip:arrived:error', {
                    tripId,
                    message: 'Trip not found',
                });
                return;
            }

            if (trip.driver_id !== socket.userId) {
                socket.emit('trip:arrived:error', {
                    tripId,
                    message: 'Not your trip',
                });
                return;
            }

            // Update trip status
            trip.status = 'DRIVER_ARRIVED';
            trip.driver_arrived_at = new Date();
            await trip.save();

            console.log('✅ [DRIVER-SOCKET] Status updated to DRIVER_ARRIVED');

            // Confirm to driver
            socket.emit('trip:arrived:success', {
                tripId: trip.uuid,
                trip,
            });

            // Notify passenger
            io.to(`passenger-${trip.passenger_id}`).emit('trip:driver-arrived', {
                tripId: trip.uuid,
                arrivedAt: trip.driver_arrived_at,
            });

            console.log('📡 [DRIVER-SOCKET] Arrival notification sent to passenger');

        } catch (error) {
            console.error('❌ [DRIVER-SOCKET] Arrived error:', error);
            socket.emit('trip:arrived:error', {
                message: 'Failed to update status',
            });
        }
    });

    /**
     * Driver starts trip
     * Event: 'trip:start'
     * Data: { tripId }
     */
    socket.on('trip:start', async (data) => {
        try {
            console.log('\n🚀 [DRIVER-SOCKET] Trip start request');
            console.log('Driver:', socket.userId);
            console.log('Trip:', data.tripId);

            const { tripId } = data;

            const trip = await Trip.findByPk(tripId);

            if (!trip) {
                socket.emit('trip:start:error', {
                    tripId,
                    message: 'Trip not found',
                });
                return;
            }

            if (trip.driver_id !== socket.userId) {
                socket.emit('trip:start:error', {
                    tripId,
                    message: 'Not your trip',
                });
                return;
            }

            // Update trip status
            trip.status = 'IN_PROGRESS';
            trip.trip_started_at = new Date();
            await trip.save();

            console.log('✅ [DRIVER-SOCKET] Trip started');

            // Confirm to driver
            socket.emit('trip:start:success', {
                tripId: trip.uuid,
                trip,
            });

            // Notify passenger
            io.to(`passenger-${trip.passenger_id}`).emit('trip:started', {
                tripId: trip.uuid,
                startedAt: trip.trip_started_at,
            });

            console.log('📡 [DRIVER-SOCKET] Start notification sent to passenger');

        } catch (error) {
            console.error('❌ [DRIVER-SOCKET] Start trip error:', error);
            socket.emit('trip:start:error', {
                message: 'Failed to start trip',
            });
        }
    });

    /**
     * Driver completes trip
     * Event: 'trip:complete'
     * Data: { tripId, finalFare, notes }
     */
    socket.on('trip:complete', async (data) => {
        try {
            console.log('\n🏁 [DRIVER-SOCKET] Trip complete request');
            console.log('Driver:', socket.userId);
            console.log('Trip:', data.tripId);

            const { tripId, finalFare, notes } = data;

            const trip = await Trip.findByPk(tripId);

            if (!trip) {
                socket.emit('trip:complete:error', {
                    tripId,
                    message: 'Trip not found',
                });
                return;
            }

            if (trip.driver_id !== socket.userId) {
                socket.emit('trip:complete:error', {
                    tripId,
                    message: 'Not your trip',
                });
                return;
            }

            // Update trip status
            trip.status = 'COMPLETED';
            trip.trip_completed_at = new Date();
            if (finalFare) trip.final_fare = finalFare;
            if (notes) trip.driver_notes = notes;
            await trip.save();

            console.log('✅ [DRIVER-SOCKET] Trip completed');

            // Confirm to driver
            socket.emit('trip:complete:success', {
                tripId: trip.uuid,
                trip,
            });

            // Notify passenger
            io.to(`passenger-${trip.passenger_id}`).emit('trip:completed', {
                tripId: trip.uuid,
                completedAt: trip.trip_completed_at,
                finalFare: trip.final_fare || trip.fare_estimate,
            });

            // Leave trip room
            socket.leave(`trip-${trip.uuid}`);

            console.log('📡 [DRIVER-SOCKET] Completion notification sent to passenger');

        } catch (error) {
            console.error('❌ [DRIVER-SOCKET] Complete trip error:', error);
            socket.emit('trip:complete:error', {
                message: 'Failed to complete trip',
            });
        }
    });

    /**
     * Driver cancels trip
     * Event: 'trip:cancel'
     * Data: { tripId, reason }
     */
    socket.on('trip:cancel', async (data) => {
        try {
            console.log('\n🚫 [DRIVER-SOCKET] Trip cancel request');
            console.log('Driver:', socket.userId);
            console.log('Trip:', data.tripId);
            console.log('Reason:', data.reason);

            const { tripId, reason } = data;

            if (!reason) {
                socket.emit('trip:cancel:error', {
                    tripId,
                    message: 'Cancellation reason is required',
                });
                return;
            }

            const trip = await Trip.findByPk(tripId);

            if (!trip) {
                socket.emit('trip:cancel:error', {
                    tripId,
                    message: 'Trip not found',
                });
                return;
            }

            if (trip.driver_id !== socket.userId) {
                socket.emit('trip:cancel:error', {
                    tripId,
                    message: 'Not your trip',
                });
                return;
            }

            // Update trip status
            trip.status = 'CANCELED';
            trip.canceled_by = 'DRIVER';
            trip.cancellation_reason = reason;
            trip.canceled_at = new Date();
            await trip.save();

            console.log('✅ [DRIVER-SOCKET] Trip canceled');

            // Confirm to driver
            socket.emit('trip:cancel:success', {
                tripId: trip.uuid,
                message: 'Trip canceled',
            });

            // Notify passenger
            io.to(`passenger-${trip.passenger_id}`).emit('trip:canceled', {
                tripId: trip.uuid,
                canceledBy: 'DRIVER',
                reason,
                canceledAt: trip.canceled_at,
            });

            // Leave trip room
            socket.leave(`trip-${trip.uuid}`);

            console.log('📡 [DRIVER-SOCKET] Cancellation notification sent to passenger');

        } catch (error) {
            console.error('❌ [DRIVER-SOCKET] Cancel trip error:', error);
            socket.emit('trip:cancel:error', {
                message: 'Failed to cancel trip',
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════════════
    // DISCONNECT HANDLER
    // ═══════════════════════════════════════════════════════════════════════

    socket.on('disconnect', async () => {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔴 [DRIVER-SOCKET] Driver disconnected');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('Socket ID:', socket.id);
        console.log('Driver ID:', socket.userId);

        if (socket.userId) {
            // Remove from active drivers
            activeDrivers.delete(socket.userId);
            console.log(`📊 [DRIVER-SOCKET] Active drivers: ${activeDrivers.size}`);

            // Set driver as offline (optional - you may want to keep them online for some time)
            // await DriverLocation.setOffline(socket.userId);

            // Optional: Remove metadata from Redis when driver disconnects
            // const { redisClient } = require('../config/redis');
            // const metadataKey = `driver:${socket.userId}:metadata`;
            // await redisClient.del(metadataKey);
        }

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    });
};

/**
 * Send trip offer to specific driver
 */
const sendTripOfferToDriver = (io, driverId, tripOffer) => {
    console.log('\n📨 [DRIVER-SOCKET] Sending trip offer to driver');
    console.log('Driver ID:', driverId);
    console.log('Trip ID:', tripOffer.tripId);

    const socketId = activeDrivers.get(driverId);

    if (!socketId) {
        console.log('⚠️ [DRIVER-SOCKET] Driver not connected');
        return false;
    }

    io.to(socketId).emit('trip:offer', tripOffer);
    console.log('✅ [DRIVER-SOCKET] Trip offer sent');

    return true;
};

/**
 * Notify driver that trip was canceled by passenger
 */
const notifyDriverTripCanceled = (io, driverId, tripId, reason) => {
    console.log('\n🚫 [DRIVER-SOCKET] Notifying driver of trip cancellation');
    console.log('Driver ID:', driverId);
    console.log('Trip ID:', tripId);

    const socketId = activeDrivers.get(driverId);

    if (!socketId) {
        console.log('⚠️ [DRIVER-SOCKET] Driver not connected');
        return false;
    }

    io.to(socketId).emit('trip:canceled', {
        tripId,
        canceledBy: 'PASSENGER',
        reason,
        canceledAt: new Date().toISOString(),
    });

    console.log('✅ [DRIVER-SOCKET] Cancellation notification sent');

    return true;
};

/**
 * Get list of active driver socket IDs
 */
const getActiveDrivers = () => {
    return Array.from(activeDrivers.keys());
};

/**
 * Check if driver is connected
 */
const isDriverConnected = (driverId) => {
    return activeDrivers.has(driverId);
};

module.exports = {
    initializeDriverSocket,
    sendTripOfferToDriver,
    notifyDriverTripCanceled,
    getActiveDrivers,
    isDriverConnected,
};