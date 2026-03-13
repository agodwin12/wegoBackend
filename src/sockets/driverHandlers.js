// src/sockets/driverHandlers.js

const { DriverLocation, Trip } = require('../models');
const {
    redisClient,
    setDriverOnline,
    setDriverOffline,
    setDriverAvailable,
    REDIS_KEYS,
    redisHelpers,
} = require('../config/redis');

// ═══════════════════════════════════════════════════════════════════════
// INTERNAL HELPER
// Writes driver location to BOTH the geo index AND the JSON store.
// This is what findNearbyDrivers() needs — GEOADD into DRIVERS_GEO.
// ═══════════════════════════════════════════════════════════════════════

async function _updateDriverLocationInRedis(driverId, lat, lng, heading = 0, speed = 0, accuracy = 10) {
    // ✅ FIX: GEOADD into the geo index so GEORADIUS finds this driver
    await redisClient.geoadd(
        REDIS_KEYS.DRIVERS_GEO,
        parseFloat(lng),
        parseFloat(lat),
        driverId.toString()
    );

    // Also keep the JSON location store for driver info lookups
    await redisHelpers.setJson(`driver:location:${driverId}`, {
        driverId,
        lat:         parseFloat(lat),
        lng:         parseFloat(lng),
        heading,
        speed,
        accuracy,
        lastUpdated: new Date().toISOString(),
    }, 3600);

    console.log(`📍 [REDIS] Driver location stored: ${driverId} (${lat}, ${lng})`);
}

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
        console.log('📍 Location:', data?.lat, data?.lng);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        const { lat, lng, heading = 0, speed = 0, accuracy = 10 } = data || {};

        if (!lat || !lng || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            console.log('❌ [SOCKET-DRIVER] Invalid coordinates');
            socket.emit('error', { message: 'Invalid coordinates provided' });
            return;
        }

        // Update DB
        await DriverLocation.upsert({
            driver_id:    socket.userId,
            lat,
            lng,
            heading,
            speed,
            accuracy,
            is_online:    true,
            is_available: true,
            last_updated: new Date(),
        });

        // ✅ FIX: setDriverOnline adds to ONLINE + AVAILABLE sets
        await setDriverOnline(socket.userId);

        // ✅ FIX: _updateDriverLocationInRedis does GEOADD into geo index
        await _updateDriverLocationInRedis(socket.userId, lat, lng, heading, speed, accuracy);

        // Also write metadata key so getStatus() works
        await redisClient.setex(
            REDIS_KEYS.DRIVER_META(socket.userId),
            3600,
            JSON.stringify({
                driverId:    socket.userId,
                status:      'ONLINE',
                isAvailable: true,
                lastUpdated: new Date().toISOString(),
            })
        );

        socket.join(`driver:${socket.userId}`);

        console.log('✅ [SOCKET-DRIVER] Driver is now online');

        socket.emit('driver:status', {
            status:    'online',
            message:   'You are now online and ready to receive trips',
            timestamp: new Date().toISOString(),
        });

    } catch (error) {
        console.error('❌ [SOCKET-DRIVER] Error handling driver online:', error);
        socket.emit('error', {
            message: 'Failed to go online. Please try again.',
            error:   error.message,
        });
    }
}

/**
 * Handle driver going offline (explicit — button press)
 */
async function handleDriverOffline(socket, data) {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔴 [SOCKET-DRIVER] Driver going offline (explicit)');
        console.log('👤 Driver ID:', socket.userId);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        const activeTrip = await Trip.findOne({
            where: {
                driverId: socket.userId,
                status:   ['MATCHED', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS'],
            },
        });

        if (activeTrip) {
            console.log('⚠️ [SOCKET-DRIVER] Driver has active trip, cannot go offline');
            socket.emit('error', {
                message:      'Cannot go offline while you have an active trip',
                activeTripId: activeTrip.id,
            });
            return;
        }

        await DriverLocation.update(
            { is_online: false, is_available: false },
            { where: { driver_id: socket.userId } }
        );

        // ✅ Explicit offline — wipe geo index (driver chose to go offline)
        await setDriverOffline(socket.userId);

        socket.leave(`driver:${socket.userId}`);

        console.log('✅ [SOCKET-DRIVER] Driver is now offline');

        socket.emit('driver:status', {
            status:    'offline',
            message:   'You are now offline',
            timestamp: new Date().toISOString(),
        });

    } catch (error) {
        console.error('❌ [SOCKET-DRIVER] Error handling driver offline:', error);
        socket.emit('error', {
            message: 'Failed to go offline. Please try again.',
            error:   error.message,
        });
    }
}

/**
 * Handle driver location update (called every few seconds during a trip)
 */
async function handleDriverLocationUpdate(socket, data, io) {
    try {
        const { lat, lng, heading = 0, speed = 0, accuracy = 10 } = data || {};

        if (!lat || !lng || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            return; // Silent fail for location updates
        }

        // ✅ FIX: Always GEOADD so driver stays in geo index
        await _updateDriverLocationInRedis(socket.userId, lat, lng, heading, speed, accuracy);

        // DB update (fire-and-forget)
        DriverLocation.update(
            { lat, lng, heading, speed, accuracy, last_updated: new Date() },
            { where: { driver_id: socket.userId } }
        ).catch(err => {
            console.error('⚠️ [SOCKET-DRIVER] Location update DB error:', err.message);
        });

        // Forward location to passenger if driver has active trip
        const activeTrip = await Trip.findOne({
            where: {
                driverId: socket.userId,
                status:   ['MATCHED', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS'],
            },
        });

        if (activeTrip?.passengerId) {
            io.to(`passenger:${activeTrip.passengerId}`).emit('driver:location', {
                tripId:    activeTrip.id,
                lat,
                lng,
                heading,
                speed,
                timestamp: new Date().toISOString(),
            });
        }

    } catch (error) {
        console.error('❌ [SOCKET-DRIVER] Location update error:', error.message);
    }
}

/**
 * Handle driver accepting a trip
 */
async function handleTripAccept(socket, data, io) {
    const { tripId } = data || {};
    const driverId   = socket.userId;

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ [SOCKET-DRIVER] Driver accepting trip');
    console.log('👤 Driver ID:', driverId);
    console.log('🚕 Trip ID:', tripId);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    try {
        if (!tripId) {
            return socket.emit('trip:accept:failed', { message: 'Trip ID is required' });
        }

        const tripMatchingService = require('../services/tripMatchingService');
        const result = await tripMatchingService.acceptTrip(tripId, driverId, io);

        if (!result.success) {
            console.log(`⚠️ [SOCKET-DRIVER] Could not accept trip: ${result.reason}`);
            return socket.emit('trip:accept:failed', { tripId, message: result.reason });
        }

        console.log('✅ [SOCKET-DRIVER] Trip accepted successfully');

        socket.emit('trip:accept:success', {
            tripId:  result.trip.id,
            message: 'Trip accepted successfully',
            trip: {
                id:             result.trip.id,
                status:         result.trip.status,
                pickupLat:      result.trip.pickupLat,
                pickupLng:      result.trip.pickupLng,
                pickupAddress:  result.trip.pickupAddress,
                dropoffLat:     result.trip.dropoffLat,
                dropoffLng:     result.trip.dropoffLng,
                dropoffAddress: result.trip.dropoffAddress,
                fareEstimate:   result.trip.fareEstimate,
                distanceM:      result.trip.distanceM,
                durationS:      result.trip.durationS,
            },
            driver: result.driver,
        });

    } catch (error) {
        console.error('❌ [SOCKET-DRIVER] Trip accept error:', error);
        socket.emit('trip:accept:failed', {
            tripId,
            message: 'Failed to accept trip. Please try again.',
            error:   error.message,
        });
    }
}

/**
 * Handle driver declining a trip
 */
async function handleTripDecline(socket, data) {
    const { tripId, reason = 'Driver declined' } = data || {};

    console.log('\n❌ [SOCKET-DRIVER] Driver declining trip');
    console.log('👤 Driver ID:', socket.userId);
    console.log('🚕 Trip ID:', tripId);

    try {
        socket.emit('trip:decline:success', { tripId, message: 'Trip declined' });
        console.log('✅ [SOCKET-DRIVER] Trip declined acknowledged');
    } catch (error) {
        console.error('❌ [SOCKET-DRIVER] Trip decline error:', error);
    }
}

/**
 * Handle driver en route to pickup
 */
async function handleDriverEnRoute(socket, data, io) {
    const { tripId } = data || {};

    console.log('\n🚗 [SOCKET-DRIVER] Driver en route to pickup');
    console.log('👤 Driver ID:', socket.userId, '| Trip ID:', tripId);

    try {
        const trip = await Trip.findByPk(tripId);

        if (!trip || trip.driverId !== socket.userId) {
            return socket.emit('error', { message: 'Trip not found or not assigned to you' });
        }

        trip.status          = 'DRIVER_EN_ROUTE';
        trip.driverEnRouteAt = new Date();
        await trip.save();

        console.log('✅ [SOCKET-DRIVER] Status updated to DRIVER_EN_ROUTE');

        io.to(`passenger:${trip.passengerId}`).emit('trip:status_changed', {
            tripId:    trip.id,
            status:    'DRIVER_EN_ROUTE',
            message:   'Driver is on the way to pick you up',
            timestamp: new Date().toISOString(),
        });

        socket.emit('trip:status:success', { tripId: trip.id, status: 'DRIVER_EN_ROUTE' });

    } catch (error) {
        console.error('❌ [SOCKET-DRIVER] Driver en route error:', error);
        socket.emit('error', { message: 'Failed to update status' });
    }
}

/**
 * Handle driver arrived at pickup
 */
async function handleDriverArrived(socket, data, io) {
    const { tripId } = data || {};

    console.log('\n📍 [SOCKET-DRIVER] Driver arrived at pickup');
    console.log('👤 Driver ID:', socket.userId, '| Trip ID:', tripId);

    try {
        const trip = await Trip.findByPk(tripId);

        if (!trip || trip.driverId !== socket.userId) {
            return socket.emit('error', { message: 'Trip not found or not assigned to you' });
        }

        trip.status          = 'DRIVER_ARRIVED';
        trip.driverArrivedAt = new Date();
        await trip.save();

        console.log('✅ [SOCKET-DRIVER] Status updated to DRIVER_ARRIVED');

        io.to(`passenger:${trip.passengerId}`).emit('trip:status_changed', {
            tripId:    trip.id,
            status:    'DRIVER_ARRIVED',
            message:   'Driver has arrived at pickup location',
            timestamp: new Date().toISOString(),
        });

        socket.emit('trip:status:success', { tripId: trip.id, status: 'DRIVER_ARRIVED' });

    } catch (error) {
        console.error('❌ [SOCKET-DRIVER] Driver arrived error:', error);
        socket.emit('error', { message: 'Failed to update status' });
    }
}

/**
 * Handle trip start
 */
async function handleTripStart(socket, data, io) {
    const { tripId } = data || {};

    console.log('\n🚀 [SOCKET-DRIVER] Starting trip');
    console.log('👤 Driver ID:', socket.userId, '| Trip ID:', tripId);

    try {
        const trip = await Trip.findByPk(tripId);

        if (!trip || trip.driverId !== socket.userId) {
            return socket.emit('error', { message: 'Trip not found or not assigned to you' });
        }

        trip.status        = 'IN_PROGRESS';
        trip.tripStartedAt = new Date();
        await trip.save();

        console.log('✅ [SOCKET-DRIVER] Trip started');

        io.to(`passenger:${trip.passengerId}`).emit('trip:status_changed', {
            tripId:    trip.id,
            status:    'IN_PROGRESS',
            message:   'Trip has started',
            timestamp: new Date().toISOString(),
        });

        socket.emit('trip:status:success', { tripId: trip.id, status: 'IN_PROGRESS' });

    } catch (error) {
        console.error('❌ [SOCKET-DRIVER] Trip start error:', error);
        socket.emit('error', { message: 'Failed to start trip' });
    }
}

/**
 * Handle trip completion
 */
async function handleTripComplete(socket, data, io) {
    const { tripId, finalFare } = data || {};

    console.log('\n🏁 [SOCKET-DRIVER] Completing trip');
    console.log('👤 Driver ID:', socket.userId, '| Trip ID:', tripId, '| Fare:', finalFare);

    try {
        const trip = await Trip.findByPk(tripId);

        if (!trip || trip.driverId !== socket.userId) {
            return socket.emit('error', { message: 'Trip not found or not assigned to you' });
        }

        trip.status          = 'COMPLETED';
        trip.tripCompletedAt = new Date();
        if (finalFare) trip.fareFinal = finalFare;
        await trip.save();

        await setDriverAvailable(socket.userId);
        await DriverLocation.update(
            { is_available: true },
            { where: { driver_id: socket.userId } }
        );

        console.log('✅ [SOCKET-DRIVER] Trip completed');

        io.to(`passenger:${trip.passengerId}`).emit('trip:status_changed', {
            tripId:    trip.id,
            status:    'COMPLETED',
            message:   'Trip completed',
            finalFare: trip.fareFinal,
            timestamp: new Date().toISOString(),
        });

        socket.emit('trip:status:success', {
            tripId:  trip.id,
            status:  'COMPLETED',
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
    const { tripId, reason } = data || {};

    console.log('\n🚫 [SOCKET-DRIVER] Canceling trip');
    console.log('👤 Driver ID:', socket.userId, '| Trip ID:', tripId);

    try {
        const trip = await Trip.findByPk(tripId);

        if (!trip || trip.driverId !== socket.userId) {
            return socket.emit('error', { message: 'Trip not found or not assigned to you' });
        }

        trip.status       = 'CANCELED';
        trip.canceledBy   = 'DRIVER';
        trip.cancelReason = reason;
        trip.canceledAt   = new Date();
        await trip.save();

        await setDriverAvailable(socket.userId);
        await DriverLocation.update(
            { is_available: true },
            { where: { driver_id: socket.userId } }
        );

        console.log('✅ [SOCKET-DRIVER] Trip canceled');

        io.to(`passenger:${trip.passengerId}`).emit('trip:canceled', {
            tripId:     trip.id,
            canceledBy: 'DRIVER',
            reason,
            timestamp:  new Date().toISOString(),
        });

        socket.emit('trip:cancel:success', { tripId: trip.id, message: 'Trip canceled' });

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