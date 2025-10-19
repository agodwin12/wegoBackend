// src/services/matching.service.js

const { DriverLocation, Account, Trip } = require('../models');
const { Op } = require('sequelize');
const { sendTripOfferToDriver } = require('../socket/driver.socket');
const { getIO } = require('../socket/socket');

/**
 * Matching Service
 * Handles matching drivers to trip requests
 */

/**
 * Find nearby online drivers for a trip
 */
const findNearbyDrivers = async (pickupLat, pickupLng, radiusKm = 10) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔍 [MATCHING] Finding nearby drivers');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('Pickup Location:', pickupLat, pickupLng);
        console.log('Radius:', radiusKm, 'km');

        // Find nearby drivers using DriverLocation model
        const nearbyDrivers = await DriverLocation.findNearbyDrivers(
            pickupLat,
            pickupLng,
            radiusKm
        );

        console.log('✅ [MATCHING] Found', nearbyDrivers.length, 'nearby drivers');

        // Filter out drivers who have active trips
        const availableDrivers = [];

        for (const driverData of nearbyDrivers) {
            const activeTrip = await Trip.findOne({
                where: {
                    driver_id: driverData.driver_id,
                    status: {
                        [Op.in]: ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS'],
                    },
                },
            });

            if (!activeTrip) {
                availableDrivers.push(driverData);
            }
        }

        console.log('✅ [MATCHING] Available drivers:', availableDrivers.length);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return availableDrivers;

    } catch (error) {
        console.error('❌ [MATCHING] Error finding nearby drivers:', error);
        throw error;
    }
};

/**
 * Send trip offer to drivers (one by one or broadcast)
 */
const offerTripToDrivers = async (trip, strategy = 'sequential') => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📨 [MATCHING] Offering trip to drivers');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('Trip ID:', trip.uuid);
        console.log('Strategy:', strategy);

        // Find nearby drivers
        const nearbyDrivers = await findNearbyDrivers(
            trip.pickup_lat,
            trip.pickup_lng,
            10 // 10 km radius
        );

        if (nearbyDrivers.length === 0) {
            console.log('⚠️ [MATCHING] No drivers available');
            return {
                success: false,
                message: 'No drivers available nearby',
            };
        }

        // Prepare trip offer
        const tripOffer = {
            tripId: trip.uuid,
            pickup: {
                address: trip.pickup_address,
                lat: trip.pickup_lat,
                lng: trip.pickup_lng,
            },
            dropoff: {
                address: trip.dropoff_address,
                lat: trip.dropoff_lat,
                lng: trip.dropoff_lng,
            },
            distance: trip.distance_km,
            fare: trip.fare_estimate,
            passenger: {
                name: 'Passenger', // TODO: Get passenger name
                rating: 5.0,
            },
            expiresAt: new Date(Date.now() + 30000).toISOString(), // 30 seconds
        };

        const io = getIO();

        if (strategy === 'broadcast') {
            // Send to all nearby drivers at once
            console.log('📡 [MATCHING] Broadcasting to all drivers');

            let sentCount = 0;
            for (const driverData of nearbyDrivers) {
                const sent = sendTripOfferToDriver(io, driverData.driver_id, tripOffer);
                if (sent) sentCount++;
            }

            console.log(`✅ [MATCHING] Sent to ${sentCount} drivers`);
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            return {
                success: true,
                driversNotified: sentCount,
                strategy: 'broadcast',
            };

        } else {
            // Sequential: Send to closest driver first, wait for response
            console.log('🎯 [MATCHING] Sending to closest driver');

            const closestDriver = nearbyDrivers[0];
            const sent = sendTripOfferToDriver(io, closestDriver.driver_id, tripOffer);

            if (sent) {
                console.log('✅ [MATCHING] Sent to driver:', closestDriver.driver_id);
                console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

                return {
                    success: true,
                    driversNotified: 1,
                    strategy: 'sequential',
                    nextDrivers: nearbyDrivers.slice(1).map(d => d.driver_id),
                };
            }

            console.log('⚠️ [MATCHING] Closest driver not connected, trying next...');

            // Try next driver
            if (nearbyDrivers.length > 1) {
                return offerTripToDrivers(trip, strategy);
            }

            console.log('❌ [MATCHING] No connected drivers available');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            return {
                success: false,
                message: 'No connected drivers available',
            };
        }

    } catch (error) {
        console.error('❌ [MATCHING] Error offering trip:', error);
        throw error;
    }
};

/**
 * Handle trip request from passenger
 */
const handleTripRequest = async (tripData) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🚕 [MATCHING] New trip request');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('Passenger:', tripData.passenger_id);
        console.log('Pickup:', tripData.pickup_address);
        console.log('Dropoff:', tripData.dropoff_address);

        // Create trip record
        const trip = await Trip.create({
            ...tripData,
            status: 'SEARCHING',
        });

        console.log('✅ [MATCHING] Trip created:', trip.uuid);

        // Find and notify drivers
        const result = await offerTripToDrivers(trip, 'sequential');

        if (result.success) {
            // Update trip status
            trip.status = 'PENDING';
            await trip.save();

            console.log('✅ [MATCHING] Trip offered to drivers');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            return {
                success: true,
                trip,
                driversNotified: result.driversNotified,
            };
        }

        console.log('⚠️ [MATCHING] No drivers available');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return {
            success: false,
            trip,
            message: 'No drivers available',
        };

    } catch (error) {
        console.error('❌ [MATCHING] Error handling trip request:', error);
        throw error;
    }
};

module.exports = {
    findNearbyDrivers,
    offerTripToDrivers,
    handleTripRequest,
};