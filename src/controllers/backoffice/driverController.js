// src/controllers/backoffice/driverController.js
const Account = require('../../models/Account');
const DriverProfile = require('../../models/DriverProfile');
const Trip = require('../../models/Trip');
const { Op } = require('sequelize');
const sequelize = require('../../config/database');

/**
 * 🔍 Get all drivers with pagination, search, and filtering
 */
exports.getAllDrivers = async (req, res) => {
    try {
        const {
            page = 1,
            limit = 10,
            search = '',
            status = '',
            verification_state = '',
            sortBy = 'created_at',
            sortOrder = 'DESC'
        } = req.query;

        const offset = (parseInt(page) - 1) * parseInt(limit);

        // Build where clause for Account
        const accountWhere = {
            user_type: 'DRIVER'
        };

        // Add search filter
        if (search) {
            accountWhere[Op.or] = [
                { first_name: { [Op.like]: `%${search}%` } },
                { last_name: { [Op.like]: `%${search}%` } },
                { email: { [Op.like]: `%${search}%` } },
                { phone_e164: { [Op.like]: `%${search}%` } }
            ];
        }

        // Add status filter
        if (status) {
            accountWhere.status = status;
        }

        // Build where clause for DriverProfile
        const profileWhere = {};
        if (verification_state) {
            profileWhere.verification_state = verification_state;
        }

        // Get drivers with pagination
        const { count, rows: drivers } = await Account.findAndCountAll({
            where: accountWhere,
            include: [
                {
                    model: DriverProfile,
                    as: 'driver_profile',
                    where: Object.keys(profileWhere).length > 0 ? profileWhere : undefined,
                    required: true,
                    attributes: [
                        'verification_state',
                        'rating_avg',
                        'rating_count',
                        'vehicle_make_model',
                        'vehicle_plate',
                        'vehicle_color',
                        'status',
                        'license_number',
                        'vehicle_photo_url'
                    ]
                }
            ],
            order: [[sortBy, sortOrder]],
            limit: parseInt(limit),
            offset: offset
        });

        // Get trip counts for each driver
        const driversWithStats = await Promise.all(
            drivers.map(async (driver) => {
                const tripCount = await Trip.count({
                    where: { driverId: driver.uuid }
                });

                const completedTrips = await Trip.count({
                    where: {
                        driverId: driver.uuid,
                        status: 'COMPLETED'
                    }
                });

                const driverData = driver.toJSON();

                return {
                    uuid: driverData.uuid,
                    first_name: driverData.first_name,
                    last_name: driverData.last_name,
                    email: driverData.email,
                    phone_e164: driverData.phone_e164,
                    phone_verified: driverData.phone_verified,
                    email_verified: driverData.email_verified,
                    avatar_url: driverData.avatar_url,
                    status: driverData.status,
                    created_at: driverData.created_at,
                    updated_at: driverData.updated_at,
                    verification_state: driverData.driver_profile.verification_state,
                    rating_avg: driverData.driver_profile.rating_avg,
                    rating_count: driverData.driver_profile.rating_count,
                    vehicle_make_model: driverData.driver_profile.vehicle_make_model,
                    vehicle_plate: driverData.driver_profile.vehicle_plate,
                    vehicle_color: driverData.driver_profile.vehicle_color,
                    driver_status: driverData.driver_profile.status,
                    trip_count: tripCount,
                    completed_trips: completedTrips
                };
            })
        );

        console.log(`✅ Fetched ${drivers.length} drivers`);

        res.status(200).json({
            success: true,
            data: driversWithStats,
            pagination: {
                total: count,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(count / parseInt(limit))
            }
        });
    } catch (error) {
        console.error('❌ Error fetching drivers:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch drivers',
            error: error.message
        });
    }
};

/**
 * 🔍 Get single driver by UUID with complete profile
 */
exports.getDriverById = async (req, res) => {
    try {
        const { id } = req.params;

        const driver = await Account.findOne({
            where: {
                uuid: id,
                user_type: 'DRIVER'
            },
            include: [
                {
                    model: DriverProfile,
                    as: 'driver_profile',
                    required: true
                }
            ]
        });

        if (!driver) {
            return res.status(404).json({
                success: false,
                message: 'Driver not found'
            });
        }

        // Get trip statistics
        const tripStats = await Trip.findAll({
            where: { driverId: id },
            attributes: [
                [sequelize.fn('COUNT', sequelize.col('id')), 'total_trips'],
                [sequelize.fn('SUM', sequelize.literal("CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END")), 'completed_trips'],
                [sequelize.fn('SUM', sequelize.literal("CASE WHEN status = 'CANCELED' THEN 1 ELSE 0 END")), 'canceled_trips'],
                [sequelize.fn('SUM', sequelize.col('fareFinal')), 'total_earned']
            ],
            raw: true
        });

        const driverData = driver.toJSON();
        const profileData = driverData.driver_profile;

        console.log(`✅ Fetched driver: ${driver.uuid}`);

        res.status(200).json({
            success: true,
            driver: {
                // Account info
                uuid: driverData.uuid,
                first_name: driverData.first_name,
                last_name: driverData.last_name,
                email: driverData.email,
                phone_e164: driverData.phone_e164,
                phone_verified: driverData.phone_verified,
                email_verified: driverData.email_verified,
                avatar_url: driverData.avatar_url,
                status: driverData.status,
                civility: driverData.civility,
                birth_date: driverData.birth_date,
                created_at: driverData.created_at,
                updated_at: driverData.updated_at,

                // Driver profile
                profile: {
                    // Identity & Documents
                    cni_number: profileData.cni_number,
                    license_number: profileData.license_number,
                    license_expiry: profileData.license_expiry,
                    license_document_url: profileData.license_document_url,
                    insurance_number: profileData.insurance_number,
                    insurance_expiry: profileData.insurance_expiry,
                    insurance_document_url: profileData.insurance_document_url,
                    verification_state: profileData.verification_state,

                    // Vehicle info
                    vehicle_type: profileData.vehicle_type,
                    vehicle_make_model: profileData.vehicle_make_model,
                    vehicle_color: profileData.vehicle_color,
                    vehicle_year: profileData.vehicle_year,
                    vehicle_plate: profileData.vehicle_plate,
                    vehicle_photo_url: profileData.vehicle_photo_url,

                    // Status & ratings
                    driver_status: profileData.status,
                    rating_avg: profileData.rating_avg,
                    rating_count: profileData.rating_count,
                    current_lat: profileData.current_lat,
                    current_lng: profileData.current_lng
                },

                // Trip statistics
                stats: tripStats[0] || {
                    total_trips: 0,
                    completed_trips: 0,
                    canceled_trips: 0,
                    total_earned: 0
                }
            }
        });
    } catch (error) {
        console.error('❌ Error fetching driver:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch driver details',
            error: error.message
        });
    }
};

/**
 * 📋 Get driver trip history
 */
exports.getDriverTrips = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            page = 1,
            limit = 10,
            status = ''
        } = req.query;

        const offset = (parseInt(page) - 1) * parseInt(limit);

        // Build where clause
        const whereClause = { driverId: id };
        if (status) {
            whereClause.status = status;
        }

        const { count, rows: trips } = await Trip.findAndCountAll({
            where: whereClause,
            order: [['createdAt', 'DESC']],
            limit: parseInt(limit),
            offset: offset
        });

        console.log(`✅ Fetched ${trips.length} trips for driver ${id}`);

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
        console.error('❌ Error fetching driver trips:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch driver trips',
            error: error.message
        });
    }
};

/**
 * ✅ Approve/Activate driver (PENDING → ACTIVE)
 */
exports.approveDriver = async (req, res) => {
    try {
        const { id } = req.params;

        const driver = await Account.findOne({
            where: {
                uuid: id,
                user_type: 'DRIVER'
            },
            include: [
                {
                    model: DriverProfile,
                    as: 'driver_profile',
                    required: true
                }
            ]
        });

        if (!driver) {
            return res.status(404).json({
                success: false,
                message: 'Driver not found'
            });
        }

        // Update account status to ACTIVE
        await driver.update({ status: 'ACTIVE' });

        // Update verification state to VERIFIED
        await driver.driver_profile.update({ verification_state: 'VERIFIED' });

        console.log(`✅ Approved driver: ${id}`);

        res.status(200).json({
            success: true,
            message: 'Driver approved and activated successfully'
        });
    } catch (error) {
        console.error('❌ Error approving driver:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to approve driver',
            error: error.message
        });
    }
};

/**
 * ❌ Reject driver verification
 */
exports.rejectDriver = async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;

        const driver = await Account.findOne({
            where: {
                uuid: id,
                user_type: 'DRIVER'
            },
            include: [
                {
                    model: DriverProfile,
                    as: 'driver_profile',
                    required: true
                }
            ]
        });

        if (!driver) {
            return res.status(404).json({
                success: false,
                message: 'Driver not found'
            });
        }

        // Update verification state to REJECTED
        await driver.driver_profile.update({
            verification_state: 'REJECTED'
        });

        console.log(`❌ Rejected driver: ${id}`);
        console.log(`   Reason: ${reason || 'Not provided'}`);

        res.status(200).json({
            success: true,
            message: 'Driver verification rejected'
        });
    } catch (error) {
        console.error('❌ Error rejecting driver:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to reject driver',
            error: error.message
        });
    }
};

/**
 * 🚫 Block driver (suspend account)
 */
exports.blockDriver = async (req, res) => {
    try {
        const { id } = req.params;

        const driver = await Account.findOne({
            where: {
                uuid: id,
                user_type: 'DRIVER'
            }
        });

        if (!driver) {
            return res.status(404).json({
                success: false,
                message: 'Driver not found'
            });
        }

        await driver.update({ status: 'SUSPENDED' });

        console.log(`🚫 Blocked driver: ${id}`);

        res.status(200).json({
            success: true,
            message: 'Driver blocked successfully'
        });
    } catch (error) {
        console.error('❌ Error blocking driver:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to block driver',
            error: error.message
        });
    }
};

/**
 * ✅ Unblock driver
 */
exports.unblockDriver = async (req, res) => {
    try {
        const { id } = req.params;

        const driver = await Account.findOne({
            where: {
                uuid: id,
                user_type: 'DRIVER'
            }
        });

        if (!driver) {
            return res.status(404).json({
                success: false,
                message: 'Driver not found'
            });
        }

        await driver.update({ status: 'ACTIVE' });

        console.log(`✅ Unblocked driver: ${id}`);

        res.status(200).json({
            success: true,
            message: 'Driver unblocked successfully'
        });
    } catch (error) {
        console.error('❌ Error unblocking driver:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to unblock driver',
            error: error.message
        });
    }
};

/**
 * 🗑️ Delete driver
 */
exports.deleteDriver = async (req, res) => {
    try {
        const { id } = req.params;

        const driver = await Account.findOne({
            where: {
                uuid: id,
                user_type: 'DRIVER'
            }
        });

        if (!driver) {
            return res.status(404).json({
                success: false,
                message: 'Driver not found'
            });
        }

        // Soft delete
        await driver.update({ status: 'DELETED' });

        console.log(`🗑️ Deleted driver: ${id}`);

        res.status(200).json({
            success: true,
            message: 'Driver deleted successfully'
        });
    } catch (error) {
        console.error('❌ Error deleting driver:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete driver',
            error: error.message
        });
    }
};

/**
 * 📊 Get driver statistics
 */
exports.getDriverStats = async (req, res) => {
    try {
        const totalDrivers = await Account.count({
            where: { user_type: 'DRIVER' }
        });

        const activeDrivers = await Account.count({
            where: {
                user_type: 'DRIVER',
                status: 'ACTIVE'
            }
        });

        const pendingDrivers = await Account.count({
            where: {
                user_type: 'DRIVER',
                status: 'PENDING'
            }
        });

        const suspendedDrivers = await Account.count({
            where: {
                user_type: 'DRIVER',
                status: 'SUSPENDED'
            }
        });

        const verifiedDrivers = await DriverProfile.count({
            where: { verification_state: 'VERIFIED' }
        });

        const onlineDrivers = await DriverProfile.count({
            where: { status: 'online' }
        });

        console.log('✅ Fetched driver statistics');

        res.status(200).json({
            success: true,
            stats: {
                total: totalDrivers,
                active: activeDrivers,
                pending: pendingDrivers,
                suspended: suspendedDrivers,
                verified: verifiedDrivers,
                online: onlineDrivers
            }
        });
    } catch (error) {
        console.error('❌ Error fetching driver stats:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch statistics',
            error: error.message
        });
    }
};