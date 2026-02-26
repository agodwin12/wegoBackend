// wegobackend/src/controllers/backoffice/vehicleController.js
const { sequelize } = require('../../models');
const { Vehicle, VehicleCategory, PartnerProfile, Account, Employee } = require('../../models');
const { Op } = require('sequelize');

// ═══════════════════════════════════════════════════════════════════════
// CREATE VEHICLE
// ═══════════════════════════════════════════════════════════════════════

exports.createVehicle = async (req, res) => {
    try {
        const {
            partnerId,
            plate,
            makeModel,
            year,
            color,
            region,
            seats,
            transmission,
            fuelType,
            categoryId,
            availableForRent,
            rentalPricePerHour,
            rentalPricePerDay,
            rentalPricePerWeek,
            rentalPricePerMonth,
            images,
            insuranceDocument,
            insuranceExpiry,
            permitDocument,
            permitExpiry
        } = req.body;

        // ✅ FIX: Use req.user (set by middleware)
        console.log('🔍 Employee object:', {
            id: req.user.id,
            accountId: req.user.accountId,
            fullObject: req.user
        });

        const employeeId = req.user.id; // ✅ FIXED: Changed from req.employee to req.user

        // Validate partner exists
        const partner = await PartnerProfile.findOne({ where: { accountId: partnerId } });
        if (!partner) {
            return res.status(404).json({
                success: false,
                message: 'Partner not found'
            });
        }

        // Check if partner is blocked
        if (partner.isBlocked) {
            return res.status(403).json({
                success: false,
                message: 'Cannot add vehicle for blocked partner'
            });
        }

        // Check if plate already exists
        const existingVehicle = await Vehicle.findByPlate(plate);
        if (existingVehicle) {
            return res.status(400).json({
                success: false,
                message: 'A vehicle with this license plate already exists'
            });
        }

        // Validate category if provided
        if (categoryId) {
            const category = await VehicleCategory.findByPk(categoryId);
            if (!category) {
                return res.status(404).json({
                    success: false,
                    message: 'Vehicle category not found'
                });
            }
        }

        // Create vehicle
        const vehicle = await Vehicle.create({
            partnerId,
            postedByEmployeeId: employeeId, // ✅ Using req.user.id (primary key)
            plate,
            makeModel,
            year,
            color,
            region: region || 'Littoral',
            seats: seats || 4,
            transmission: transmission || 'manual',
            fuelType: fuelType || 'petrol',
            categoryId,
            availableForRent: availableForRent || false,
            rentalPricePerHour,
            rentalPricePerDay,
            rentalPricePerWeek,
            rentalPricePerMonth,
            images: images || [],
            insuranceDocument,
            insuranceExpiry,
            permitDocument,
            permitExpiry
        });

        // Fetch vehicle with associations
        const newVehicle = await Vehicle.findByPk(vehicle.id, {
            include: [
                {
                    model: VehicleCategory,
                    as: 'category',
                    attributes: ['id', 'name', 'slug', 'icon']
                },
                {
                    model: PartnerProfile,
                    as: 'partnerProfile',
                    attributes: ['id', 'partnerName', 'email', 'phone_number']
                },
                {
                    model: Employee,
                    as: 'postedByEmployee',
                    attributes: ['id', 'first_name', 'last_name', 'email']
                }
            ]
        });

        console.log('✅ Vehicle created:', vehicle.id);

        res.status(201).json({
            success: true,
            message: 'Vehicle created successfully',
            data: newVehicle
        });

    } catch (error) {
        console.error('❌ Error creating vehicle:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to create vehicle'
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET ALL VEHICLES (with pagination, search, filters)
// ═══════════════════════════════════════════════════════════════════════

exports.getAllVehicles = async (req, res) => {
    try {
        const {
            page = 1,
            limit = 10,
            search = '',
            partnerId,
            categoryId,
            region,
            availableForRent,
            isVerified,
            isBlocked,
            sortBy = 'createdAt',
            sortOrder = 'DESC'
        } = req.query;

        const offset = (parseInt(page) - 1) * parseInt(limit);

        // Build where clause
        const where = {};

        // Search by plate or make/model
        if (search) {
            where[Op.or] = [
                { plate: { [Op.like]: `%${search}%` } },
                { makeModel: { [Op.like]: `%${search}%` } }
            ];
        }

        // Filter by partner
        if (partnerId) {
            where.partnerId = partnerId;
        }

        // Filter by category
        if (categoryId) {
            where.categoryId = categoryId;
        }

        // Filter by region
        if (region) {
            where.region = region;
        }

        // Filter by availability
        if (availableForRent !== undefined) {
            where.availableForRent = availableForRent === 'true';
        }

        // Filter by verification status
        if (isVerified !== undefined) {
            where.isVerified = isVerified === 'true';
        }

        // Filter by blocked status
        if (isBlocked !== undefined) {
            where.isBlocked = isBlocked === 'true';
        }

        // Get vehicles with pagination
        const { count, rows: vehicles } = await Vehicle.findAndCountAll({
            where,
            include: [
                {
                    model: VehicleCategory,
                    as: 'category',
                    attributes: ['id', 'name', 'slug', 'icon']
                },
                {
                    model: PartnerProfile,
                    as: 'partnerProfile',
                    attributes: ['id', 'partnerName', 'email', 'phone_number', 'profilePhoto']
                },
                {
                    model: Employee,
                    as: 'postedByEmployee',
                    attributes: ['id', 'first_name', 'last_name']
                },
                {
                    model: Employee,
                    as: 'verifiedByEmployee',
                    attributes: ['id', 'first_name', 'last_name']
                }
            ],
            order: [[sortBy, sortOrder.toUpperCase()]],
            limit: parseInt(limit),
            offset
        });

        const totalPages = Math.ceil(count / parseInt(limit));

        res.json({
            success: true,
            data: vehicles,
            pagination: {
                currentPage: parseInt(page),
                totalPages,
                totalItems: count,
                itemsPerPage: parseInt(limit)
            }
        });

    } catch (error) {
        console.error('❌ Error fetching vehicles:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch vehicles'
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET VEHICLE BY ID
// ═══════════════════════════════════════════════════════════════════════

// wegobackend/src/controllers/backoffice/vehicleController.js

// Find the getVehicleById function (around line 267) and update it:

exports.getVehicleById = async (req, res) => {
    try {
        const { id } = req.params;

        const vehicle = await Vehicle.findByPk(id, {
            include: [
                {
                    model: VehicleCategory,
                    as: 'category',
                    attributes: ['id', 'name', 'slug', 'description', 'basePricePerDay', 'icon', 'isActive', 'sortOrder']
                },
                {
                    model: PartnerProfile,
                    as: 'partnerProfile',
                    attributes: [
                        'id', 'accountId', 'partnerName', 'address',
                        'phoneNumber', 'email', 'profilePhoto',
                        'isBlocked', 'blockedAt', 'blockedBy', 'blockedReason',
                        'createdByEmployeeId'
                    ],
                    include: [
                        {
                            model: Account,
                            as: 'account',
                            attributes: ['uuid', 'email']  // ✅ Changed from 'isActive' to 'is_active'
                        }
                    ]
                },
                {
                    model: Employee,
                    as: 'postedByEmployee',
                    attributes: ['id', 'first_name', 'last_name', 'email']
                },
                {
                    model: Employee,
                    as: 'verifiedByEmployee',
                    attributes: ['id', 'first_name', 'last_name', 'email']
                }
            ]
        });

        if (!vehicle) {
            return res.status(404).json({
                success: false,
                message: 'Vehicle not found'
            });
        }

        console.log('✅ Vehicle found:', vehicle.id);

        res.status(200).json({
            success: true,
            data: vehicle
        });

    } catch (error) {
        console.error('❌ Error fetching vehicle:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching vehicle',
            error: error.message
        });
    }
};
// ═══════════════════════════════════════════════════════════════════════
// UPDATE VEHICLE
// ═══════════════════════════════════════════════════════════════════════

exports.updateVehicle = async (req, res) => {
    try {
        const { id } = req.params;
        const updateData = req.body;

        const vehicle = await Vehicle.findByPk(id);
        if (!vehicle) {
            return res.status(404).json({
                success: false,
                message: 'Vehicle not found'
            });
        }

        // Check if plate is being changed and if new plate already exists
        if (updateData.plate && updateData.plate !== vehicle.plate) {
            const existingVehicle = await Vehicle.findByPlate(updateData.plate);
            if (existingVehicle) {
                return res.status(400).json({
                    success: false,
                    message: 'A vehicle with this license plate already exists'
                });
            }
        }

        // Validate category if being changed
        if (updateData.categoryId && updateData.categoryId !== vehicle.categoryId) {
            const category = await VehicleCategory.findByPk(updateData.categoryId);
            if (!category) {
                return res.status(404).json({
                    success: false,
                    message: 'Vehicle category not found'
                });
            }
        }

        // Update vehicle
        await vehicle.update(updateData);

        // Fetch updated vehicle with associations
        const updatedVehicle = await Vehicle.findByPk(id, {
            include: [
                {
                    model: VehicleCategory,
                    as: 'category'
                },
                {
                    model: PartnerProfile,
                    as: 'partnerProfile',
                    attributes: ['id', 'partnerName', 'email', 'phone_number']
                },
                {
                    model: Employee,
                    as: 'postedByEmployee',
                    attributes: ['id', 'first_name', 'last_name']
                }
            ]
        });

        console.log('✅ Vehicle updated:', id);

        res.json({
            success: true,
            message: 'Vehicle updated successfully',
            data: updatedVehicle
        });

    } catch (error) {
        console.error('❌ Error updating vehicle:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to update vehicle'
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// DELETE VEHICLE
// ═══════════════════════════════════════════════════════════════════════

exports.deleteVehicle = async (req, res) => {
    try {
        const { id } = req.params;

        const vehicle = await Vehicle.findByPk(id);
        if (!vehicle) {
            return res.status(404).json({
                success: false,
                message: 'Vehicle not found'
            });
        }

        // TODO: Check if vehicle has active rentals
        // For now, we'll allow deletion

        await vehicle.destroy();

        console.log('✅ Vehicle deleted:', id);

        res.json({
            success: true,
            message: 'Vehicle deleted successfully'
        });

    } catch (error) {
        console.error('❌ Error deleting vehicle:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete vehicle'
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// VERIFY VEHICLE
// ═══════════════════════════════════════════════════════════════════════

exports.verifyVehicle = async (req, res) => {
    try {
        const { id } = req.params;
        const employeeId = req.user.id; // ✅ FIXED: Changed from req.employee to req.user

        const vehicle = await Vehicle.findByPk(id);
        if (!vehicle) {
            return res.status(404).json({
                success: false,
                message: 'Vehicle not found'
            });
        }

        if (vehicle.isVerified) {
            return res.status(400).json({
                success: false,
                message: 'Vehicle is already verified'
            });
        }

        await vehicle.verify(employeeId);

        console.log('✅ Vehicle verified:', id);

        res.json({
            success: true,
            message: 'Vehicle verified successfully',
            data: vehicle
        });

    } catch (error) {
        console.error('❌ Error verifying vehicle:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to verify vehicle'
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// UNVERIFY VEHICLE
// ═══════════════════════════════════════════════════════════════════════

exports.unverifyVehicle = async (req, res) => {
    try {
        const { id } = req.params;

        const vehicle = await Vehicle.findByPk(id);
        if (!vehicle) {
            return res.status(404).json({
                success: false,
                message: 'Vehicle not found'
            });
        }

        if (!vehicle.isVerified) {
            return res.status(400).json({
                success: false,
                message: 'Vehicle is not verified'
            });
        }

        await vehicle.unverify();

        console.log('✅ Vehicle unverified:', id);

        res.json({
            success: true,
            message: 'Vehicle unverified successfully',
            data: vehicle
        });

    } catch (error) {
        console.error('❌ Error unverifying vehicle:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to unverify vehicle'
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// BLOCK VEHICLE
// ═══════════════════════════════════════════════════════════════════════

exports.blockVehicle = async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;

        if (!reason || !reason.trim()) {
            return res.status(400).json({
                success: false,
                message: 'Block reason is required'
            });
        }

        const vehicle = await Vehicle.findByPk(id);
        if (!vehicle) {
            return res.status(404).json({
                success: false,
                message: 'Vehicle not found'
            });
        }

        if (vehicle.isBlocked) {
            return res.status(400).json({
                success: false,
                message: 'Vehicle is already blocked'
            });
        }

        await vehicle.block(reason);

        console.log('✅ Vehicle blocked:', id);

        res.json({
            success: true,
            message: 'Vehicle blocked successfully',
            data: vehicle
        });

    } catch (error) {
        console.error('❌ Error blocking vehicle:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to block vehicle'
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// UNBLOCK VEHICLE
// ═══════════════════════════════════════════════════════════════════════

exports.unblockVehicle = async (req, res) => {
    try {
        const { id } = req.params;

        const vehicle = await Vehicle.findByPk(id);
        if (!vehicle) {
            return res.status(404).json({
                success: false,
                message: 'Vehicle not found'
            });
        }

        if (!vehicle.isBlocked) {
            return res.status(400).json({
                success: false,
                message: 'Vehicle is not blocked'
            });
        }

        await vehicle.unblock();

        console.log('✅ Vehicle unblocked:', id);

        res.json({
            success: true,
            message: 'Vehicle unblocked successfully',
            data: vehicle
        });

    } catch (error) {
        console.error('❌ Error unblocking vehicle:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to unblock vehicle'
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET VEHICLE STATS
// ═══════════════════════════════════════════════════════════════════════

exports.getVehicleStats = async (req, res) => {
    try {
        const total = await Vehicle.count();
        const available = await Vehicle.count({
            where: { availableForRent: true, isBlocked: false }
        });

        const verified = await Vehicle.count({
            where: { isVerified: true }
        });

        const blocked = await Vehicle.count({
            where: { isBlocked: true }
        });

        const unverified = await Vehicle.count({
            where: { isVerified: false }
        });

        // Stats by category
        const byCategory = await Vehicle.findAll({
            attributes: [
                'categoryId',
                [sequelize.fn('COUNT', sequelize.col('Vehicle.id')), 'count']
            ],
            include: [
                {
                    model: VehicleCategory,
                    as: 'category',
                    attributes: ['name', 'slug']
                }
            ],
            group: ['categoryId', 'category.id']
        });

        // Stats by region
        const byRegion = await Vehicle.findAll({
            attributes: [
                'region',
                [sequelize.fn('COUNT', sequelize.col('id')), 'count']
            ],
            group: ['region']
        });

        res.json({
            success: true,
            data: {
                total,
                available,
                verified,
                blocked,
                unverified,
                byCategory,
                byRegion
            }
        });

    } catch (error) {
        console.error('❌ Error fetching vehicle stats:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch vehicle stats'
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET ALL CATEGORIES
// ═══════════════════════════════════════════════════════════════════════

exports.getCategories = async (req, res) => {
    try {
        const categories = await VehicleCategory.getActiveCategories();

        res.json({
            success: true,
            data: categories
        });

    } catch (error) {
        console.error('❌ Error fetching categories:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch categories'
        });
    }
};