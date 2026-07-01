// src/sockets/driverHandlers.js

const { v4: uuidv4 } = require('uuid');
const { DriverLocation, Trip, TripEvent } = require('../models');
const {
    redisClient,
    setDriverOnline,
    setDriverOffline,
    setDriverAvailable,
    REDIS_KEYS,
    redisHelpers,
} = require('../config/redis');

// ── Notification service (lazy — avoids circular dep at startup) ──────────────
const getNotificationService = () => require('../services/NotificationService');

// Central ride state machine — the ONLY way trip.status should change.
const { applyTransition } = require('../services/tripState.service');

// ═══════════════════════════════════════════════════════════════════════
// INTERNAL HELPER
// ═══════════════════════════════════════════════════════════════════════

async function _updateDriverLocationInRedis(driverId, lat, lng, heading = 0, speed = 0, accuracy = 10) {
    await redisClient.geoadd(
        REDIS_KEYS.DRIVERS_GEO,
        parseFloat(lng),
        parseFloat(lat),
        driverId.toString()
    );

    await redisHelpers.setJson(`driver:location:${driverId}`, {
        driverId,
        lat:         parseFloat(lat),
        lng:         parseFloat(lng),
        heading,
        speed,
        accuracy,
        lastUpdated: new Date().toISOString(),
    }, 3600);

}

// ═══════════════════════════════════════════════════════════════════════
// DRIVER SOCKET EVENT HANDLERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Handle driver going online
 */
async function handleDriverOnline(socket, data) {
    try {
        console.log(`🟢 [SOCKET-DRIVER] ${socket.userId} going online`);

        const { lat, lng, heading = 0, speed = 0, accuracy = 10 } = data || {};

        if (!lat || !lng || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            console.log('❌ [SOCKET-DRIVER] Invalid coordinates');
            socket.emit('error', { message: 'Invalid coordinates provided' });
            return;
        }

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

        await setDriverOnline(socket.userId);
        await _updateDriverLocationInRedis(socket.userId, lat, lng, heading, speed, accuracy);

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
 * Handle driver going offline
 */
async function handleDriverOffline(socket, data) {
    try {
        console.log(`🔴 [SOCKET-DRIVER] ${socket.userId} going offline`);

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
 * Handle driver location update
 */
async function handleDriverLocationUpdate(socket, data, io) {
    try {
        const { lat, lng, heading = 0, speed = 0, accuracy = 10 } = data || {};

        if (!lat || !lng || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            return;
        }

        await _updateDriverLocationInRedis(socket.userId, lat, lng, heading, speed, accuracy);

        DriverLocation.update(
            { lat, lng, heading, speed, accuracy, last_updated: new Date() },
            { where: { driver_id: socket.userId } }
        ).catch(err => {
            console.error('⚠️ [SOCKET-DRIVER] Location update DB error:', err.message);
        });

        // Use Redis cache first to avoid DB hit on every GPS ping
        let passengerId = null;
        let tripId      = null;

        const activeTripRef = await redisHelpers.getJson(`driver:active_trip:${socket.userId}`);
        if (activeTripRef?.tripId) {
            const tripData = await redisHelpers.getJson(REDIS_KEYS.ACTIVE_TRIP(activeTripRef.tripId));
            if (tripData && !['COMPLETED', 'CANCELED'].includes(tripData.status)) {
                passengerId = tripData.passengerId;
                tripId      = tripData.id || activeTripRef.tripId;
            }
        }

        if (passengerId) {
            io.to(`passenger:${passengerId}`).emit('driver:location', {
                tripId,
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

        // Join the trip room so driver receives passenger cancel events
        socket.join(`trip:${tripId}`);

        const t = result.trip || {};
        socket.emit('trip:accept:success', {
            tripId:  tripId,
            message: 'Trip accepted successfully',
            trip: {
                id:             tripId,
                status:         t.status         || 'MATCHED',
                pickupLat:      t.pickupLat,
                pickupLng:      t.pickupLng,
                pickupAddress:  t.pickupAddress,
                dropoffLat:     t.dropoffLat,
                dropoffLng:     t.dropoffLng,
                dropoffAddress: t.dropoffAddress,
                fareEstimate:   t.fareEstimate,
                distanceM:      t.distanceM,
                durationS:      t.durationS,
                passenger:      result.passenger,
            },
            driver:    result.driver,
            passenger: result.passenger,
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

        await applyTransition(trip, 'DRIVER_EN_ROUTE', { actor: 'DRIVER' });

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

        await applyTransition(trip, 'DRIVER_ARRIVED', { actor: 'DRIVER' });

        console.log('✅ [SOCKET-DRIVER] Status updated to DRIVER_ARRIVED');

        const arrivedPayload = {
            tripId:    trip.id,
            status:    'DRIVER_ARRIVED',
            message:   'Driver has arrived at pickup location',
            timestamp: new Date().toISOString(),
        };
        io.to(`passenger:${trip.passengerId}`).emit('trip:status_changed', arrivedPayload);
        io.to(`passenger:${trip.passengerId}`).emit('trip:driver_arrived', arrivedPayload);

        socket.emit('trip:status:success', { tripId: trip.id, status: 'DRIVER_ARRIVED' });

        // ── 🔔 NOTIFICATION: Driver arrived → passenger ───────────────────
        getNotificationService().send({
            accountUuid: trip.passengerId,
            type:        'RIDE_DRIVER_ARRIVED',
            title:       '📍 Your driver has arrived!',
            body:        'Your driver is waiting at the pickup location. Please head out now.',
            data: {
                screen:  'trip_tracking',
                trip_id: String(trip.id),
            },
        }).catch(e => console.warn(`⚠️  [DRIVER-HANDLERS] Arrived push failed:`, e.message));

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

        await applyTransition(trip, 'IN_PROGRESS', { actor: 'DRIVER' });

        console.log('✅ [SOCKET-DRIVER] Trip started');

        const startedPayload = {
            tripId:    trip.id,
            status:    'IN_PROGRESS',
            message:   'Trip has started',
            startedAt: new Date().toISOString(),
            timestamp: new Date().toISOString(),
        };
        io.to(`passenger:${trip.passengerId}`).emit('trip:status_changed', startedPayload);
        io.to(`passenger:${trip.passengerId}`).emit('trip:started', startedPayload);

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

        if (finalFare) trip.fareFinal = finalFare;
        await applyTransition(trip, 'COMPLETED', { actor: 'DRIVER', meta: { finalFare: trip.fareFinal } });

        await setDriverAvailable(socket.userId);
        await DriverLocation.update(
            { is_available: true },
            { where: { driver_id: socket.userId } }
        );

        // Clean up Redis trip state
        await redisClient.del(REDIS_KEYS.ACTIVE_TRIP(tripId));
        await redisClient.del(`driver:active_trip:${socket.userId}`);
        await redisClient.del(`passenger:active_trip:${trip.passengerId}`);

        console.log('✅ [SOCKET-DRIVER] Trip completed');

        const completedPayload = {
            tripId:    trip.id,
            status:    'COMPLETED',
            message:   'Trip completed',
            finalFare: trip.fareFinal,
            timestamp: new Date().toISOString(),
        };
        io.to(`passenger:${trip.passengerId}`).emit('trip:status_changed', completedPayload);
        io.to(`passenger:${trip.passengerId}`).emit('trip:completed', completedPayload);

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
 * Handle trip cancellation by driver
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

        TripEvent.create({ id: uuidv4(), tripId, type: 'trip_canceled',
            payload: { canceledBy: 'DRIVER', driverId: socket.userId, reason: reason || 'No reason', timestamp: new Date().toISOString() } }).catch(() => {});

        await setDriverAvailable(socket.userId);
        await DriverLocation.update(
            { is_available: true },
            { where: { driver_id: socket.userId } }
        );

        // Clean up Redis trip state
        await redisClient.del(REDIS_KEYS.ACTIVE_TRIP(tripId));
        await redisClient.del(`driver:active_trip:${socket.userId}`);
        await redisClient.del(`passenger:active_trip:${trip.passengerId}`);

        console.log('✅ [SOCKET-DRIVER] Trip canceled by driver');

        io.to(`passenger:${trip.passengerId}`).emit('trip:canceled', {
            tripId:     trip.id,
            canceledBy: 'DRIVER',
            reason,
            timestamp:  new Date().toISOString(),
        });

        socket.emit('trip:cancel:success', { tripId: trip.id, message: 'Trip canceled' });

        // ── 🔔 NOTIFICATION: Trip cancelled by driver → passenger ──────────
        getNotificationService().send({
            accountUuid: trip.passengerId,
            type:        'RIDE_CANCELLED',
            title:       'Trip cancelled',
            body:        'Your driver cancelled the trip. Please request a new ride.',
            data: {
                screen:      'home',
                trip_id:     String(trip.id),
                canceled_by: 'DRIVER',
            },
        }).catch(e => console.warn(`⚠️  [DRIVER-HANDLERS] Cancel push to passenger failed:`, e.message));

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