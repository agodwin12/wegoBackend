// src/services/tripMatching.service.js

const { findNearbyDrivers, getUserSocket } = require('../config/redis');
const { Account } = require('../models');

// ═══════════════════════════════════════════════════════════════════════
// TRIP MATCHING SERVICE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Find nearby drivers and send trip offers
 *
 * @param {Object} io - Socket.IO instance
 * @param {Object} trip - Trip object from database
 * @param {number} radiusKm - Search radius in kilometers
 * @param {number} maxDrivers - Maximum number of drivers to notify
 * @returns {Promise<Object>} Result with offered drivers count
 */
async function findAndOfferTrip(io, trip, radiusKm = 5, maxDrivers = 10) {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔍 [TRIP-MATCHING] Finding nearby drivers');
        console.log('🚕 Trip ID:', trip.uuid);
        console.log('📍 Pickup:', trip.pickup_location.lat, trip.pickup_location.lng);
        console.log('🔘 Radius:', radiusKm, 'km');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        // Find nearby drivers using Redis geospatial search
        const nearbyDrivers = await findNearbyDrivers(
            trip.pickup_location.lat,
            trip.pickup_location.lng,
            radiusKm
        );

        if (nearbyDrivers.length === 0) {
            console.log('⚠️ [TRIP-MATCHING] No drivers found');

            // Notify passenger
            io.to(`passenger:${trip.passenger_id}`).emit('trip:no_drivers', {
                tripId: trip.uuid,
                message: 'No drivers available in your area. Please try again.',
                timestamp: new Date().toISOString(),
            });

            return {
                success: false,
                driversFound: 0,
                driversOffered: 0,
            };
        }

        console.log(`✅ [TRIP-MATCHING] Found ${nearbyDrivers.length} nearby drivers`);

        // Limit to maxDrivers
        const driversToOffer = nearbyDrivers.slice(0, maxDrivers);

        // Get passenger info
        const passenger = await Account.findByPk(trip.passenger_id);

        // Prepare trip offer data
        const tripOffer = {
            tripId: trip.uuid,
            pickup: {
                lat: trip.pickup_location.lat,
                lng: trip.pickup_location.lng,
                address: trip.pickup_location.address || 'Pickup location',
            },
            dropoff: {
                lat: trip.dropoff_location.lat,
                lng: trip.dropoff_location.lng,
                address: trip.dropoff_location.address || 'Destination',
            },
            distance: trip.distance_km,
            distance_km: trip.distance_km,
            fare: trip.fare_estimate,
            fare_estimate: trip.fare_estimate,
            passenger: {
                name: `${passenger.first_name} ${passenger.last_name}`,
                rating: 5.0, // TODO: Get actual rating
            },
            passengerName: `${passenger.first_name} ${passenger.last_name}`,
            passengerRating: 5.0,
            expiresIn: 30, // seconds
            timestamp: new Date().toISOString(),
        };

        let offeredCount = 0;

        // Send trip offer to each driver
        for (const driver of driversToOffer) {
            try {
                // Get driver's socket ID
                const socketId = await getUserSocket(driver.driverId);

                if (socketId) {
                    // Emit trip offer
                    io.to(socketId).emit('trip:offer', {
                        ...tripOffer,
                        distanceToPickup: driver.distance,
                    });

                    offeredCount++;

                    console.log(`📤 [TRIP-MATCHING] Offer sent to driver ${driver.driverId}`);
                    console.log(`   Distance to pickup: ${driver.distance.toFixed(2)} km`);
                } else {
                    console.log(`⚠️ [TRIP-MATCHING] No socket found for driver ${driver.driverId}`);
                }
            } catch (error) {
                console.error(`❌ [TRIP-MATCHING] Error offering to driver ${driver.driverId}:`, error);
            }
        }

        console.log('\n✅ [TRIP-MATCHING] Trip offers sent');
        console.log(`   Drivers found: ${nearbyDrivers.length}`);
        console.log(`   Offers sent: ${offeredCount}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return {
            success: true,
            driversFound: nearbyDrivers.length,
            driversOffered: offeredCount,
        };

    } catch (error) {
        console.error('❌ [TRIP-MATCHING] Error in findAndOfferTrip:', error);

        // Notify passenger of error
        io.to(`passenger:${trip.passenger_id}`).emit('trip:error', {
            tripId: trip.uuid,
            message: 'Failed to find drivers. Please try again.',
            timestamp: new Date().toISOString(),
        });

        return {
            success: false,
            error: error.message,
            driversFound: 0,
            driversOffered: 0,
        };
    }
}

/**
 * Calculate distance between two coordinates (Haversine formula)
 *
 * @param {number} lat1 - Latitude of point 1
 * @param {number} lon1 - Longitude of point 1
 * @param {number} lat2 - Latitude of point 2
 * @param {number} lon2 - Longitude of point 2
 * @returns {number} Distance in kilometers
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radius of the Earth in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;

    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c;

    return distance;
}

/**
 * Calculate estimated fare based on distance
 *
 * @param {number} distanceKm - Distance in kilometers
 * @returns {number} Estimated fare in XAF
 */
function calculateFare(distanceKm) {
    const BASE_FARE = 500; // Base fare in XAF
    const PER_KM_RATE = 250; // Rate per kilometer in XAF
    const MIN_FARE = 500; // Minimum fare in XAF

    const fare = BASE_FARE + (distanceKm * PER_KM_RATE);

    return Math.max(fare, MIN_FARE);
}

/**
 * Calculate estimated time in minutes based on distance
 *
 * @param {number} distanceKm - Distance in kilometers
 * @returns {number} Estimated time in minutes
 */
function calculateEstimatedTime(distanceKm) {
    const AVERAGE_SPEED_KMH = 30; // Average speed in city
    const timeHours = distanceKm / AVERAGE_SPEED_KMH;
    const timeMinutes = Math.ceil(timeHours * 60);

    return Math.max(timeMinutes, 5); // Minimum 5 minutes
}

// ═══════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════

module.exports = {
    findAndOfferTrip,
    calculateDistance,
    calculateFare,
    calculateEstimatedTime,
};