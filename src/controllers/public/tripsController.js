// backend/src/controllers/public/tripsController.js

const { Trip, Account, DriverProfile, Rating, Payment } = require('../../models');
const { Op } = require('sequelize');

/**
 * 🚗 GET RECENT TRIPS FOR USER
 */
exports.getRecentTrips = async (req, res) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🚗 [RECENT TRIPS] Fetching recent trips...');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        const userId = req.user.uuid;
        const userType = req.user.user_type;
        const { limit = 10, status } = req.query;

        console.log(`👤 User: ${userId}`);
        console.log(`🏷️  Type: ${userType}`);
        console.log(`📊 Limit: ${limit}`);

        // Build where clause based on user type
        const where = {
            [userType === 'PASSENGER' ? 'passengerId' : 'driverId']: userId
        };

        // Filter by status if provided
        if (status) {
            where.status = status.toUpperCase();
        } else {
            // Default: only show completed and canceled trips
            where.status = {
                [Op.in]: ['COMPLETED', 'CANCELED']
            };
        }

        console.log('🔍 Query filters:', JSON.stringify(where, null, 2));

        // Fetch trips with related data
        const trips = await Trip.findAll({
            where,
            limit: parseInt(limit),
            order: [['createdAt', 'DESC']],
            include: [
                {
                    model: Account,
                    as: 'passenger',
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'],
                    required: false
                },
                {
                    model: Account,
                    as: 'driver',
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'],
                    required: false,
                    include: [
                        {
                            model: DriverProfile,
                            as: 'driver_profile',
                            attributes: [
                                'vehicle_make_model',
                                'vehicle_color',
                                'vehicle_year',
                                'vehicle_plate',
                                'vehicle_photo_url',
                                'rating_avg',
                                'rating_count'
                            ],
                            required: false
                        }
                    ]
                },
                {
                    model: Rating,
                    as: 'ratings',
                    required: false,
                    attributes: ['id', 'stars', 'comment', 'rated_by', 'rated_user', 'rating_type', 'created_at']
                },
                {
                    model: Payment,
                    as: 'payment',
                    required: false,
                    attributes: ['id', 'tripId', 'method', 'amount', 'status', 'reference', 'createdAt', 'updatedAt']  // ✅ FIXED: No currency, no completedAt
                }
            ]
        });

        console.log(`✅ [RECENT TRIPS] Found ${trips.length} trips`);

        // Format trips for mobile display
        const formattedTrips = trips.map(trip => {
            const tripData = trip.toJSON();

            // Calculate distance and duration
            const distanceKm = tripData.distanceM ? (tripData.distanceM / 1000).toFixed(2) : '0.00';
            const durationMin = tripData.durationS ? Math.ceil(tripData.durationS / 60) : 0;

            // Format date
            const completedDate = tripData.tripCompletedAt
                ? new Date(tripData.tripCompletedAt)
                : tripData.canceledAt
                    ? new Date(tripData.canceledAt)
                    : new Date(tripData.createdAt);

            // Format driver info
            let driverInfo = null;
            if (tripData.driver) {
                driverInfo = {
                    uuid: tripData.driver.uuid,
                    name: `${tripData.driver.first_name} ${tripData.driver.last_name}`,
                    phone: tripData.driver.phone_e164 || null,
                    avatar_url: tripData.driver.avatar_url || null,
                    rating: tripData.driver.driver_profile ? {
                        average: parseFloat(tripData.driver.driver_profile.rating_avg),
                        count: tripData.driver.driver_profile.rating_count
                    } : null,
                    vehicle: tripData.driver.driver_profile ? {
                        make_model: tripData.driver.driver_profile.vehicle_make_model,
                        color: tripData.driver.driver_profile.vehicle_color,
                        year: tripData.driver.driver_profile.vehicle_year,
                        plate: tripData.driver.driver_profile.vehicle_plate,
                        photo_url: tripData.driver.driver_profile.vehicle_photo_url,
                        display: `${tripData.driver.driver_profile.vehicle_color} ${tripData.driver.driver_profile.vehicle_make_model}`
                    } : null
                };
            }

            // Format passenger info
            let passengerInfo = null;
            if (tripData.passenger) {
                passengerInfo = {
                    uuid: tripData.passenger.uuid,
                    name: `${tripData.passenger.first_name} ${tripData.passenger.last_name}`,
                    phone: tripData.passenger.phone_e164 || null,
                    avatar_url: tripData.passenger.avatar_url || null
                };
            }

            // Get rating info (check if user has rated this trip)
            let ratingInfo = null;
            if (tripData.ratings && tripData.ratings.length > 0) {
                const userRating = tripData.ratings.find(r => r.rated_by === userId);
                if (userRating) {
                    ratingInfo = {
                        given: true,
                        rating: userRating.stars,
                        comment: userRating.comment,
                        created_at: userRating.created_at
                    };
                } else {
                    ratingInfo = {
                        given: false,
                        can_rate: tripData.status === 'COMPLETED'
                    };
                }
            } else {
                ratingInfo = {
                    given: false,
                    can_rate: tripData.status === 'COMPLETED'
                };
            }

            // Payment info (using actual Payment model fields)
            let paymentInfo = null;
            if (tripData.payment) {
                paymentInfo = {
                    id: tripData.payment.id,
                    amount: tripData.payment.amount,
                    currency: 'FCFA',  // Default currency (not in DB)
                    method: tripData.payment.method,  // 'cash', 'momo', 'om'
                    status: tripData.payment.status,  // 'pending', 'settled', 'failed'
                    reference: tripData.payment.reference,
                    created_at: tripData.payment.createdAt,
                    updated_at: tripData.payment.updatedAt
                };
            }

            return {
                id: tripData.id,
                status: tripData.status,

                // Route info
                pickup_address: tripData.pickupAddress || 'Pickup location',
                dropoff_address: tripData.dropoffAddress || 'Dropoff location',
                pickup_coordinates: {
                    lat: parseFloat(tripData.pickupLat),
                    lng: parseFloat(tripData.pickupLng)
                },
                dropoff_coordinates: {
                    lat: parseFloat(tripData.dropoffLat),
                    lng: parseFloat(tripData.dropoffLng)
                },

                // Trip metrics
                distance_km: parseFloat(distanceKm),
                duration_minutes: durationMin,
                fare: tripData.fareFinal || tripData.fareEstimate || 0,
                currency: 'FCFA',

                // Participants
                driver: driverInfo,
                passenger: passengerInfo,

                // Payment
                payment: paymentInfo,
                payment_method: tripData.paymentMethod,

                // Rating
                rating: ratingInfo,

                // Timestamps
                created_at: tripData.createdAt,
                completed_at: tripData.tripCompletedAt,
                canceled_at: tripData.canceledAt,
                date: completedDate.toISOString(),
                date_formatted: completedDate.toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric'
                }),
                time_formatted: completedDate.toLocaleTimeString('en-US', {
                    hour: '2-digit',
                    minute: '2-digit'
                }),

                // Cancel info (if applicable)
                cancel_reason: tripData.cancelReason,
                canceled_by: tripData.canceledBy
            };
        });

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(200).json({
            success: true,
            message: 'Recent trips retrieved successfully',
            data: {
                trips: formattedTrips,
                count: formattedTrips.length,
                limit: parseInt(limit)
            }
        });

    } catch (error) {
        console.error('❌ [RECENT TRIPS] Error fetching trips:', error);
        console.error('Stack:', error.stack);

        res.status(500).json({
            success: false,
            message: 'Failed to retrieve recent trips',
            error: error.message
        });
    }
};


/**
 * 📋 GET SINGLE TRIP DETAILS
 */
exports.getTripDetails = async (req, res) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📋 [TRIP DETAILS] Fetching trip details...');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        const { tripId } = req.params;
        const userId = req.user.uuid;

        console.log(`🆔 Trip ID: ${tripId}`);
        console.log(`👤 User: ${userId}`);

        // Fetch trip with all related data
        const trip = await Trip.findOne({
            where: { id: tripId },
            include: [
                {
                    model: Account,
                    as: 'passenger',
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'],
                    required: false
                },
                {
                    model: Account,
                    as: 'driver',
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'],
                    required: false,
                    include: [
                        {
                            model: DriverProfile,
                            as: 'driver_profile',
                            attributes: [
                                'vehicle_make_model',
                                'vehicle_color',
                                'vehicle_year',
                                'vehicle_plate',
                                'vehicle_photo_url',
                                'rating_avg',
                                'rating_count'
                            ],
                            required: false
                        }
                    ]
                },
                {
                    model: Rating,
                    as: 'ratings',
                    required: false,
                    attributes: ['id', 'stars', 'comment', 'rated_by', 'rated_user', 'rating_type', 'created_at']
                },
                {
                    model: Payment,
                    as: 'payment',
                    required: false,
                    attributes: ['id', 'tripId', 'method', 'amount', 'status', 'reference', 'createdAt', 'updatedAt']  // ✅ FIXED
                }
            ]
        });

        if (!trip) {
            console.log('❌ Trip not found');
            return res.status(404).json({
                success: false,
                message: 'Trip not found',
                code: 'TRIP_NOT_FOUND'
            });
        }

        // Verify user has access to this trip
        if (trip.passengerId !== userId && trip.driverId !== userId) {
            console.log('❌ Unauthorized access attempt');
            return res.status(403).json({
                success: false,
                message: 'You do not have access to this trip',
                code: 'UNAUTHORIZED_ACCESS'
            });
        }

        console.log(`✅ Trip found: ${trip.status}`);

        // Use same formatting as recent trips
        const tripData = trip.toJSON();
        const distanceKm = tripData.distanceM ? (tripData.distanceM / 1000).toFixed(2) : '0.00';
        const durationMin = tripData.durationS ? Math.ceil(tripData.durationS / 60) : 0;

        const formattedTrip = {
            id: tripData.id,
            status: tripData.status,
            pickup_address: tripData.pickupAddress,
            dropoff_address: tripData.dropoffAddress,
            pickup_coordinates: {
                lat: parseFloat(tripData.pickupLat),
                lng: parseFloat(tripData.pickupLng)
            },
            dropoff_coordinates: {
                lat: parseFloat(tripData.dropoffLat),
                lng: parseFloat(tripData.dropoffLng)
            },
            route_polyline: tripData.routePolyline,
            distance_km: parseFloat(distanceKm),
            duration_minutes: durationMin,
            fare: tripData.fareFinal || tripData.fareEstimate || 0,
            currency: 'FCFA',
            payment_method: tripData.paymentMethod,
            driver: tripData.driver ? {
                uuid: tripData.driver.uuid,
                name: `${tripData.driver.first_name} ${tripData.driver.last_name}`,
                phone: tripData.driver.phone_e164 || null,
                avatar_url: tripData.driver.avatar_url || null,
                rating: tripData.driver.driver_profile ? {
                    average: parseFloat(tripData.driver.driver_profile.rating_avg),
                    count: tripData.driver.driver_profile.rating_count
                } : null,
                vehicle: tripData.driver.driver_profile ? {
                    make_model: tripData.driver.driver_profile.vehicle_make_model,
                    color: tripData.driver.driver_profile.vehicle_color,
                    year: tripData.driver.driver_profile.vehicle_year,
                    plate: tripData.driver.driver_profile.vehicle_plate,
                    photo_url: tripData.driver.driver_profile.vehicle_photo_url
                } : null
            } : null,
            passenger: tripData.passenger ? {
                uuid: tripData.passenger.uuid,
                name: `${tripData.passenger.first_name} ${tripData.passenger.last_name}`,
                phone: tripData.passenger.phone_e164 || null,
                avatar_url: tripData.passenger.avatar_url || null
            } : null,
            payment: tripData.payment ? {
                id: tripData.payment.id,
                amount: tripData.payment.amount,
                currency: 'FCFA',  // Default
                method: tripData.payment.method,
                status: tripData.payment.status,
                reference: tripData.payment.reference,
                created_at: tripData.payment.createdAt,
                updated_at: tripData.payment.updatedAt
            } : null,
            ratings: tripData.ratings ? tripData.ratings.map(r => ({
                id: r.id,
                stars: r.stars,
                comment: r.comment,
                rated_by: r.rated_by,
                rated_user: r.rated_user,
                rating_type: r.rating_type,
                created_at: r.created_at
            })) : [],
            timestamps: {
                created: tripData.createdAt,
                matched: tripData.matchedAt,
                driver_assigned: tripData.driverAssignedAt,
                driver_en_route: tripData.driverEnRouteAt,
                driver_arrived: tripData.driverArrivedAt,
                started: tripData.tripStartedAt,
                completed: tripData.tripCompletedAt,
                canceled: tripData.canceledAt
            },
            cancel_info: tripData.cancelReason ? {
                reason: tripData.cancelReason,
                canceled_by: tripData.canceledBy,
                canceled_at: tripData.canceledAt
            } : null
        };

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(200).json({
            success: true,
            message: 'Trip details retrieved successfully',
            data: formattedTrip
        });

    } catch (error) {
        console.error('❌ [TRIP DETAILS] Error fetching trip:', error);
        console.error('Stack:', error.stack);

        res.status(500).json({
            success: false,
            message: 'Failed to retrieve trip details',
            error: error.message
        });
    }
};