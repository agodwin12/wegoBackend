// src/sockets/locationHandlers.js
const locationService = require('../services/locationService');

module.exports = (io, socket) => {
    // Driver location updates
    socket.on('driver:location_update', async (data) => {
        try {
            if (socket.userType !== 'DRIVER') {
                return socket.emit('error', { message: 'Only drivers can update location' });
            }

            const { lat, lng, heading, speed } = data;

            if (!lat || !lng) {
                return socket.emit('error', { message: 'Latitude and longitude required' });
            }

            console.log(`📍 [LOCATION] Driver ${socket.userId}: [${lat}, ${lng}]`);

            // Update location in Redis
            await locationService.updateDriverLocation(
                socket.userId,
                parseFloat(lng),
                parseFloat(lat),
                {
                    heading: heading || 0,
                    speed: speed || 0,
                    status: 'online'
                }
            );

            // If driver is on a trip, broadcast location to passenger
            const driverMeta = await locationService.getDriverLocation(socket.userId);

            if (driverMeta && driverMeta.currentTripId) {
                const { Trip } = require('../models');
                const trip = await Trip.findByPk(driverMeta.currentTripId);

                if (trip && trip.passengerId) {
                    const { redisHelpers, REDIS_KEYS } = require('../config/redis');
                    const passengerSocketId = await redisHelpers.getJson(
                        REDIS_KEYS.USER_SOCKET(trip.passengerId)
                    );

                    if (passengerSocketId && io.sockets.sockets.get(passengerSocketId)) {
                        io.to(passengerSocketId).emit('driver:location_updated', {
                            tripId: driverMeta.currentTripId,
                            lat,
                            lng,
                            heading: heading || 0,
                            speed: speed || 0
                        });
                    }
                }
            }

            socket.emit('driver:location_update:success', { lat, lng });
        } catch (error) {
            console.error('❌ [LOCATION] Update error:', error.message);
            socket.emit('error', { message: 'Failed to update location' });
        }
    });

    // Get nearby drivers (for debugging/admin)
    socket.on('location:nearby_drivers', async (data) => {
        try {
            const { lat, lng, radius } = data;

            const nearbyDrivers = await locationService.findNearbyDrivers(
                parseFloat(lng),
                parseFloat(lat),
                radius || 5
            );

            socket.emit('location:nearby_drivers:result', {
                count: nearbyDrivers.length,
                drivers: nearbyDrivers
            });
        } catch (error) {
            console.error('❌ [LOCATION] Nearby drivers error:', error.message);
            socket.emit('error', { message: 'Failed to get nearby drivers' });
        }
    });
};