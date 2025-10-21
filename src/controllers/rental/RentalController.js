// src/controllers/rental/RentalController.js
const { Vehicle, VehicleRental, Account, VehicleCategory, Employee } = require('../../models');
const { v4: uuidv4 } = require('uuid');
const Joi = require('joi');
const { Op } = require('sequelize');
const dayjs = require('dayjs');
const { getFileUrl } = require('../../middleware/upload');

/**
 * Validation schemas
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

        // Get employeeId from request body (for testing without auth)
        const employeeId = req.body.employeeId || req.user?.uuid;

        if (!employeeId) {
            return res.status(400).json({
                error: 'Employee ID is required',
                message: 'Please provide employeeId in the request body'
            });
        }

        console.log("✅ Checking employee ID:", employeeId);

        // Verify the employee exists in the Employee table
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
                employeeId: employeeId,
                hint: 'Make sure the employee record exists in the employees table'
            });
        }

        console.log("✅ Employee found:", employee);
        console.log("✅ Employment status:", employee.employmentStatus);

        if (employee.employmentStatus !== 'ACTIVE') {
            console.log("❌ Employee not active:", employee.employmentStatus);
            return res.status(403).json({
                error: 'Employee not active',
                message: `Employee status is ${employee.employmentStatus}. Only active employees can register vehicles.`,
                employeeId: employeeId
            });
        }

        console.log("✅ Employee verified:", employee.account?.first_name, employee.account?.last_name);

        // Verify the partner exists
        const partner = await Account.findOne({
            where: { uuid: value.partnerId, user_type: 'PARTNER' }
        });

        if (!partner) {
            console.log("❌ Partner not found:", value.partnerId);
            return res.status(404).json({
                error: 'Partner not found',
                message: 'The provided partner ID does not exist or is not a partner account',
                partnerId: value.partnerId
            });
        }

        console.log("✅ Partner verified:", partner.first_name, partner.last_name);

        // Verify category exists if provided
        if (value.categoryId) {
            const category = await VehicleCategory.findByPk(value.categoryId);
            if (!category) {
                console.log("❌ Category not found:", value.categoryId);
                return res.status(404).json({
                    error: 'Vehicle category not found',
                    message: 'The provided category ID does not exist',
                    categoryId: value.categoryId
                });
            }
            console.log("✅ Category verified:", category.name);
        }

        // Process uploaded images
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

        // Return user-friendly error messages
        if (err.name === 'SequelizeForeignKeyConstraintError') {
            return res.status(400).json({
                error: 'Foreign key constraint error',
                message: 'Referenced partner, employee, or category does not exist in the database',
                details: err.message,
                hint: 'Please verify that the employeeId, partnerId, and categoryId are correct'
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

        // Generic database error
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
        const { region, categoryId } = req.query;

        console.log("Fetching available vehicles. Filters:", { region, categoryId });

        const whereClause = { availableForRent: true };

        if (region) {
            whereClause.region = region;
        }

        if (categoryId) {
            whereClause.categoryId = categoryId;
        }

        const vehicles = await Vehicle.findAll({
            where: whereClause,
            attributes: [
                'id', 'plate', 'makeModel', 'color', 'region', 'seats',
                'rentalPricePerHour', 'rentalPricePerDay',
                'rentalPricePerWeek', 'rentalPricePerMonth',
                'rentalCurrency', 'images', 'categoryId'
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

        console.log("Available vehicles found:", vehicles.length);
        res.json({
            count: vehicles.length,
            vehicles
        });
    } catch (err) {
        console.error("Error in listAvailableVehicles:", err);
        next(err);
    }
}

/**
 * Passenger creates a rental request (no approval needed)
 */
async function createRental(req, res, next) {
    try {
        console.log("Rental request from user:", req.body);

        // Check if body is empty
        if (!req.body || Object.keys(req.body).length === 0) {
            return res.status(400).json({
                error: 'Request body is empty',
                message: 'Please provide rental details in JSON format',
                hint: 'Make sure Content-Type is application/json and Body type is "raw" JSON in Postman'
            });
        }

        const { error, value } = createRentalSchema.validate(req.body, { stripUnknown: true });
        if (error) {
            console.log("Validation error:", error.details);
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
                message: 'The provided userId does not exist or is not a passenger account',
                userId: value.userId
            });
        }

        const vehicle = await Vehicle.findByPk(value.vehicleId);
        console.log("Vehicle fetched:", vehicle ? vehicle.id : "Not found");

        if (!vehicle || !vehicle.availableForRent) {
            console.log("Vehicle not available:", value.vehicleId);
            return res.status(400).json({
                error: 'Vehicle not available for rental',
                vehicleId: value.vehicleId
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
                status: { [Op.in]: ['PENDING', 'CONFIRMED', 'ONGOING'] },
                startDate: { [Op.lt]: value.endDate },
                endDate: { [Op.gt]: value.startDate }
            }
        });

        if (overlap) {
            console.log("Double booking detected:", overlap.id);
            return res.status(400).json({
                error: 'Vehicle already booked for this period',
                conflictingRental: {
                    startDate: overlap.startDate,
                    endDate: overlap.endDate
                }
            });
        }

        // Calculate price based on rental type
        const start = dayjs(value.startDate);
        const end = dayjs(value.endDate);
        let totalPrice = 0;
        let duration = 0;

        switch (value.rentalType) {
            case 'HOUR':
                if (!vehicle.rentalPricePerHour) {
                    return res.status(400).json({ error: 'Hourly rental not available for this vehicle' });
                }
                duration = end.diff(start, 'hour');
                totalPrice = duration * parseFloat(vehicle.rentalPricePerHour);
                break;

            case 'DAY':
                if (!vehicle.rentalPricePerDay) {
                    return res.status(400).json({ error: 'Daily rental not available for this vehicle' });
                }
                duration = end.diff(start, 'day');
                totalPrice = duration * parseFloat(vehicle.rentalPricePerDay);
                break;

            case 'WEEK':
                if (!vehicle.rentalPricePerWeek) {
                    return res.status(400).json({ error: 'Weekly rental not available for this vehicle' });
                }
                duration = end.diff(start, 'week');
                totalPrice = duration * parseFloat(vehicle.rentalPricePerWeek);
                break;

            case 'MONTH':
                if (!vehicle.rentalPricePerMonth) {
                    return res.status(400).json({ error: 'Monthly rental not available for this vehicle' });
                }
                duration = end.diff(start, 'month');
                totalPrice = duration * parseFloat(vehicle.rentalPricePerMonth);
                break;
        }

        console.log(`Calculated: ${duration} ${value.rentalType}(s), Total price: ${totalPrice}`);

        if (totalPrice <= 0 || duration <= 0) {
            return res.status(400).json({ error: 'Invalid rental duration or pricing' });
        }

        // Create rental with CONFIRMED status (no approval needed)
        const rental = await VehicleRental.create({
            id: uuidv4(),
            userId: value.userId,
            vehicleId: value.vehicleId,
            rentalRegion: value.rentalRegion,
            rentalType: value.rentalType,
            startDate: value.startDate,
            endDate: value.endDate,
            status: 'CONFIRMED',
            contactStatus: 'PENDING',
            userNotes: value.userNotes || null,
            totalPrice,
            paymentStatus: 'UNPAID'
        });

        console.log("Rental confirmed:", rental.toJSON());

        res.status(201).json({
            message: 'Rental confirmed successfully. Our team will contact you shortly to arrange details.',
            rental: {
                id: rental.id,
                vehicleId: rental.vehicleId,
                userId: rental.userId,
                startDate: rental.startDate,
                endDate: rental.endDate,
                rentalType: rental.rentalType,
                totalPrice: rental.totalPrice,
                status: rental.status,
                contactStatus: rental.contactStatus
            }
        });
    } catch (err) {
        console.error("Error in createRental:", err);
        return res.status(500).json({
            error: 'Failed to create rental',
            message: err.message,
            details: process.env.NODE_ENV === 'development' ? err.stack : undefined
        });
    }
}

/**
 * Employee/Admin cancels a rental
 */
async function cancelRental(req, res, next) {
    try {
        console.log("Cancelling rental:", req.params.id);

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

        console.log("Rental cancelled:", rental.id);

        res.json({
            message: 'Rental cancelled successfully',
            rental: {
                id: rental.id,
                status: rental.status,
                vehicleId: rental.vehicleId,
                userId: rental.userId
            }
        });
    } catch (err) {
        console.error("Error in cancelRental:", err);
        next(err);
    }
}

/**
 * User views their rental history
 */
async function listUserRentals(req, res, next) {
    try {
        const userId = req.params.userId;
        console.log("Fetching rentals for user:", userId);

        const rentals = await VehicleRental.findAll({
            where: { userId },
            include: [
                {
                    model: Vehicle,
                    attributes: ['id', 'plate', 'makeModel', 'color', 'images', 'region']
                }
            ],
            order: [['createdAt', 'DESC']]
        });

        console.log("User rentals found:", rentals.length);
        res.json({
            count: rentals.length,
            rentals
        });
    } catch (err) {
        console.error("Error in listUserRentals:", err);
        next(err);
    }
}

/**
 * Admin/Employee views all rental requests
 */
async function listAllRentals(req, res, next) {
    try {
        console.log("Fetching all rental requests...");

        const { status, contactStatus } = req.query;
        const whereClause = {};

        if (status) {
            whereClause.status = status;
        }

        if (contactStatus) {
            whereClause.contactStatus = contactStatus;
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

        console.log("Total rental requests found:", rentals.length);
        res.json({
            count: rentals.length,
            rentals
        });
    } catch (err) {
        console.error("Error in listAllRentals:", err);
        next(err);
    }
}

/**
 * Update rental contact status (when company contacts the user)
 */
async function updateContactStatus(req, res, next) {
    try {
        const { id } = req.params;
        const { contactStatus } = req.body;

        console.log("Updating contact status for rental:", id);

        const validStatuses = ['PENDING', 'CONTACTED', 'CONFIRMED'];
        if (!validStatuses.includes(contactStatus)) {
            return res.status(400).json({
                error: 'Invalid contact status',
                validStatuses
            });
        }

        const rental = await VehicleRental.findByPk(id);
        if (!rental) {
            return res.status(404).json({ error: 'Rental not found' });
        }

        rental.contactStatus = contactStatus;
        await rental.save();

        console.log("Contact status updated:", rental.id);

        res.json({
            message: 'Contact status updated successfully',
            rental: {
                id: rental.id,
                contactStatus: rental.contactStatus
            }
        });
    } catch (err) {
        console.error("Error in updateContactStatus:", err);
        next(err);
    }
}

/**
 * List vehicle categories
 */
async function listCategories(req, res, next) {
    try {
        console.log("Fetching vehicle categories...");

        const categories = await VehicleCategory.findAll({
            where: { isActive: true },
            order: [['sortOrder', 'ASC']]
        });

        console.log("Categories found:", categories.length);
        res.json({
            count: categories.length,
            categories
        });
    } catch (err) {
        console.error("Error in listCategories:", err);
        next(err);
    }
}

/**
 * Mark rental as completed
 */
async function completeRental(req, res, next) {
    try {
        const { id } = req.params;
        console.log("Completing rental:", id);

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

        console.log("Rental completed:", rental.id);

        res.json({
            message: 'Rental marked as completed',
            rental: {
                id: rental.id,
                status: rental.status
            }
        });
    } catch (err) {
        console.error("Error in completeRental:", err);
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

        console.log("Updating vehicle availability:", id);

        if (typeof availableForRent !== 'boolean') {
            return res.status(400).json({ error: 'availableForRent must be a boolean' });
        }

        const vehicle = await Vehicle.findByPk(id);
        if (!vehicle) {
            return res.status(404).json({ error: 'Vehicle not found' });
        }

        vehicle.availableForRent = availableForRent;
        await vehicle.save();

        console.log("Vehicle availability updated:", vehicle.id);

        res.json({
            message: 'Vehicle availability updated successfully',
            vehicle: {
                id: vehicle.id,
                availableForRent: vehicle.availableForRent
            }
        });
    } catch (err) {
        console.error("Error in updateVehicleAvailability:", err);
        next(err);
    }
}

module.exports = {
    createVehicle,
    listAvailableVehicles,
    createRental,
    cancelRental,
    listUserRentals,
    listAllRentals,
    updateContactStatus,
    completeRental,
    updateVehicleAvailability,
    listCategories
};