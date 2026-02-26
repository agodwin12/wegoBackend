const { Trip, Account, DriverProfile } = require('../../models/index');
const { Op } = require('sequelize');
const sequelize = require('../../config/database');

// @desc    Get trip statistics
exports.getTripStats = async (req, res) => {
    try {
        const totalTrips = await Trip.count();
        const completedTrips = await Trip.count({ where: { status: 'COMPLETED' } });
        const canceledTrips = await Trip.count({ where: { status: 'CANCELED' } });
        const inProgressTrips = await Trip.count({ where: { status: 'IN_PROGRESS' } });
        const searchingTrips = await Trip.count({ where: { status: 'SEARCHING' } });

        // Total revenue from completed trips
        const revenueResult = await Trip.sum('fareFinal', {
            where: {
                status: 'COMPLETED',
                fareFinal: { [Op.not]: null }
            }
        });
        const totalRevenue = revenueResult || 0;

        // Average fare
        const avgFareResult = await Trip.findOne({
            attributes: [
                [sequelize.fn('AVG', sequelize.col('fareFinal')), 'avgFare']
            ],
            where: {
                status: 'COMPLETED',
                fareFinal: { [Op.not]: null }
            },
            raw: true
        });
        const avgFare = avgFareResult?.avgFare || 0;

        // Today's trips
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayTrips = await Trip.count({
            where: {
                createdAt: {
                    [Op.gte]: today
                }
            }
        });

        res.json({
            stats: {
                total: totalTrips,
                completed: completedTrips,
                canceled: canceledTrips,
                in_progress: inProgressTrips,
                searching: searchingTrips,
                today: todayTrips,
                total_revenue: Math.round(totalRevenue),
                avg_fare: Math.round(avgFare)
            }
        });
    } catch (error) {
        console.error('❌ Error fetching trip stats:', error);
        res.status(500).json({ message: 'Server error' });
    }
};

// @desc    Get all trips with filters and pagination
exports.getAllTrips = async (req, res) => {
    try {
        const {
            page = 1,
            limit = 10,
            status,
            payment_method,
            date_from,
            date_to,
            search
        } = req.query;

        const offset = (parseInt(page) - 1) * parseInt(limit);
        const where = {};

        // Status filter
        if (status) {
            where.status = status;
        }

        // Payment method filter
        if (payment_method) {
            where.paymentMethod = payment_method;
        }

        // Date range filter
        if (date_from && date_to) {
            where.createdAt = {
                [Op.between]: [new Date(date_from), new Date(date_to)]
            };
        } else if (date_from) {
            where.createdAt = {
                [Op.gte]: new Date(date_from)
            };
        } else if (date_to) {
            where.createdAt = {
                [Op.lte]: new Date(date_to)
            };
        }

        // Search filter
        if (search) {
            const searchPattern = `%${search}%`;
            where[Op.or] = [
                { pickupAddress: { [Op.like]: searchPattern } },
                { dropoffAddress: { [Op.like]: searchPattern } },
                { '$passenger.first_name$': { [Op.like]: searchPattern } },
                { '$passenger.last_name$': { [Op.like]: searchPattern } },
                { '$passenger.phone_e164$': { [Op.like]: searchPattern } },
                { '$driver.first_name$': { [Op.like]: searchPattern } },
                { '$driver.last_name$': { [Op.like]: searchPattern } },
                { '$driver.phone_e164$': { [Op.like]: searchPattern } }
            ];
        }

        const { count, rows: trips } = await Trip.findAndCountAll({
            where,
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
                            attributes: ['vehicle_make_model', 'vehicle_plate', 'vehicle_color'],
                            required: false
                        }
                    ]
                }
            ],
            order: [['createdAt', 'DESC']],
            limit: parseInt(limit),
            offset: offset,
            distinct: true,
            subQuery: false
        });

        const formattedTrips = trips.map(trip => ({
            id: trip.id,
            status: trip.status,
            passenger: trip.passenger ? {
                uuid: trip.passenger.uuid,
                name: `${trip.passenger.first_name || ''} ${trip.passenger.last_name || ''}`.trim(),
                phone: trip.passenger.phone_e164,
                avatar_url: trip.passenger.avatar_url
            } : null,
            driver: trip.driver ? {
                uuid: trip.driver.uuid,
                name: `${trip.driver.first_name || ''} ${trip.driver.last_name || ''}`.trim(),
                phone: trip.driver.phone_e164,
                avatar_url: trip.driver.avatar_url,
                vehicle: trip.driver.driver_profile ? {
                    make_model: trip.driver.driver_profile.vehicle_make_model,
                    plate: trip.driver.driver_profile.vehicle_plate,
                    color: trip.driver.driver_profile.vehicle_color
                } : null
            } : null,
            pickup_address: trip.pickupAddress,
            dropoff_address: trip.dropoffAddress,
            pickup_lat: trip.pickupLat,
            pickup_lng: trip.pickupLng,
            dropoff_lat: trip.dropoffLat,
            dropoff_lng: trip.dropoffLng,
            distance_m: trip.distanceM,
            duration_s: trip.durationS,
            fare_estimate: trip.fareEstimate,
            fare_final: trip.fareFinal,
            payment_method: trip.paymentMethod,
            cancel_reason: trip.cancelReason,
            canceled_by: trip.canceledBy,
            trip_started_at: trip.tripStartedAt,
            trip_completed_at: trip.tripCompletedAt,
            created_at: trip.createdAt,
            updated_at: trip.updatedAt
        }));

        res.json({
            data: formattedTrips,
            pagination: {
                total: count,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(count / parseInt(limit))
            }
        });
    } catch (error) {
        console.error('❌ Error fetching trips:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({ message: 'Server error' });
    }
};

// @desc    Get single trip details
exports.getTripById = async (req, res) => {
    try {
        const trip = await Trip.findByPk(req.params.id, {
            include: [
                {
                    model: Account,
                    as: 'passenger',
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'email', 'avatar_url', 'phone_verified']
                },
                {
                    model: Account,
                    as: 'driver',
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'email', 'avatar_url', 'phone_verified'],
                    include: [
                        {
                            model: DriverProfile,
                            as: 'driver_profile',
                            attributes: [
                                'vehicle_make_model',
                                'vehicle_plate',
                                'vehicle_color',
                                'vehicle_type',
                                'vehicle_year',
                                'rating_avg',
                                'rating_count'
                            ]
                        }
                    ]
                }
            ]
        });

        if (!trip) {
            return res.status(404).json({ message: 'Trip not found' });
        }

        const formattedTrip = {
            id: trip.id,
            status: trip.status,
            passenger: trip.passenger ? {
                uuid: trip.passenger.uuid,
                first_name: trip.passenger.first_name,
                last_name: trip.passenger.last_name,
                phone: trip.passenger.phone_e164,
                email: trip.passenger.email,
                avatar_url: trip.passenger.avatar_url,
                phone_verified: trip.passenger.phone_verified
            } : null,
            driver: trip.driver ? {
                uuid: trip.driver.uuid,
                first_name: trip.driver.first_name,
                last_name: trip.driver.last_name,
                phone: trip.driver.phone_e164,
                email: trip.driver.email,
                avatar_url: trip.driver.avatar_url,
                phone_verified: trip.driver.phone_verified,
                vehicle: trip.driver.driver_profile ? {
                    make_model: trip.driver.driver_profile.vehicle_make_model,
                    plate: trip.driver.driver_profile.vehicle_plate,
                    color: trip.driver.driver_profile.vehicle_color,
                    type: trip.driver.driver_profile.vehicle_type,
                    year: trip.driver.driver_profile.vehicle_year,
                    rating_avg: trip.driver.driver_profile.rating_avg,
                    rating_count: trip.driver.driver_profile.rating_count
                } : null
            } : null,
            pickup_address: trip.pickupAddress,
            dropoff_address: trip.dropoffAddress,
            pickup_lat: trip.pickupLat,
            pickup_lng: trip.pickupLng,
            dropoff_lat: trip.dropoffLat,
            dropoff_lng: trip.dropoffLng,
            distance_m: trip.distanceM,
            duration_s: trip.durationS,
            fare_estimate: trip.fareEstimate,
            fare_final: trip.fareFinal,
            payment_method: trip.paymentMethod,
            cancel_reason: trip.cancelReason,
            canceled_by: trip.canceledBy,
            driver_assigned_at: trip.driverAssignedAt,
            driver_en_route_at: trip.driverEnRouteAt,
            driver_arrived_at: trip.driverArrivedAt,
            trip_started_at: trip.tripStartedAt,
            trip_completed_at: trip.tripCompletedAt,
            matched_at: trip.matchedAt,
            canceled_at: trip.canceledAt,
            driver_location_lat: trip.driverLocationLat,
            driver_location_lng: trip.driverLocationLng,
            route_polyline: trip.routePolyline,
            created_at: trip.createdAt,
            updated_at: trip.updatedAt
        };

        res.json({ trip: formattedTrip });
    } catch (error) {
        console.error('❌ Error fetching trip:', error);
        res.status(500).json({ message: 'Server error' });
    }
};