// wegobackend/src/controllers/backoffice/partnerController.js

const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const { Account, PartnerProfile, Vehicle, Employee, VehicleRental, PassengerProfile } = require('../../models');
const { Op } = require('sequelize');
const sequelize = require('../../config/database');

/**
 * 🎯 CREATE PARTNER
 */
exports.createPartner = async (req, res) => {
    const transaction = await sequelize.transaction();

    try {
        const {
            partnerName,
            address,
            phoneNumber,
            email,
            password,
            profilePhoto
        } = req.body;

        const employeeId = req.user?.id;

        console.log('🆕 Creating partner:', { partnerName, email, employeeId });

        if (!partnerName || !phoneNumber || !email || !password) {
            await transaction.rollback();
            return res.status(400).json({
                success: false,
                message: 'Partner name, phone number, email, and password are required'
            });
        }

        const existingAccount = await Account.findOne({
            where: { email: email.toLowerCase() }
        });

        if (existingAccount) {
            await transaction.rollback();
            return res.status(409).json({
                success: false,
                message: 'Email already exists'
            });
        }

        const existingPhone = await PartnerProfile.findOne({
            where: { phoneNumber }
        });

        if (existingPhone) {
            await transaction.rollback();
            return res.status(409).json({
                success: false,
                message: 'Phone number already exists'
            });
        }

        const accountUuid = uuidv4();
        const hashedPassword = await bcrypt.hash(password, 10);

        await Account.create({
            uuid: accountUuid,
            email: email.toLowerCase(),
            password_hash: hashedPassword,
            user_type: 'PARTNER',
            phone_verified: true,
            status: 'ACTIVE'
        }, { transaction });

        console.log('✅ Account created:', accountUuid);

        const partnerProfile = await PartnerProfile.create({
            id: uuidv4(),
            accountId: accountUuid,
            partnerName: partnerName.trim(),
            address: address?.trim() || null,
            phoneNumber: phoneNumber.trim(),
            email: email.toLowerCase(),
            profilePhoto: profilePhoto || null,
            isBlocked: false,
            createdByEmployeeId: null
        }, { transaction });

        console.log('✅ Partner profile created:', partnerProfile.id);

        await transaction.commit();

        const completePartner = await PartnerProfile.findByPk(partnerProfile.id, {
            include: [
                {
                    model: Account,
                    as: 'account',
                    attributes: ['uuid', 'email', 'user_type', 'status', 'createdAt']
                }
            ]
        });

        return res.status(201).json({
            success: true,
            message: 'Partner created successfully',
            data: completePartner
        });

    } catch (error) {
        if (!transaction.finished) {
            await transaction.rollback();
        }
        console.error('❌ Error creating partner:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to create partner',
            error: error.message
        });
    }
};

/**
 * 📋 GET ALL PARTNERS
 */
exports.getAllPartners = async (req, res) => {
    try {
        const {
            page = 1,
            limit = 10,
            search = '',
            isBlocked = '',
            sortBy = 'createdAt',
            sortOrder = 'DESC'
        } = req.query;

        const offset = (parseInt(page) - 1) * parseInt(limit);

        console.log('📋 Fetching partners:', { page, limit, search, isBlocked });

        const whereClause = {};

        if (search) {
            whereClause[Op.or] = [
                { partnerName: { [Op.like]: `%${search}%` } },
                { email: { [Op.like]: `%${search}%` } },
                { phoneNumber: { [Op.like]: `%${search}%` } }
            ];
        }

        if (isBlocked !== '') {
            whereClause.isBlocked = isBlocked === 'true';
        }

        const { count, rows: partners } = await PartnerProfile.findAndCountAll({
            where: whereClause,
            limit: parseInt(limit),
            offset: offset,
            order: [[sortBy, sortOrder.toUpperCase()]],
            include: [
                {
                    model: Account,
                    as: 'account',
                    attributes: ['uuid', 'email', 'user_type', 'status', 'createdAt']
                },
                {
                    model: Vehicle,
                    as: 'vehicles',
                    attributes: ['id', 'plate', 'makeModel', 'availableForRent'],
                    required: false
                }
            ],
            distinct: true
        });

        return res.status(200).json({
            success: true,
            data: partners,
            pagination: {
                total: count,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(count / parseInt(limit))
            }
        });

    } catch (error) {
        console.error('❌ Error fetching partners:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch partners',
            error: error.message
        });
    }
};

/**
 * 🔍 GET SINGLE PARTNER BY ID
 */
exports.getPartnerById = async (req, res) => {
    try {
        const { id } = req.params;

        console.log('🔍 Fetching partner:', id);

        const partner = await PartnerProfile.findByPk(id, {
            include: [
                {
                    model: Account,
                    as: 'account',
                    attributes: ['uuid', 'email', 'user_type', 'status', 'createdAt', 'updatedAt']
                },
                {
                    model: Vehicle,
                    as: 'vehicles',
                    include: [
                        {
                            association: 'category',
                            attributes: ['id', 'name', 'slug']
                        }
                    ]
                }
            ]
        });

        if (!partner) {
            return res.status(404).json({
                success: false,
                message: 'Partner not found'
            });
        }

        const vehicleStats = {
            total: partner.vehicles?.length || 0,
            availableForRent: partner.vehicles?.filter(v => v.availableForRent).length || 0,
            unavailable: partner.vehicles?.filter(v => !v.availableForRent).length || 0
        };

        return res.status(200).json({
            success: true,
            data: {
                ...partner.toJSON(),
                vehicleStats
            }
        });

    } catch (error) {
        console.error('❌ Error fetching partner:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch partner',
            error: error.message
        });
    }
};

/**
 * ✏️ UPDATE PARTNER
 */
exports.updatePartner = async (req, res) => {
    const transaction = await sequelize.transaction();

    try {
        const { id } = req.params;
        const {
            partnerName,
            address,
            phoneNumber,
            email,
            profilePhoto
        } = req.body;

        console.log('✏️ Updating partner:', id);

        const partner = await PartnerProfile.findByPk(id, {
            include: [{ model: Account, as: 'account' }],
            transaction
        });

        if (!partner) {
            await transaction.rollback();
            return res.status(404).json({
                success: false,
                message: 'Partner not found'
            });
        }

        if (email && email.toLowerCase() !== partner.email) {
            const existingEmail = await PartnerProfile.findOne({
                where: {
                    email: email.toLowerCase(),
                    id: { [Op.ne]: id }
                },
                transaction
            });

            if (existingEmail) {
                await transaction.rollback();
                return res.status(409).json({
                    success: false,
                    message: 'Email already exists'
                });
            }

            await Account.update(
                { email: email.toLowerCase() },
                {
                    where: { uuid: partner.accountId },
                    transaction
                }
            );
        }

        if (phoneNumber && phoneNumber !== partner.phoneNumber) {
            const existingPhone = await PartnerProfile.findOne({
                where: {
                    phoneNumber: phoneNumber,
                    id: { [Op.ne]: id }
                },
                transaction
            });

            if (existingPhone) {
                await transaction.rollback();
                return res.status(409).json({
                    success: false,
                    message: 'Phone number already exists'
                });
            }
        }

        await partner.update({
            partnerName: partnerName?.trim() || partner.partnerName,
            address: address?.trim() || partner.address,
            phoneNumber: phoneNumber?.trim() || partner.phoneNumber,
            email: email?.toLowerCase() || partner.email,
            profilePhoto: profilePhoto !== undefined ? profilePhoto : partner.profilePhoto
        }, { transaction });

        await transaction.commit();

        console.log('✅ Partner updated successfully');

        const updatedPartner = await PartnerProfile.findByPk(id, {
            include: [
                {
                    model: Account,
                    as: 'account',
                    attributes: ['uuid', 'email', 'user_type', 'status']
                }
            ]
        });

        return res.status(200).json({
            success: true,
            message: 'Partner updated successfully',
            data: updatedPartner
        });

    } catch (error) {
        if (!transaction.finished) {
            await transaction.rollback();
        }
        console.error('❌ Error updating partner:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to update partner',
            error: error.message
        });
    }
};

/**
 * 🗑️ DELETE PARTNER
 */
exports.deletePartner = async (req, res) => {
    const transaction = await sequelize.transaction();

    try {
        const { id } = req.params;

        console.log('🗑️ Deleting partner:', id);

        const partner = await PartnerProfile.findByPk(id, {
            include: [{ model: Vehicle, as: 'vehicles' }],
            transaction
        });

        if (!partner) {
            await transaction.rollback();
            return res.status(404).json({
                success: false,
                message: 'Partner not found'
            });
        }

        if (partner.vehicles && partner.vehicles.length > 0) {
            await transaction.rollback();
            return res.status(400).json({
                success: false,
                message: 'Cannot delete partner with existing vehicles. Please remove or reassign vehicles first.',
                vehicleCount: partner.vehicles.length
            });
        }

        await partner.destroy({ transaction });

        await Account.destroy({
            where: { uuid: partner.accountId },
            transaction
        });

        await transaction.commit();

        console.log('✅ Partner deleted successfully');

        return res.status(200).json({
            success: true,
            message: 'Partner deleted successfully'
        });

    } catch (error) {
        if (!transaction.finished) {
            await transaction.rollback();
        }
        console.error('❌ Error deleting partner:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to delete partner',
            error: error.message
        });
    }
};

/**
 * 🚫 BLOCK PARTNER
 */
exports.blockPartner = async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;

        console.log('🚫 Blocking partner:', { id, reason });

        const partner = await PartnerProfile.findByPk(id);

        if (!partner) {
            return res.status(404).json({
                success: false,
                message: 'Partner not found'
            });
        }

        if (partner.isBlocked) {
            return res.status(400).json({
                success: false,
                message: 'Partner is already blocked'
            });
        }

        await partner.update({
            isBlocked: true,
            blockedBy: null,
            blockReason: reason || null,
            blockedAt: new Date()
        });

        await Account.update(
            { status: 'SUSPENDED' },
            { where: { uuid: partner.accountId } }
        );

        console.log('✅ Partner blocked successfully');

        const blockedPartner = await PartnerProfile.findByPk(id, {
            include: [
                {
                    model: Account,
                    as: 'account',
                    attributes: ['uuid', 'email', 'user_type', 'status']
                }
            ]
        });

        return res.status(200).json({
            success: true,
            message: 'Partner blocked successfully',
            data: blockedPartner
        });

    } catch (error) {
        console.error('❌ Error blocking partner:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to block partner',
            error: error.message
        });
    }
};

/**
 * ✅ UNBLOCK PARTNER
 */
exports.unblockPartner = async (req, res) => {
    try {
        const { id } = req.params;

        console.log('✅ Unblocking partner:', id);

        const partner = await PartnerProfile.findByPk(id);

        if (!partner) {
            return res.status(404).json({
                success: false,
                message: 'Partner not found'
            });
        }

        if (!partner.isBlocked) {
            return res.status(400).json({
                success: false,
                message: 'Partner is not blocked'
            });
        }

        await partner.update({
            isBlocked: false,
            blockedBy: null,
            blockReason: null,
            blockedAt: null
        });

        await Account.update(
            { status: 'ACTIVE' },
            { where: { uuid: partner.accountId } }
        );

        console.log('✅ Partner unblocked successfully');

        const unblockedPartner = await PartnerProfile.findByPk(id, {
            include: [
                {
                    model: Account,
                    as: 'account',
                    attributes: ['uuid', 'email', 'user_type', 'status']
                }
            ]
        });

        return res.status(200).json({
            success: true,
            message: 'Partner unblocked successfully',
            data: unblockedPartner
        });

    } catch (error) {
        console.error('❌ Error unblocking partner:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to unblock partner',
            error: error.message
        });
    }
};

/**
 * 📊 GET PARTNER STATISTICS
 */
exports.getPartnerStats = async (req, res) => {
    try {
        console.log('📊 Fetching partner statistics');

        const [totalPartners, activePartners, blockedPartners] = await Promise.all([
            PartnerProfile.count(),
            PartnerProfile.count({ where: { isBlocked: false } }),
            PartnerProfile.count({ where: { isBlocked: true } })
        ]);

        return res.status(200).json({
            success: true,
            data: {
                total: totalPartners,
                active: activePartners,
                blocked: blockedPartners
            }
        });

    } catch (error) {
        console.error('❌ Error fetching partner stats:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch partner statistics',
            error: error.message
        });
    }
};

/**
 * 📋 GET PARTNER RENTALS
 */
exports.getPartnerRentals = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            page = 1,
            limit = 50,
            status = '',
            paymentStatus = '',
            sortBy = 'createdAt',
            sortOrder = 'DESC'
        } = req.query;

        const offset = (parseInt(page) - 1) * parseInt(limit);

        console.log('📊 Fetching rentals for partner:', id);

        const partner = await PartnerProfile.findByPk(id);

        if (!partner) {
            return res.status(404).json({
                success: false,
                message: 'Partner not found'
            });
        }

        const partnerVehicles = await Vehicle.findAll({
            where: { partnerId: partner.accountId },
            attributes: ['id']
        });

        const vehicleIds = partnerVehicles.map(v => v.id);

        if (vehicleIds.length === 0) {
            return res.status(200).json({
                success: true,
                data: [],
                pagination: {
                    total: 0,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    totalPages: 0
                },
                stats: {
                    totalRentals: 0,
                    totalRevenue: 0,
                    paidRentals: 0,
                    unpaidRentals: 0,
                    activeRentals: 0,
                    completedRentals: 0
                }
            });
        }

        const whereClause = {
            vehicleId: { [Op.in]: vehicleIds }
        };

        if (status) {
            whereClause.status = status;
        }

        if (paymentStatus) {
            whereClause.paymentStatus = paymentStatus;
        }

        const { count, rows: rentals } = await VehicleRental.findAndCountAll({
            where: whereClause,
            limit: parseInt(limit),
            offset: offset,
            order: [[sortBy, sortOrder.toUpperCase()]],
            include: [
                {
                    model: Vehicle,
                    as: 'vehicle',
                    attributes: ['id', 'plate', 'makeModel', 'color', 'seats'],
                    include: [
                        {
                            association: 'category',
                            attributes: ['id', 'name', 'slug']
                        }
                    ]
                },
                {
                    model: Account,
                    as: 'user',
                    attributes: ['uuid', 'email'],
                    include: [
                        {
                            model: PassengerProfile,
                            as: 'passengerProfile',
                            attributes: ['firstName', 'lastName', 'phoneE164']
                        }
                    ]
                }
            ],
            distinct: true
        });

        const allRentals = await VehicleRental.findAll({
            where: { vehicleId: { [Op.in]: vehicleIds } },
            attributes: ['id', 'status', 'paymentStatus', 'totalPrice']
        });

        const stats = {
            totalRentals: allRentals.length,
            totalRevenue: allRentals
                .filter(r => r.paymentStatus === 'paid')
                .reduce((sum, r) => sum + parseFloat(r.totalPrice || 0), 0),
            paidRentals: allRentals.filter(r => r.paymentStatus === 'paid').length,
            unpaidRentals: allRentals.filter(r => r.paymentStatus === 'unpaid').length,
            refundedRentals: allRentals.filter(r => r.paymentStatus === 'refunded').length,
            activeRentals: allRentals.filter(r => r.status === 'CONFIRMED').length,
            completedRentals: allRentals.filter(r => r.status === 'COMPLETED').length,
            cancelledRentals: allRentals.filter(r => r.status === 'CANCELLED').length,
            pendingRentals: allRentals.filter(r => r.status === 'PENDING').length
        };

        console.log('✅ Found rentals:', count, 'Stats:', stats);

        const formattedRentals = rentals.map(rental => {
            const user = rental.user;
            const passengerProfile = user?.passengerProfile;

            return {
                id: rental.id,
                rentalType: rental.rentalType,
                startDate: rental.startDate,
                endDate: rental.endDate,
                status: rental.status,
                totalPrice: rental.totalPrice,
                paymentStatus: rental.paymentStatus,
                createdAt: rental.createdAt,
                updatedAt: rental.updatedAt,
                vehicle: rental.vehicle,
                user: {
                    uuid: user?.uuid,
                    email: user?.email,
                    firstName: passengerProfile?.firstName,
                    lastName: passengerProfile?.lastName,
                    phoneNumber: passengerProfile?.phoneE164
                }
            };
        });

        return res.status(200).json({
            success: true,
            data: formattedRentals,
            pagination: {
                total: count,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(count / parseInt(limit))
            },
            stats
        });

    } catch (error) {
        console.error('❌ Error fetching partner rentals:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch partner rentals',
            error: error.message
        });
    }
};