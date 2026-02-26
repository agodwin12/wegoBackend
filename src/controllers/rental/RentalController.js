// src/controllers/rental/RentalController.js
const { Vehicle, VehicleRental, Account, VehicleCategory, Employee, PassengerProfile } = require('../../models');
const { v4: uuidv4 } = require('uuid');
const Joi = require('joi');
const { Op } = require('sequelize');
const dayjs = require('dayjs');
const { getFileUrl } = require('../../middleware/upload');

/**
 * =====================================================
 * VALIDATION SCHEMAS
 * =====================================================
 */

const vehicleSchema = Joi.object({
    partnerId: Joi.string().uuid().required(),
    plate: Joi.string().max(24).required(),
    makeModel: Joi.string().max(64).allow(null, ''),
    color: Joi.string().max(32).allow(null, ''),
    region: Joi.string().max(64).required(),
    seats: Joi.number().integer().min(1).max(12).default(4),
    rentalPricePerHour: Joi.number().min(0).allow(null),
    rentalPricePerDay: Joi.number().min(0).allow(null),
    rentalPricePerWeek: Joi.number().min(0).allow(null),
    rentalPricePerMonth: Joi.number().min(0).allow(null),
    categoryId: Joi.string().uuid().allow(null)
});

const createRentalSchema = Joi.object({
    userId: Joi.string().uuid().required(),
    vehicleId: Joi.string().uuid().required(),
    rentalRegion: Joi.string().max(64).required(),
    rentalType: Joi.string().valid('HOUR', 'DAY', 'WEEK', 'MONTH').required(),
    startDate: Joi.date().iso().required(),
    endDate: Joi.date().iso().greater(Joi.ref('startDate')).required(),
    userNotes: Joi.string().max(500).allow(null, '')
});

const calculatePriceSchema = Joi.object({
    vehicleId: Joi.string().uuid().required(),
    rentalType: Joi.string().valid('HOUR', 'DAY', 'WEEK', 'MONTH').required(),
    startDate: Joi.date().iso().required(),
    endDate: Joi.date().iso().greater(Joi.ref('startDate')).required()
});

const updatePaymentSchema = Joi.object({
    paymentMethod: Joi.string().valid('orange_money', 'mtn_momo', 'cash').required(),
    transactionRef: Joi.string().max(100).allow(null, '')
});

const cancelRentalSchema = Joi.object({
    reason: Joi.string().min(10).max(500).required()
});

/**
 * =====================================================
 * HELPER FUNCTIONS
 * =====================================================
 */

/**
 * Calculate rental price based on duration and type
 */
function calculateRentalPrice(vehicle, rentalType, startDate, endDate) {
    const start = dayjs(startDate);
    const end = dayjs(endDate);
    let totalPrice = 0;
    let duration = 0;
    let pricePerUnit = 0;

    switch (rentalType) {
        case 'HOUR':
            if (!vehicle.rentalPricePerHour) {
                return { error: 'Hourly rental not available for this vehicle' };
            }
            duration = end.diff(start, 'hour');
            pricePerUnit = parseFloat(vehicle.rentalPricePerHour);
            totalPrice = duration * pricePerUnit;
            break;

        case 'DAY':
            if (!vehicle.rentalPricePerDay) {
                return { error: 'Daily rental not available for this vehicle' };
            }
            duration = end.diff(start, 'day');
            pricePerUnit = parseFloat(vehicle.rentalPricePerDay);
            totalPrice = duration * pricePerUnit;
            break;

        case 'WEEK':
            if (!vehicle.rentalPricePerWeek) {
                return { error: 'Weekly rental not available for this vehicle' };
            }
            duration = end.diff(start, 'week');
            pricePerUnit = parseFloat(vehicle.rentalPricePerWeek);
            totalPrice = duration * pricePerUnit;
            break;

        case 'MONTH':
            if (!vehicle.rentalPricePerMonth) {
                return { error: 'Monthly rental not available for this vehicle' };
            }
            duration = end.diff(start, 'month');
            pricePerUnit = parseFloat(vehicle.rentalPricePerMonth);
            totalPrice = duration * pricePerUnit;
            break;
    }

    if (totalPrice <= 0 || duration <= 0) {
        return { error: 'Invalid rental duration or pricing' };
    }

    return {
        duration,
        pricePerUnit,
        totalPrice,
        rentalType,
        currency: vehicle.rentalCurrency || 'XAF'
    };
}

/**
 * Check if cancellation is allowed (24 hours before start date)
 */
function isCancellationAllowed(startDate) {
    const now = dayjs();
    const start = dayjs(startDate);
    const hoursUntilStart = start.diff(now, 'hour');

    return hoursUntilStart >= 24;
}

/**
 * =====================================================
 * VEHICLE MANAGEMENT
 * =====================================================
 */

/**
 * Employee uploads/registers a vehicle WITH IMAGES
 */
async function createVehicle(req, res, next) {
    try {
        console.log("📝 Employee posting vehicle:", req.body);
        console.log("📸 Files uploaded:", req.files ? req.files.length : 0);

        const { error, value } = vehicleSchema.validate(req.body, { stripUnknown: true });
        if (error) {
            console.log("❌ Validation error:", error.details);
            return res.status(400).json({ error: error.details[0].message });
        }

        const employeeId = req.body.employeeId || req.user?.uuid;

        if (!employeeId) {
            return res.status(400).json({
                error: 'Employee ID is required',
                message: 'Please provide employeeId in the request body'
            });
        }

        console.log("✅ Checking employee ID:", employeeId);

        const employee = await Employee.findOne({
            where: { accountId: employeeId },
            include: [{
                model: Account,
                as: 'account',
                attributes: ['uuid', 'first_name', 'last_name', 'email', 'user_type']
            }]
        });

        if (!employee) {
            console.log("❌ Employee not found in employees table:", employeeId);
            return res.status(404).json({
                error: 'Employee not found',
                message: 'The provided employee ID does not exist in the employees table',
                employeeId: employeeId
            });
        }

        if (employee.employmentStatus !== 'ACTIVE') {
            console.log("❌ Employee not active:", employee.employmentStatus);
            return res.status(403).json({
                error: 'Employee not active',
                message: `Employee status is ${employee.employmentStatus}. Only active employees can register vehicles.`
            });
        }

        console.log("✅ Employee verified:", employee.account?.first_name, employee.account?.last_name);

        const partner = await Account.findOne({
            where: { uuid: value.partnerId, user_type: 'PARTNER' }
        });

        if (!partner) {
            console.log("❌ Partner not found:", value.partnerId);
            return res.status(404).json({
                error: 'Partner not found',
                message: 'The provided partner ID does not exist or is not a partner account'
            });
        }

        console.log("✅ Partner verified:", partner.first_name, partner.last_name);

        if (value.categoryId) {
            const category = await VehicleCategory.findByPk(value.categoryId);
            if (!category) {
                console.log("❌ Category not found:", value.categoryId);
                return res.status(404).json({
                    error: 'Vehicle category not found',
                    message: 'The provided category ID does not exist'
                });
            }
            console.log("✅ Category verified:", category.name);
        }

        let imageUrls = [];
        if (req.files && req.files.length > 0) {
            imageUrls = req.files.map(file => getFileUrl(file.filename, 'vehicle'));
            console.log("📸 Processed image URLs:", imageUrls);
        }

        const vehicle = await Vehicle.create({
            id: uuidv4(),
            plate: value.plate,
            makeModel: value.makeModel,
            color: value.color,
            region: value.region,
            seats: value.seats,
            partnerId: value.partnerId,
            postedByEmployeeId: employeeId,
            categoryId: value.categoryId,
            availableForRent: true,
            rentalPricePerHour: value.rentalPricePerHour,
            rentalPricePerDay: value.rentalPricePerDay,
            rentalPricePerWeek: value.rentalPricePerWeek,
            rentalPricePerMonth: value.rentalPricePerMonth,
            images: imageUrls
        });

        console.log("✅ Vehicle registered successfully:", vehicle.id);

        res.status(201).json({
            message: 'Vehicle registered successfully',
            vehicle: {
                id: vehicle.id,
                plate: vehicle.plate,
                makeModel: vehicle.makeModel,
                color: vehicle.color,
                region: vehicle.region,
                seats: vehicle.seats,
                partnerId: vehicle.partnerId,
                postedByEmployeeId: vehicle.postedByEmployeeId,
                categoryId: vehicle.categoryId,
                availableForRent: vehicle.availableForRent,
                rentalPricePerHour: vehicle.rentalPricePerHour,
                rentalPricePerDay: vehicle.rentalPricePerDay,
                rentalPricePerWeek: vehicle.rentalPricePerWeek,
                rentalPricePerMonth: vehicle.rentalPricePerMonth,
                images: vehicle.images,
                createdAt: vehicle.createdAt
            },
            postedBy: {
                employeeCode: employee.employeeCode,
                name: `${employee.account?.first_name} ${employee.account?.last_name}`,
                department: employee.department
            }
        });
    } catch (err) {
        console.error("❌ Error in createVehicle:", err);

        if (err.name === 'SequelizeForeignKeyConstraintError') {
            return res.status(400).json({
                error: 'Foreign key constraint error',
                message: 'Referenced partner, employee, or category does not exist in the database'
            });
        }

        if (err.name === 'SequelizeUniqueConstraintError') {
            return res.status(400).json({
                error: 'Duplicate entry',
                message: 'A vehicle with this plate number already exists',
                plate: req.body.plate
            });
        }

        if (err.name === 'SequelizeValidationError') {
            return res.status(400).json({
                error: 'Validation error',
                message: err.message,
                details: err.errors.map(e => ({
                    field: e.path,
                    message: e.message
                }))
            });
        }

        return res.status(500).json({
            error: 'Database error',
            message: 'Failed to create vehicle',
            details: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
        });
    }
}

/**
 * Users see all vehicles available for rent
 */
async function listAvailableVehicles(req, res, next) {
    try {
        const { region, categoryId, minPrice, maxPrice, seats } = req.query;

        console.log("🔍 Fetching available vehicles. Filters:", { region, categoryId, minPrice, maxPrice, seats });

        const whereClause = { availableForRent: true };

        if (region) {
            whereClause.region = region;
        }

        if (categoryId) {
            whereClause.categoryId = categoryId;
        }

        if (seats) {
            whereClause.seats = { [Op.gte]: parseInt(seats) };
        }

        const vehicles = await Vehicle.findAll({
            where: whereClause,
            attributes: [
                'id', 'plate', 'makeModel', 'color', 'region', 'seats',
                'rentalPricePerHour', 'rentalPricePerDay',
                'rentalPricePerWeek', 'rentalPricePerMonth',
                'rentalCurrency', 'images', 'categoryId', 'createdAt'
            ],
            include: [
                {
                    model: VehicleCategory,
                    as: 'category',
                    attributes: ['id', 'name', 'slug', 'description', 'icon']
                }
            ],
            order: [['createdAt', 'DESC']]
        });

        console.log("✅ Available vehicles found:", vehicles.length);
        res.json({
            success: true,
            count: vehicles.length,
            vehicles
        });
    } catch (err) {
        console.error("❌ Error in listAvailableVehicles:", err);
        next(err);
    }
}

/**
 * Update vehicle availability
 */
async function updateVehicleAvailability(req, res, next) {
    try {
        const { id } = req.params;
        const { availableForRent } = req.body;

        console.log("🔄 Updating vehicle availability:", id);

        if (typeof availableForRent !== 'boolean') {
            return res.status(400).json({ error: 'availableForRent must be a boolean' });
        }

        const vehicle = await Vehicle.findByPk(id);
        if (!vehicle) {
            return res.status(404).json({ error: 'Vehicle not found' });
        }

        vehicle.availableForRent = availableForRent;
        await vehicle.save();

        console.log("✅ Vehicle availability updated:", vehicle.id);

        res.json({
            success: true,
            message: 'Vehicle availability updated successfully',
            vehicle: {
                id: vehicle.id,
                availableForRent: vehicle.availableForRent
            }
        });
    } catch (err) {
        console.error("❌ Error in updateVehicleAvailability:", err);
        next(err);
    }
}

/**
 * =====================================================
 * RENTAL PRICING & CALCULATION
 * =====================================================
 */

/**
 * Calculate rental price before booking (NEW)
 */
async function calculatePrice(req, res, next) {
    try {
        console.log("💰 Calculating rental price:", req.query);

        const { error, value } = calculatePriceSchema.validate(req.query);
        if (error) {
            console.log("❌ Validation error:", error.details);
            return res.status(400).json({
                error: error.details[0].message,
                details: error.details
            });
        }

        const vehicle = await Vehicle.findByPk(value.vehicleId);

        if (!vehicle || !vehicle.availableForRent) {
            console.log("❌ Vehicle not available:", value.vehicleId);
            return res.status(400).json({
                error: 'Vehicle not available for rental'
            });
        }

        const calculation = calculateRentalPrice(
            vehicle,
            value.rentalType,
            value.startDate,
            value.endDate
        );

        if (calculation.error) {
            return res.status(400).json({ error: calculation.error });
        }

        console.log("✅ Price calculated:", calculation);

        res.json({
            success: true,
            vehicleId: vehicle.id,
            makeModel: vehicle.makeModel,
            plate: vehicle.plate,
            rentalType: calculation.rentalType,
            duration: calculation.duration,
            pricePerUnit: calculation.pricePerUnit,
            totalPrice: calculation.totalPrice,
            currency: calculation.currency,
            breakdown: {
                startDate: value.startDate,
                endDate: value.endDate,
                calculation: `${calculation.duration} ${value.rentalType}(s) × ${calculation.pricePerUnit} ${calculation.currency} = ${calculation.totalPrice} ${calculation.currency}`
            }
        });
    } catch (err) {
        console.error("❌ Error in calculatePrice:", err);
        next(err);
    }
}

/**
 * =====================================================
 * RENTAL BOOKING & MANAGEMENT
 * =====================================================
 */

/**
 * Passenger creates a rental request (PENDING status - requires admin approval)
 */
async function createRental(req, res, next) {
    try {
        console.log("📝 Rental request from user:", req.body);

        if (!req.body || Object.keys(req.body).length === 0) {
            return res.status(400).json({
                error: 'Request body is empty',
                message: 'Please provide rental details in JSON format'
            });
        }

        const { error, value } = createRentalSchema.validate(req.body, { stripUnknown: true });
        if (error) {
            console.log("❌ Validation error:", error.details);
            return res.status(400).json({
                error: error.details[0].message,
                details: error.details
            });
        }

        // Verify user exists
        const user = await Account.findOne({
            where: { uuid: value.userId, user_type: 'PASSENGER' }
        });

        if (!user) {
            return res.status(404).json({
                error: 'User not found',
                message: 'The provided userId does not exist or is not a passenger account'
            });
        }

        const vehicle = await Vehicle.findByPk(value.vehicleId);
        console.log("🚗 Vehicle fetched:", vehicle ? vehicle.id : "Not found");

        if (!vehicle || !vehicle.availableForRent) {
            console.log("❌ Vehicle not available:", value.vehicleId);
            return res.status(400).json({
                error: 'Vehicle not available for rental'
            });
        }

        // Check if vehicle region matches rental region
        if (vehicle.region !== value.rentalRegion) {
            return res.status(400).json({
                error: `This vehicle is only available in ${vehicle.region}. You selected ${value.rentalRegion}.`
            });
        }

        // Check for double booking
        const overlap = await VehicleRental.findOne({
            where: {
                vehicleId: value.vehicleId,
                status: { [Op.in]: ['PENDING', 'CONFIRMED'] },
                startDate: { [Op.lt]: value.endDate },
                endDate: { [Op.gt]: value.startDate }
            }
        });

        if (overlap) {
            console.log("❌ Double booking detected:", overlap.id);
            return res.status(400).json({
                error: 'Vehicle already booked for this period',
                conflictingRental: {
                    startDate: overlap.startDate,
                    endDate: overlap.endDate
                }
            });
        }

        // Calculate price
        const calculation = calculateRentalPrice(
            vehicle,
            value.rentalType,
            value.startDate,
            value.endDate
        );

        if (calculation.error) {
            return res.status(400).json({ error: calculation.error });
        }

        console.log(`💰 Calculated: ${calculation.duration} ${value.rentalType}(s), Total price: ${calculation.totalPrice}`);

        // Create rental with PENDING status
        const rental = await VehicleRental.create({
            id: uuidv4(),
            userId: value.userId,
            vehicleId: value.vehicleId,
            rentalRegion: value.rentalRegion,
            rentalType: value.rentalType,
            startDate: value.startDate,
            endDate: value.endDate,
            status: 'PENDING',
            userNotes: value.userNotes || null,
            totalPrice: calculation.totalPrice,
            paymentStatus: 'unpaid'
        });

        console.log("✅ Rental created with PENDING status:", rental.id);

        res.status(201).json({
            success: true,
            message: 'Rental request submitted successfully. Our team will review and contact you shortly.',
            rental: {
                id: rental.id,
                vehicleId: rental.vehicleId,
                userId: rental.userId,
                startDate: rental.startDate,
                endDate: rental.endDate,
                rentalType: rental.rentalType,
                totalPrice: rental.totalPrice,
                status: rental.status,
                paymentStatus: rental.paymentStatus,
                createdAt: rental.createdAt
            }
        });
    } catch (err) {
        console.error("❌ Error in createRental:", err);
        return res.status(500).json({
            error: 'Failed to create rental',
            message: err.message,
            details: process.env.NODE_ENV === 'development' ? err.stack : undefined
        });
    }
}

/**
 * Get single rental details (NEW)
 */
async function getRentalById(req, res, next) {
    try {
        const { id } = req.params;
        console.log("🔍 Fetching rental:", id);

        const rental = await VehicleRental.findByPk(id, {
            include: [
                {
                    model: Vehicle,
                    attributes: ['id', 'plate', 'makeModel', 'color', 'images', 'region', 'seats', 'rentalCurrency'],
                    include: [
                        {
                            model: VehicleCategory,
                            as: 'category',
                            attributes: ['id', 'name', 'slug', 'icon']
                        }
                    ]
                },
                {
                    model: Account,
                    as: 'user',
                    attributes: ['uuid', 'first_name', 'last_name', 'email', 'phone_e164'],
                    include: [
                        {
                            model: PassengerProfile,
                            as: 'passenger_profile',
                            required: false
                        }
                    ]
                }
            ]
        });

        if (!rental) {
            return res.status(404).json({
                error: 'Rental not found'
            });
        }

        console.log("✅ Rental found:", rental.id);

        res.json({
            success: true,
            rental
        });
    } catch (err) {
        console.error("❌ Error in getRentalById:", err);
        next(err);
    }
}


/**
 * List all rentals for a specific user
 * GET /api/rentals/user/:userId
 */
/**
 * List all rentals for a specific user
 * GET /api/rentals/user/:userId
 */
const listUserRentals = async (req, res) => {
    try {
        const { userId } = req.params;

        console.log('📋 Fetching rentals for user:', userId);

        const rentals = await VehicleRental.findAll({
            where: { userId },
            include: [
                {
                    model: Vehicle,
                    as: 'vehicle',
                    include: [
                        {
                            model: VehicleCategory,
                            as: 'category',
                        },
                    ],
                },
                {
                    model: Account,  // ✅ CHANGE: Use Account instead of User
                    as: 'user',
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'email', 'user_type'], // ✅ CHANGE: Use snake_case field names
                },
            ],
            order: [['createdAt', 'DESC']],
        });

        console.log(`✅ Found ${rentals.length} rentals for user ${userId}`);

        return res.status(200).json({
            success: true,
            message: `Found ${rentals.length} rentals`,
            data: {
                rentals,
                count: rentals.length,
            },
        });
    } catch (error) {
        console.error('❌ Error in listUserRentals:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to fetch user rentals',
            details: error.message,
        });
    }
};
/**
 * User cancels their rental (24-hour rule) (NEW)
 */
async function cancelRentalByUser(req, res, next) {
    try {
        const { id } = req.params;
        console.log("🚫 User cancelling rental:", id);

        const { error, value } = cancelRentalSchema.validate(req.body);
        if (error) {
            return res.status(400).json({
                error: error.details[0].message
            });
        }

        const rental = await VehicleRental.findByPk(id, {
            include: [
                { model: Vehicle, attributes: ['id', 'plate', 'makeModel'] },
                { model: Account, as: 'user', attributes: ['uuid', 'first_name', 'last_name'] }
            ]
        });

        if (!rental) {
            return res.status(404).json({ error: 'Rental not found' });
        }

        // Check if rental can be cancelled
        if (rental.status === 'CANCELLED') {
            return res.status(400).json({ error: 'Rental already cancelled' });
        }

        if (rental.status === 'COMPLETED') {
            return res.status(400).json({ error: 'Cannot cancel completed rental' });
        }

        // Check 24-hour cancellation policy
        if (!isCancellationAllowed(rental.startDate)) {
            const hoursUntilStart = dayjs(rental.startDate).diff(dayjs(), 'hour');
            return res.status(400).json({
                error: 'Cannot cancel rental',
                message: `Cancellation is only allowed 24 hours before the start date. Your rental starts in ${hoursUntilStart} hours.`,
                policy: 'Cancellations must be made at least 24 hours before the rental start date'
            });
        }

        // Update rental
        rental.status = 'CANCELLED';
        rental.cancellationReason = value.reason;
        await rental.save();

        console.log("✅ Rental cancelled by user:", rental.id);

        res.json({
            success: true,
            message: 'Rental cancelled successfully',
            rental: {
                id: rental.id,
                status: rental.status,
                cancellationReason: rental.cancellationReason,
                vehicleId: rental.vehicleId,
                userId: rental.userId
            }
        });
    } catch (err) {
        console.error("❌ Error in cancelRentalByUser:", err);
        next(err);
    }
}

/**
 * Update payment details (on pickup) (NEW)
 */
async function updatePayment(req, res, next) {
    try {
        const { id } = req.params;
        console.log("💳 Updating payment for rental:", id);

        const { error, value } = updatePaymentSchema.validate(req.body);
        if (error) {
            return res.status(400).json({
                error: error.details[0].message
            });
        }

        const rental = await VehicleRental.findByPk(id);

        if (!rental) {
            return res.status(404).json({ error: 'Rental not found' });
        }

        // Update payment details
        rental.paymentStatus = 'paid';
        rental.paymentMethod = value.paymentMethod;
        if (value.transactionRef) {
            rental.transactionRef = value.transactionRef;
        }

        await rental.save();

        console.log("✅ Payment updated for rental:", rental.id);

        res.json({
            success: true,
            message: 'Payment updated successfully',
            rental: {
                id: rental.id,
                paymentStatus: rental.paymentStatus,
                paymentMethod: rental.paymentMethod,
                transactionRef: rental.transactionRef,
                totalPrice: rental.totalPrice
            }
        });
    } catch (err) {
        console.error("❌ Error in updatePayment:", err);
        next(err);
    }
}

/**
 * =====================================================
 * ADMIN/EMPLOYEE FUNCTIONS
 * =====================================================
 */

/**
 * Admin/Employee views all rental requests
 */
async function listAllRentals(req, res, next) {
    try {
        console.log("📋 Fetching all rental requests...");

        const { status, paymentStatus } = req.query;
        const whereClause = {};

        if (status) {
            whereClause.status = status;
        }

        if (paymentStatus) {
            whereClause.paymentStatus = paymentStatus;
        }

        const rentals = await VehicleRental.findAll({
            where: whereClause,
            include: [
                {
                    model: Vehicle,
                    attributes: ['id', 'plate', 'makeModel', 'color', 'region', 'images'],
                    include: [
                        {
                            model: Account,
                            as: 'partner',
                            attributes: ['uuid', 'first_name', 'last_name', 'phone_e164']
                        }
                    ]
                },
                {
                    model: Account,
                    as: 'user',
                    attributes: ['uuid', 'first_name', 'last_name', 'email', 'phone_e164']
                }
            ],
            order: [['createdAt', 'DESC']]
        });

        console.log("✅ Total rental requests found:", rentals.length);
        res.json({
            success: true,
            count: rentals.length,
            rentals
        });
    } catch (err) {
        console.error("❌ Error in listAllRentals:", err);
        next(err);
    }
}

/**
 * Employee/Admin cancels a rental
 */
async function cancelRental(req, res, next) {
    try {
        console.log("🚫 Admin cancelling rental:", req.params.id);

        const rental = await VehicleRental.findByPk(req.params.id, {
            include: [
                { model: Vehicle, attributes: ['id', 'plate', 'makeModel'] },
                { model: Account, as: 'user', attributes: ['uuid', 'first_name', 'last_name', 'email'] }
            ]
        });

        if (!rental) {
            return res.status(404).json({ error: 'Rental not found' });
        }

        if (rental.status === 'CANCELLED') {
            return res.status(400).json({ error: 'Rental already cancelled' });
        }

        if (rental.status === 'COMPLETED') {
            return res.status(400).json({ error: 'Cannot cancel completed rental' });
        }

        rental.status = 'CANCELLED';
        await rental.save();

        console.log("✅ Rental cancelled by admin:", rental.id);

        res.json({
            success: true,
            message: 'Rental cancelled successfully',
            rental: {
                id: rental.id,
                status: rental.status,
                vehicleId: rental.vehicleId,
                userId: rental.userId
            }
        });
    } catch (err) {
        console.error("❌ Error in cancelRental:", err);
        next(err);
    }
}

/**
 * Mark rental as completed
 */
async function completeRental(req, res, next) {
    try {
        const { id } = req.params;
        console.log("✅ Completing rental:", id);

        const rental = await VehicleRental.findByPk(id);
        if (!rental) {
            return res.status(404).json({ error: 'Rental not found' });
        }

        if (rental.status === 'CANCELLED') {
            return res.status(400).json({ error: 'Cannot complete a cancelled rental' });
        }

        if (rental.status === 'COMPLETED') {
            return res.status(400).json({ error: 'Rental already completed' });
        }

        rental.status = 'COMPLETED';
        await rental.save();

        console.log("✅ Rental completed:", rental.id);

        res.json({
            success: true,
            message: 'Rental marked as completed',
            rental: {
                id: rental.id,
                status: rental.status
            }
        });
    } catch (err) {
        console.error("❌ Error in completeRental:", err);
        next(err);
    }
}

/**
 * =====================================================
 * CATEGORIES
 * =====================================================
 */

/**
 * List vehicle categories
 */
async function listCategories(req, res, next) {
    try {
        console.log("📁 Fetching vehicle categories...");

        const categories = await VehicleCategory.findAll({
            where: { isActive: true },
            order: [['sortOrder', 'ASC']]
        });

        console.log("✅ Categories found:", categories.length);
        res.json({
            success: true,
            count: categories.length,
            categories
        });
    } catch (err) {
        console.error("❌ Error in listCategories:", err);
        next(err);
    }
}

/**
 * =====================================================
 * EXPORTS
 * =====================================================
 */

module.exports = {
    // Vehicle Management
    createVehicle,
    listAvailableVehicles,
    updateVehicleAvailability,

    // Pricing
    calculatePrice,

    // Rental Booking (User)
    createRental,
    getRentalById,
    listUserRentals,
    cancelRentalByUser,
    updatePayment,

    // Admin Management
    listAllRentals,
    cancelRental,
    completeRental,

    // Categories
    listCategories
};