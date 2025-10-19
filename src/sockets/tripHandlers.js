// src/sockets/tripHandlers.js
const tripMatchingService = require('../services/tripMatchingService');
const { Trip, TripEvent } = require('../models');
const { redisHelpers, REDIS_KEYS } = require('../config/redis');
const { v4: uuidv4 } = require('uuid');

module.exports = (io, socket) => {
    socket.on('trip:accept', async (data) => {
        try {
            if (socket.userType !== 'DRIVER') {
                console.log(`⚠️ [TRIP] Non-driver user ${socket.userId} tried to accept trip`);
                return socket.emit('error', { message: 'Only drivers can accept trips' });
            }

            const { tripId } = data;

            if (!tripId) {
                return socket.emit('error', { message: 'Trip ID required' });
            }

            console.log(`🤝 [TRIP] Driver ${socket.userId} accepting trip ${tripId}`);

            const result = await tripMatchingService.acceptTrip(tripId, socket.userId, io);

            if (!result.success) {
                console.log(`⚠️ [TRIP] Driver ${socket.userId} could not accept trip: ${result.reason}`);
                return socket.emit('trip:accept:failed', {
                    tripId,
                    reason: result.reason
                });
            }

            socket.emit('trip:accept:success', {
                tripId,
                trip: result.trip,
                message: 'Trip accepted successfully'
            });

            console.log(`✅ [TRIP] Driver ${socket.userId} successfully accepted trip ${tripId}`);
        } catch (error) {
            console.error(`❌ [TRIP] Error accepting trip:`, error.message);
            socket.emit('error', { message: 'Failed to accept trip' });
        }
    });

    socket.on('trip:decline', async (data) => {
        try {
            if (socket.userType !== 'DRIVER') {
                return socket.emit('error', { message: 'Only drivers can decline trips' });
            }

            const { tripId, reason } = data;

            if (!tripId) {
                return socket.emit('error', { message: 'Trip ID required' });
            }

            console.log(`❌ [TRIP] Driver ${socket.userId} declining trip ${tripId}`);

            await TripEvent.create({
                id: uuidv4(),
                tripId,
                type: 'driver_declined',
                payload: { driverId: socket.userId, reason: reason || 'No reason provided' }
            });

            socket.emit('trip:decline:success', {
                tripId,
                message: 'Trip declined'
            });

            console.log(`✅ [TRIP] Driver ${socket.userId} declined trip ${tripId}`);
        } catch (error) {
            console.error(`❌ [TRIP] Error declining trip:`, error.message);
            socket.emit('error', { message: 'Failed to decline trip' });
        }
    });

    socket.on('trip:update_status', async (data) => {
        try {
            const { tripId, status } = data;

            if (!tripId || !status) {
                return socket.emit('error', { message: 'Trip ID and status required' });
            }

            console.log(`🔄 [TRIP] User ${socket.userId} updating trip ${tripId} to status: ${status}`);

            const trip = await Trip.findOne({ where: { id: tripId } });

            if (!trip) {
                return socket.emit('error', { message: 'Trip not found' });
            }

            if (socket.userType === 'DRIVER' && trip.driverId !== socket.userId) {
                console.log(`⚠️ [TRIP] Driver ${socket.userId} not assigned to trip ${tripId}`);
                return socket.emit('error', { message: 'You are not assigned to this trip' });
            }

            if (socket.userType === 'PASSENGER' && trip.passengerId !== socket.userId) {
                console.log(`⚠️ [TRIP] Passenger ${socket.userId} not owner of trip ${tripId}`);
                return socket.emit('error', { message: 'You are not the owner of this trip' });
            }

            const validTransitions = {
                'matched': ['driver_en_route', 'canceled'],
                'driver_en_route': ['arrived_pickup', 'canceled'],
                'arrived_pickup': ['in_progress', 'canceled'],
                'in_progress': ['completed', 'canceled']
            };

            const allowedStatuses = validTransitions[trip.status] || [];

            if (!allowedStatuses.includes(status)) {
                console.log(`⚠️ [TRIP] Invalid status transition from ${trip.status} to ${status}`);
                return socket.emit('error', {
                    message: `Cannot change status from ${trip.status} to ${status}`
                });
            }

            const oldStatus = trip.status;
            await trip.update({ status });

            await redisHelpers.setJson(
                REDIS_KEYS.ACTIVE_TRIP(tripId),
                {
                    ...await redisHelpers.getJson(REDIS_KEYS.ACTIVE_TRIP(tripId)),
                    status
                },
                3600
            );

            await TripEvent.create({
                id: uuidv4(),
                tripId,
                type: 'status_changed',
                payload: {
                    oldStatus,
                    newStatus: status,
                    changedBy: socket.userId,
                    userType: socket.userType
                }
            });

            socket.emit('trip:status:success', {
                tripId,
                status,
                message: `Trip status updated to ${status}`
            });

            const otherUserId = socket.userType === 'DRIVER' ? trip.passengerId : trip.driverId;
            if (otherUserId) {
                const otherSocketId = await redisHelpers.getJson(REDIS_KEYS.USER_SOCKET(otherUserId));
                if (otherSocketId && io.sockets.sockets.get(otherSocketId)) {
                    io.to(otherSocketId).emit('trip:status_changed', {
                        tripId,
                        status,
                        changedBy: socket.userType
                    });
                    console.log(`📤 [TRIP] Notified ${otherUserId} of status change`);
                }
            }

            if (status === 'completed') {
                const locationService = require('../services/locationService');
                await locationService.updateDriverStatus(trip.driverId, 'online');
                await redisHelpers.releaseLock(REDIS_KEYS.ACTIVE_TRIP(tripId));
                console.log(`🏁 [TRIP] Trip ${tripId} completed, driver back online`);
            }

            console.log(`✅ [TRIP] Trip ${tripId} status updated: ${oldStatus} → ${status}`);
        } catch (error) {
            console.error(`❌ [TRIP] Error updating trip status:`, error.message);
            socket.emit('error', { message: 'Failed to update trip status' });
        }
    });

    socket.on('trip:cancel', async (data) => {
        try {
            const { tripId, reason } = data;

            if (!tripId) {
                return socket.emit('error', { message: 'Trip ID required' });
            }

            console.log(`🚫 [TRIP] User ${socket.userId} canceling trip ${tripId}`);

            const trip = await Trip.findOne({ where: { id: tripId } });

            if (!trip) {
                return socket.emit('error', { message: 'Trip not found' });
            }

            if (trip.passengerId !== socket.userId && trip.driverId !== socket.userId) {
                return socket.emit('error', { message: 'You are not authorized to cancel this trip' });
            }

            if (trip.status === 'completed' || trip.status === 'canceled') {
                return socket.emit('error', { message: 'Trip already completed or canceled' });
            }

            await trip.update({
                status: 'canceled',
                cancel_reason: reason || 'Canceled by user'
            });

            await TripEvent.create({
                id: uuidv4(),
                tripId,
                type: 'trip_canceled',
                payload: {
                    canceledBy: socket.userId,
                    userType: socket.userType,
                    reason: reason || 'No reason provided'
                }
            });

            if (trip.driverId) {
                const locationService = require('../services/locationService');
                await locationService.updateDriverStatus(trip.driverId, 'online');
            }

            await redisHelpers.releaseLock(REDIS_KEYS.ACTIVE_TRIP(tripId));

            socket.emit('trip:cancel:success', {
                tripId,
                message: 'Trip canceled successfully'
            });

            const otherUserId = socket.userType === 'DRIVER' ? trip.passengerId : trip.driverId;
            if (otherUserId) {
                const otherSocketId = await redisHelpers.getJson(REDIS_KEYS.USER_SOCKET(otherUserId));
                if (otherSocketId && io.sockets.sockets.get(otherSocketId)) {
                    io.to(otherSocketId).emit('trip:canceled', {
                        tripId,
                        canceledBy: socket.userType,
                        reason: reason || 'No reason provided'
                    });
                    console.log(`📤 [TRIP] Notified ${otherUserId} of trip cancellation`);
                }
            }

            console.log(`✅ [TRIP] Trip ${tripId} canceled by ${socket.userType} ${socket.userId}`);
        } catch (error) {
            console.error(`❌ [TRIP] Error canceling trip:`, error.message);
            socket.emit('error', { message: 'Failed to cancel trip' });
        }
    });
};