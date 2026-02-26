// src/controllers/backoffice/passengerController.js
const Account = require('../../models/Account');
const Trip = require('../../models/Trip');
const { Op } = require('sequelize');
const sequelize = require('../../config/database'); // ✅ ADD THIS LINE

/**
 * 🔍 Get all passengers with pagination, search, and filtering
 */
exports.getAllPassengers = async (req, res) => {
    try {
        const {
            page = 1,
            limit = 10,
            search = '',
            status = '',
            sortBy = 'created_at',
            sortOrder = 'DESC'
        } = req.query;

        const offset = (parseInt(page) - 1) * parseInt(limit);

        // Build where clause
        const whereClause = {
            user_type: 'PASSENGER'
        };

        // Add search filter
        if (search) {
            whereClause[Op.or] = [
                { first_name: { [Op.like]: `%${search}%` } },
                { last_name: { [Op.like]: `%${search}%` } },
                { email: { [Op.like]: `%${search}%` } },
                { phone_e164: { [Op.like]: `%${search}%` } }
            ];
        }

        // Add status filter
        if (status) {
            whereClause.status = status;
        }

        // Get passengers with pagination
        const { count, rows: passengers } = await Account.findAndCountAll({
            where: whereClause,
            attributes: [
                'uuid',
                'first_name',
                'last_name',
                'email',
                'phone_e164',
                'phone_verified',
                'email_verified',
                'avatar_url',
                'status',
                'civility',
                'birth_date',
                'created_at',
                'updated_at'
            ],
            order: [[sortBy, sortOrder]],
            limit: parseInt(limit),
            offset: offset
        });

        // Get trip counts for each passenger
        const passengersWithTrips = await Promise.all(
            passengers.map(async (passenger) => {
                const tripCount = await Trip.count({
                    where: { passengerId: passenger.uuid }
                });

                const completedTrips = await Trip.count({
                    where: {
                        passengerId: passenger.uuid,
                        status: 'COMPLETED'
                    }
                });

                return {
                    ...passenger.toJSON(),
                    trip_count: tripCount,
                    completed_trips: completedTrips
                };
            })
        );

        console.log(`✅ Fetched ${passengers.length} passengers`);

        res.status(200).json({
            success: true,
            data: passengersWithTrips,
            pagination: {
                total: count,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(count / parseInt(limit))
            }
        });
    } catch (error) {
        console.error('❌ Error fetching passengers:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch passengers',
            error: error.message
        });
    }
};

/**
 * 🔍 Get single passenger by UUID
 */
exports.getPassengerById = async (req, res) => {
    try {
        const { id } = req.params;

        const passenger = await Account.findOne({
            where: {
                uuid: id,
                user_type: 'PASSENGER'
            },
            attributes: [
                'uuid',
                'first_name',
                'last_name',
                'email',
                'phone_e164',
                'phone_verified',
                'email_verified',
                'avatar_url',
                'status',
                'civility',
                'birth_date',
                'created_at',
                'updated_at'
            ]
        });

        if (!passenger) {
            return res.status(404).json({
                success: false,
                message: 'Passenger not found'
            });
        }

        // Get trip statistics
        const tripStats = await Trip.findAll({
            where: { passengerId: id },
            attributes: [
                [sequelize.fn('COUNT', sequelize.col('id')), 'total_trips'],
                [sequelize.fn('SUM', sequelize.literal("CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END")), 'completed_trips'],
                [sequelize.fn('SUM', sequelize.literal("CASE WHEN status = 'CANCELED' THEN 1 ELSE 0 END")), 'canceled_trips'],
                [sequelize.fn('SUM', sequelize.col('fareFinal')), 'total_spent']
            ],
            raw: true
        });

        console.log(`✅ Fetched passenger: ${passenger.uuid}`);

        res.status(200).json({
            success: true,
            passenger: {
                ...passenger.toJSON(),
                stats: tripStats[0] || {
                    total_trips: 0,
                    completed_trips: 0,
                    canceled_trips: 0,
                    total_spent: 0
                }
            }
        });
    } catch (error) {
        console.error('❌ Error fetching passenger:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch passenger details',
            error: error.message
        });
    }
};

/**
 * 📋 Get passenger trip history
 */
exports.getPassengerTrips = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            page = 1,
            limit = 10,
            status = ''
        } = req.query;

        const offset = (parseInt(page) - 1) * parseInt(limit);

        // Build where clause
        const whereClause = { passengerId: id };
        if (status) {
            whereClause.status = status;
        }

        const { count, rows: trips } = await Trip.findAndCountAll({
            where: whereClause,
            order: [['createdAt', 'DESC']],
            limit: parseInt(limit),
            offset: offset
        });

        console.log(`✅ Fetched ${trips.length} trips for passenger ${id}`);

        res.status(200).json({
            success: true,
            data: trips,
            pagination: {
                total: count,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(count / parseInt(limit))
            }
        });
    } catch (error) {
        console.error('❌ Error fetching passenger trips:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch passenger trips',
            error: error.message
        });
    }
};

/**
 * 🚫 Block passenger
 */
exports.blockPassenger = async (req, res) => {
    try {
        const { id } = req.params;

        const passenger = await Account.findOne({
            where: {
                uuid: id,
                user_type: 'PASSENGER'
            }
        });

        if (!passenger) {
            return res.status(404).json({
                success: false,
                message: 'Passenger not found'
            });
        }

        await passenger.update({ status: 'SUSPENDED' });

        console.log(`🚫 Blocked passenger: ${id}`);

        res.status(200).json({
            success: true,
            message: 'Passenger blocked successfully'
        });
    } catch (error) {
        console.error('❌ Error blocking passenger:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to block passenger',
            error: error.message
        });
    }
};

/**
 * ✅ Unblock passenger
 */
exports.unblockPassenger = async (req, res) => {
    try {
        const { id } = req.params;

        const passenger = await Account.findOne({
            where: {
                uuid: id,
                user_type: 'PASSENGER'
            }
        });

        if (!passenger) {
            return res.status(404).json({
                success: false,
                message: 'Passenger not found'
            });
        }

        await passenger.update({ status: 'ACTIVE' });

        console.log(`✅ Unblocked passenger: ${id}`);

        res.status(200).json({
            success: true,
            message: 'Passenger unblocked successfully'
        });
    } catch (error) {
        console.error('❌ Error unblocking passenger:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to unblock passenger',
            error: error.message
        });
    }
};

/**
 * 🗑️ Delete passenger
 */
exports.deletePassenger = async (req, res) => {
    try {
        const { id } = req.params;

        const passenger = await Account.findOne({
            where: {
                uuid: id,
                user_type: 'PASSENGER'
            }
        });

        if (!passenger) {
            return res.status(404).json({
                success: false,
                message: 'Passenger not found'
            });
        }

        // Soft delete - just update status
        await passenger.update({ status: 'DELETED' });

        console.log(`🗑️ Deleted passenger: ${id}`);

        res.status(200).json({
            success: true,
            message: 'Passenger deleted successfully'
        });
    } catch (error) {
        console.error('❌ Error deleting passenger:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete passenger',
            error: error.message
        });
    }
};

/**
 * 📊 Get passenger statistics
 */
exports.getPassengerStats = async (req, res) => {
    try {
        const totalPassengers = await Account.count({
            where: { user_type: 'PASSENGER' }
        });

        const activePassengers = await Account.count({
            where: {
                user_type: 'PASSENGER',
                status: 'ACTIVE'
            }
        });

        const suspendedPassengers = await Account.count({
            where: {
                user_type: 'PASSENGER',
                status: 'SUSPENDED'
            }
        });

        const verifiedPassengers = await Account.count({
            where: {
                user_type: 'PASSENGER',
                phone_verified: true
            }
        });

        console.log('✅ Fetched passenger statistics');

        res.status(200).json({
            success: true,
            stats: {
                total: totalPassengers,
                active: activePassengers,
                suspended: suspendedPassengers,
                verified: verifiedPassengers
            }
        });
    } catch (error) {
        console.error('❌ Error fetching passenger stats:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch statistics',
            error: error.message
        });
    }
};