// src/sockets/driverHandlers.js

const { DriverLocation, Trip } = require('../models');
const {
    setDriverLocation,
    setDriverOnline,
    setDriverOffline,
    setDriverUnavailable,
    setDriverAvailable,
    acquireLock,
    releaseLock,
    REDIS_KEYS,
} = require('../config/redis');

// ═══════════════════════════════════════════════════════════════════════
// DRIVER SOCKET EVENT HANDLERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Handle driver going online
 */
async function handleDriverOnline(socket, data) {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🟢 [SOCKET-DRIVER] Driver going online');
        console.log('👤 Driver ID:', socket.userId);
        console.log('📍 Location:', data.lat, data.lng);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        const { lat, lng, heading = 0, speed = 0, accuracy = 10 } = data;

        // Validate coordinates
        if (!lat || !lng || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            console.log('❌ [SOCKET-DRIVER] Invalid coordinates');
            socket.emit('error', { message: 'Invalid coordinates provided' });
            return;
        }

        // Update database
        await DriverLocation.upsert({
            driver_id: socket.userId,
            lat,
            lng,
            heading,
            speed,
            accuracy,
            is_online: true,
            is_available: true,
            last_updated: new Date(),
        });

        // Update Redis
        await setDriverOnline(socket.userId);
        await setDriverLocation(socket.userId, lat, lng, { heading, speed, accuracy });

        // Join driver room
        socket.join(`driver:${socket.userId}`);

        console.log('✅ [SOCKET-DRIVER] Driver is now online');

        // Confirm to driver
        socket.emit('driver:status', {
            status: 'online',
            message: 'You are now online and ready to receive trips',
            timestamp: new Date().toISOString(),
        });

    } catch (error) {
        console.error('❌ [SOCKET-DRIVER] Error handling driver online:', error);
        socket.emit('error', {
            message: 'Failed to go online. Please try again.',
            error: error.message,
        });
    }
}

/**
 * Handle driver going offline
 */
async function handleDriverOffline(socket, data) {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔴 [SOCKET-DRIVER] Driver going offline');
        console.log('👤 Driver ID:', socket.userId);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        // ✅ FIXED: Use camelCase and UPPERCASE status
        const activeTrip = await Trip.findOne({
            where: {
                driverId: socket.userId,
                status: ['MATCHED', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS'],
            },
        });

        if (activeTrip) {
            console.log('⚠️ [SOCKET-DRIVER] Driver has active trip, cannot go offline');
            socket.emit('error', {
                message: 'Cannot go offline while you have an active trip',
                activeTripId: activeTrip.id,
            });
            return;
        }

        // Update database
        await DriverLocation.update(
            {
                is_online: false,
                is_available: false,
            },
            {
                where: { driver_id: socket.userId },
            }
        );

        // Update Redis
        await setDriverOffline(socket.userId);

        // Leave driver room
        socket.leave(`driver:${socket.userId}`);

        console.log('✅ [SOCKET-DRIVER] Driver is now offline');

        // Confirm to driver
        socket.emit('driver:status', {
            status: 'offline',
            message: 'You are now offline',
            timestamp: new Date().toISOString(),
        });

    } catch (error) {
        console.error('❌ [SOCKET-DRIVER] Error handling driver offline:', error);
        socket.emit('error', {
            message: 'Failed to go offline. Please try again.',
            error: error.message,
        });
    }
}

/**
 * Handle driver location update
 */
async function handleDriverLocationUpdate(socket, data, io) {
    try {
        const { lat, lng, heading = 0, speed = 0, accuracy = 10 } = data;

        // Validate coordinates
        if (!lat || !lng || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            return; // Silent fail for location updates
        }

        // Update database (async, don't wait)
        DriverLocation.update(
            {
                lat,
                lng,
                heading,
                speed,
                accuracy,
                last_updated: new Date(),
            },
            {
                where: { driver_id: socket.userId },
            }
        ).catch(err => {
            console.error('⚠️ [SOCKET-DRIVER] Location update DB error:', err.message);
        });

        // Update Redis (this is fast)
        await setDriverLocation(socket.userId, lat, lng, { heading, speed, accuracy });

        // ✅ FIXED: Use camelCase and UPPERCASE status
        const activeTrip = await Trip.findOne({
            where: {
                driverId: socket.userId,
                status: ['MATCHED', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS'],
            },
        });

        if (activeTrip && activeTrip.passengerId) {
            // Emit to passenger room
            io.to(`passenger:${activeTrip.passengerId}`).emit('driver:location', {
                tripId: activeTrip.id,
                lat,
                lng,
                heading,
                speed,
                timestamp: new Date().toISOString(),
            });
        }

    } catch (error) {
        console.error('❌ [SOCKET-DRIVER] Location update error:', error.message);
        // Silent fail - don't interrupt driver
    }
}

/**
 * Handle driver accepting a trip
 */
async function handleTripAccept(socket, data, io) {
    const { tripId } = data;
    const driverId = socket.userId;

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ [SOCKET-DRIVER] Driver accepting trip');
    console.log('👤 Driver ID:', driverId);
    console.log('🚕 Trip ID:', tripId);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    try {
        // Acquire atomic lock
        const lockKey = REDIS_KEYS.TRIP_LOCK(tripId);
        const lockAcquired = await acquireLock(lockKey, driverId, 10);

        if (!lockAcquired) {
            console.log('⚠️ [SOCKET-DRIVER] Trip already being accepted by another driver');
            socket.emit('trip:accept:failed', {
                tripId,
                message: 'Another driver is accepting this trip',
            });
            return;
        }

        try {
            // Find the trip
            const trip = await Trip.findByPk(tripId);

            if (!trip) {
                console.log('❌ [SOCKET-DRIVER] Trip not found');
                socket.emit('trip:accept:failed', {
                    tripId,
                    message: 'Trip not found',
                });
                return;
            }

            // ✅ FIXED: Check for UPPERCASE 'SEARCHING'
            if (trip.status !== 'SEARCHING') {
                console.log('⚠️ [SOCKET-DRIVER] Trip is not searching:', trip.status);
                socket.emit('trip:accept:failed', {
                    tripId,
                    message: 'Trip is no longer available',
                    currentStatus: trip.status,
                });
                return;
            }

            // ✅ FIXED: Use camelCase and UPPERCASE status
            const activeTrip = await Trip.findOne({
                where: {
                    driverId: driverId,
                    status: ['MATCHED', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS'],
                },
            });

            if (activeTrip) {
                console.log('⚠️ [SOCKET-DRIVER] Driver already has active trip');
                socket.emit('trip:accept:failed', {
                    tripId,
                    message: 'You already have an active trip',
                    activeTripId: activeTrip.id,
                });
                return;
            }

            // ✅ FIXED: Use camelCase fields and UPPERCASE 'MATCHED'
            trip.driverId = driverId;
            trip.status = 'MATCHED';
            trip.driverAssignedAt = new Date();
            await trip.save();

            // Mark driver as unavailable
            await setDriverUnavailable(driverId);
            await DriverLocation.update(
                { is_available: false },
                { where: { driver_id: driverId } }
            );

            console.log('✅ [SOCKET-DRIVER] Trip accepted successfully');
            console.log('   Trip Status:', trip.status);
            console.log('   Driver:', driverId);

            // Get driver info with vehicle
            const driver = await trip.getDriver({
                include: ['Vehicle']
            });

            // ✅ Emit success to driver
            socket.emit('trip:accept:success', {
                tripId: trip.id,
                message: 'Trip accepted successfully',
                trip: {
                    id: trip.id,
                    status: trip.status,
                    pickupLat: trip.pickupLat,
                    pickupLng: trip.pickupLng,
                    pickupAddress: trip.pickupAddress,
                    dropoffLat: trip.dropoffLat,
                    dropoffLng: trip.dropoffLng,
                    dropoffAddress: trip.dropoffAddress,
                    fareEstimate: trip.fareEstimate,
                },
            });

            // ✅ Emit to passenger that driver is assigned
            io.to(`passenger:${trip.passengerId}`).emit('trip:driver_assigned', {
                tripId: trip.id,
                status: 'MATCHED',
                driver: {
                    id: driver.id,
                    name: `${driver.first_name} ${driver.last_name}`,
                    phone: driver.phone_e164,
                    rating: driver.rating || 4.8,
                    vehicle: driver.Vehicle ? {
                        make: driver.Vehicle.make,
                        model: driver.Vehicle.model,
                        color: driver.Vehicle.color,
                        plate: driver.Vehicle.license_plate,
                    } : null,
                },
                message: 'Driver is on the way!',
                timestamp: new Date().toISOString(),
            });

            // Notify other drivers that trip is no longer available
            io.emit('trip:offer:canceled', { tripId: trip.id });

        } finally {
            // Always release lock
            await releaseLock(lockKey);
        }

    } catch (error) {
        console.error('❌ [SOCKET-DRIVER] Trip accept error:', error);
        socket.emit('trip:accept:failed', {
            tripId,
            message: 'Failed to accept trip. Please try again.',
            error: error.message,
        });
    }
}

/**
 * Handle driver declining a trip
 */
async function handleTripDecline(socket, data) {
    const { tripId, reason = 'Driver declined' } = data;
    const driverId = socket.userId;

    console.log('\n❌ [SOCKET-DRIVER] Driver declining trip');
    console.log('👤 Driver ID:', driverId);
    console.log('🚕 Trip ID:', tripId);
    console.log('📝 Reason:', reason);
    console.log('');

    try {
        // Just acknowledge - trip will be offered to next driver
        socket.emit('trip:decline:success', {
            tripId,
            message: 'Trip declined',
        });

        console.log('✅ [SOCKET-DRIVER] Trip declined acknowledged');

    } catch (error) {
        console.error('❌ [SOCKET-DRIVER] Trip decline error:', error);
    }
}

/**
 * Handle driver en route to pickup
 */
async function handleDriverEnRoute(socket, data, io) {
    const { tripId } = data;
    const driverId = socket.userId;

    console.log('\n🚗 [SOCKET-DRIVER] Driver en route to pickup');
    console.log('👤 Driver ID:', driverId);
    console.log('🚕 Trip ID:', tripId);
    console.log('');

    try {
        const trip = await Trip.findByPk(tripId);

        if (!trip || trip.driverId !== driverId) {
            socket.emit('error', { message: 'Trip not found or not assigned to you' });
            return;
        }

        // ✅ FIXED: Use camelCase and UPPERCASE
        trip.status = 'DRIVER_EN_ROUTE';
        trip.driverEnRouteAt = new Date();
        await trip.save();

        console.log('✅ [SOCKET-DRIVER] Status updated to DRIVER_EN_ROUTE');

        // Notify passenger
        io.to(`passenger:${trip.passengerId}`).emit('trip:status_changed', {
            tripId: trip.id,
            status: 'DRIVER_EN_ROUTE',
            message: 'Driver is on the way to pick you up',
            timestamp: new Date().toISOString(),
        });

        socket.emit('trip:status:success', {
            tripId: trip.id,
            status: 'DRIVER_EN_ROUTE',
        });

    } catch (error) {
        console.error('❌ [SOCKET-DRIVER] Driver en route error:', error);
        socket.emit('error', { message: 'Failed to update status' });
    }
}

/**
 * Handle driver arrived at pickup
 */
async function handleDriverArrived(socket, data, io) {
    const { tripId } = data;
    const driverId = socket.userId;

    console.log('\n📍 [SOCKET-DRIVER] Driver arrived at pickup');
    console.log('👤 Driver ID:', driverId);
    console.log('🚕 Trip ID:', tripId);
    console.log('');

    try {
        const trip = await Trip.findByPk(tripId);

        if (!trip || trip.driverId !== driverId) {
            socket.emit('error', { message: 'Trip not found or not assigned to you' });
            return;
        }

        // ✅ FIXED: Use camelCase and UPPERCASE
        trip.status = 'DRIVER_ARRIVED';
        trip.driverArrivedAt = new Date();
        await trip.save();

        console.log('✅ [SOCKET-DRIVER] Status updated to DRIVER_ARRIVED');

        // Notify passenger
        io.to(`passenger:${trip.passengerId}`).emit('trip:status_changed', {
            tripId: trip.id,
            status: 'DRIVER_ARRIVED',
            message: 'Driver has arrived at pickup location',
            timestamp: new Date().toISOString(),
        });

        socket.emit('trip:status:success', {
            tripId: trip.id,
            status: 'DRIVER_ARRIVED',
        });

    } catch (error) {
        console.error('❌ [SOCKET-DRIVER] Driver arrived error:', error);
        socket.emit('error', { message: 'Failed to update status' });
    }
}

/**
 * Handle trip start
 */
async function handleTripStart(socket, data, io) {
    const { tripId } = data;
    const driverId = socket.userId;

    console.log('\n🚀 [SOCKET-DRIVER] Starting trip');
    console.log('👤 Driver ID:', driverId);
    console.log('🚕 Trip ID:', tripId);
    console.log('');

    try {
        const trip = await Trip.findByPk(tripId);

        if (!trip || trip.driverId !== driverId) {
            socket.emit('error', { message: 'Trip not found or not assigned to you' });
            return;
        }

        // ✅ FIXED: Use camelCase and UPPERCASE
        trip.status = 'IN_PROGRESS';
        trip.tripStartedAt = new Date();
        await trip.save();

        console.log('✅ [SOCKET-DRIVER] Trip started');

        // Notify passenger
        io.to(`passenger:${trip.passengerId}`).emit('trip:status_changed', {
            tripId: trip.id,
            status: 'IN_PROGRESS',
            message: 'Trip has started',
            timestamp: new Date().toISOString(),
        });

        socket.emit('trip:status:success', {
            tripId: trip.id,
            status: 'IN_PROGRESS',
        });

    } catch (error) {
        console.error('❌ [SOCKET-DRIVER] Trip start error:', error);
        socket.emit('error', { message: 'Failed to start trip' });
    }
}

/**
 * Handle trip completion
 */
async function handleTripComplete(socket, data, io) {
    const { tripId, finalFare } = data;
    const driverId = socket.userId;

    console.log('\n🏁 [SOCKET-DRIVER] Completing trip');
    console.log('👤 Driver ID:', driverId);
    console.log('🚕 Trip ID:', tripId);
    console.log('💰 Final Fare:', finalFare);
    console.log('');

    try {
        const trip = await Trip.findByPk(tripId);

        if (!trip || trip.driverId !== driverId) {
            socket.emit('error', { message: 'Trip not found or not assigned to you' });
            return;
        }

        // ✅ FIXED: Use camelCase and UPPERCASE
        trip.status = 'COMPLETED';
        trip.tripCompletedAt = new Date();
        if (finalFare) trip.fareFinal = finalFare;
        await trip.save();

        // Mark driver as available again
        await setDriverAvailable(driverId);
        await DriverLocation.update(
            { is_available: true },
            { where: { driver_id: driverId } }
        );

        console.log('✅ [SOCKET-DRIVER] Trip completed');

        // Notify passenger
        io.to(`passenger:${trip.passengerId}`).emit('trip:status_changed', {
            tripId: trip.id,
            status: 'COMPLETED',
            message: 'Trip completed',
            finalFare: trip.fareFinal,
            timestamp: new Date().toISOString(),
        });

        socket.emit('trip:status:success', {
            tripId: trip.id,
            status: 'COMPLETED',
            message: 'Trip completed successfully',
        });

    } catch (error) {
        console.error('❌ [SOCKET-DRIVER] Trip complete error:', error);
        socket.emit('error', { message: 'Failed to complete trip' });
    }
}

/**
 * Handle trip cancellation
 */
async function handleTripCancel(socket, data, io) {
    const { tripId, reason } = data;
    const driverId = socket.userId;

    console.log('\n🚫 [SOCKET-DRIVER] Canceling trip');
    console.log('👤 Driver ID:', driverId);
    console.log('🚕 Trip ID:', tripId);
    console.log('📝 Reason:', reason);
    console.log('');

    try {
        const trip = await Trip.findByPk(tripId);

        if (!trip || trip.driverId !== driverId) {
            socket.emit('error', { message: 'Trip not found or not assigned to you' });
            return;
        }

        // ✅ FIXED: Use camelCase and UPPERCASE
        trip.status = 'CANCELED';
        trip.canceledBy = 'DRIVER';
        trip.cancelReason = reason;
        trip.canceledAt = new Date();
        await trip.save();

        // Mark driver as available again
        await setDriverAvailable(driverId);
        await DriverLocation.update(
            { is_available: true },
            { where: { driver_id: driverId } }
        );

        console.log('✅ [SOCKET-DRIVER] Trip canceled');

        // Notify passenger
        io.to(`passenger:${trip.passengerId}`).emit('trip:canceled', {
            tripId: trip.id,
            canceledBy: 'DRIVER',
            reason,
            timestamp: new Date().toISOString(),
        });

        socket.emit('trip:cancel:success', {
            tripId: trip.id,
            message: 'Trip canceled',
        });

    } catch (error) {
        console.error('❌ [SOCKET-DRIVER] Trip cancel error:', error);
        socket.emit('error', { message: 'Failed to cancel trip' });
    }
}

// ═══════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════

module.exports = {
    handleDriverOnline,
    handleDriverOffline,
    handleDriverLocationUpdate,
    handleTripAccept,
    handleTripDecline,
    handleDriverEnRoute,
    handleDriverArrived,
    handleTripStart,
    handleTripComplete,
    handleTripCancel,
};