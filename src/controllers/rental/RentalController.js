const { Vehicle, VehicleRental, Account, VehicleCategory } = require('../../models');
const { v4: uuidv4 } = require('uuid');
const Joi = require('joi');
const { Op } = require('sequelize');
const dayjs = require('dayjs');

/**
 * Validation schemas
 */
const vehicleSchema = Joi.object({
    plate: Joi.string().max(24).required(),
    makeModel: Joi.string().max(64).allow(null, ''),
    color: Joi.string().max(32).allow(null, ''),
    seats: Joi.number().integer().min(1).max(12).default(4),
    rentalPricePerHour: Joi.number().min(0).allow(null),
    rentalPricePerDay: Joi.number().min(0).allow(null),
    rentalPricePerWeek: Joi.number().min(0).allow(null),
    rentalPricePerMonth: Joi.number().min(0).allow(null),
    categoryId: Joi.string().uuid().allow(null),
    images: Joi.array().items(Joi.string().uri()).max(10)
});

const createRentalSchema = Joi.object({
    userId: Joi.string().uuid().required(),
    vehicleId: Joi.string().uuid().required(),
    rentalType: Joi.string().valid('HOUR','DAY','WEEK','MONTH').required(),
    startDate: Joi.date().required(),
    endDate: Joi.date().greater(Joi.ref('startDate')).required(),
    totalPrice: Joi.any().strip() // ignore frontend’s price
});

/**
 * Partner uploads/registers a vehicle
 */
async function createVehicle(req, res, next) {
    try {
        console.log("Incoming request to createVehicle:", req.body);

        const { error, value } = vehicleSchema.validate(req.body, { stripUnknown: true });
        if (error) {
            console.log("Validation error in createVehicle:", error.details);
            return res.status(400).json({ error: error.details[0].message });
        }

        const partnerId = req.user?.uuid;
        console.log("Partner ID:", partnerId);

        if (!partnerId || req.user.user_type !== 'PARTNER') {
            console.log("Unauthorized attempt to register vehicle:", req.user);
            return res.status(403).json({ error: 'Only partners can register vehicles' });
        }

        const vehicle = await Vehicle.create({
            id: uuidv4(),
            plate: value.plate,
            makeModel: value.makeModel,
            color: value.color,
            seats: value.seats,
            partnerId,
            availableForRent: true,
            rentalPricePerHour: value.rentalPricePerHour,
            rentalPricePerDay: value.rentalPricePerDay,
            rentalPricePerWeek: value.rentalPricePerWeek,
            rentalPricePerMonth: value.rentalPricePerMonth,
            categoryId: value.categoryId,
            images: value.images || []
        });

        console.log("Vehicle registered:", vehicle.toJSON());

        res.json({ message: 'Vehicle registered successfully', vehicle });
    } catch (err) {
        console.error("Error in createVehicle:", err);
        next(err);
    }
}

/**
 * Users see all vehicles available for rent
 */
async function listAvailableVehicles(req, res, next) {
    try {
        console.log("Fetching available vehicles...");
        const vehicles = await Vehicle.findAll({
            where: { availableForRent: true },
            attributes: [
                'id','plate','makeModel','color','seats',
                'rentalPricePerHour','rentalPricePerDay',
                'rentalPricePerWeek','rentalPricePerMonth',
                'rentalCurrency','images'
            ],
            include: [
                { model: Account, as: 'partner', attributes: ['uuid','first_name','last_name','email','phone_e164'] },
                { model: VehicleCategory, as: 'category', attributes: ['id','name','slug','description'] }
            ]
        });
        console.log("Available vehicles found:", vehicles.length);
        res.json(vehicles);
    } catch (err) {
        console.error("Error in listAvailableVehicles:", err);
        next(err);
    }
}

/**
 * Passenger creates a rental request
 */
async function createRental(req, res, next) {
    try {
        console.log("Incoming rental request:", req.body);

        const { error, value } = createRentalSchema.validate(req.body, { stripUnknown: true });
        if (error) {
            console.log("Validation error in createRental:", error.details);
            return res.status(400).json({ error: error.details[0].message });
        }

        const vehicle = await Vehicle.findByPk(value.vehicleId, { include: 'partner' });
        console.log("Vehicle fetched:", vehicle ? vehicle.id : "Not found");

        if (!vehicle || !vehicle.availableForRent) {
            console.log("Vehicle not available for rental:", value.vehicleId);
            return res.status(400).json({ error: 'Vehicle not available for rental' });
        }

        // Prevent double booking
        const overlap = await VehicleRental.findOne({
            where: {
                vehicleId: value.vehicleId,
                status: { [Op.in]: ['PENDING','CONFIRMED'] },
                startDate: { [Op.lt]: value.endDate },
                endDate: { [Op.gt]: value.startDate }
            }
        });
        if (overlap) {
            console.log("Double booking detected:", overlap.id);
            return res.status(400).json({ error: 'Vehicle already booked for this period' });
        }

        // Price calculation
        const start = dayjs(value.startDate);
        const end = dayjs(value.endDate);
        let totalPrice = 0;

        if (value.rentalType === 'HOUR') {
            const hours = end.diff(start, 'hour');
            if (!vehicle.rentalPricePerHour) return res.status(400).json({ error: 'Hourly rental not available' });
            totalPrice = hours * parseFloat(vehicle.rentalPricePerHour);
        } else if (value.rentalType === 'DAY') {
            const days = end.diff(start, 'day');
            if (!vehicle.rentalPricePerDay) return res.status(400).json({ error: 'Daily rental not available' });
            totalPrice = days * parseFloat(vehicle.rentalPricePerDay);
        } else if (value.rentalType === 'WEEK') {
            const weeks = end.diff(start, 'week');
            if (!vehicle.rentalPricePerWeek) return res.status(400).json({ error: 'Weekly rental not available' });
            totalPrice = weeks * parseFloat(vehicle.rentalPricePerWeek);
        } else if (value.rentalType === 'MONTH') {
            const months = end.diff(start, 'month');
            if (!vehicle.rentalPricePerMonth) return res.status(400).json({ error: 'Monthly rental not available' });
            totalPrice = months * parseFloat(vehicle.rentalPricePerMonth);
        }

        console.log("Calculated total price:", totalPrice);

        if (totalPrice <= 0) return res.status(400).json({ error: 'Invalid rental duration' });

        const rental = await VehicleRental.create({
            id: uuidv4(),
            userId: value.userId,
            vehicleId: value.vehicleId,
            rentalType: value.rentalType,
            startDate: value.startDate,
            endDate: value.endDate,
            status: 'PENDING',
            totalPrice,
            paymentStatus: 'unpaid'
        });

        console.log("Rental created:", rental.toJSON());

        res.json({ message: 'Rental request submitted, awaiting admin approval', rental });
    } catch (err) {
        console.error("Error in createRental:", err);
        next(err);
    }
}

/**
 * Admin approves rental
 */
async function approveRental(req, res, next) {
    try {
        console.log("Admin attempting to approve rental:", req.params.id);
        const rental = await VehicleRental.findByPk(req.params.id, { include: Vehicle });
        if (!rental) return res.status(404).json({ error: 'Rental not found' });
        if (rental.status !== 'PENDING') return res.status(400).json({ error: 'Only pending rentals can be approved' });

        if (!req.user || req.user.user_type !== 'ADMIN') {
            console.log("Unauthorized rental approval attempt:", req.user);
            return res.status(403).json({ error: 'Only admins can approve rentals' });
        }

        rental.status = 'CONFIRMED';
        rental.approvedByAdminId = req.user.uuid;
        await rental.save();

        console.log("Rental approved:", rental.id);

        res.json({ message: 'Rental approved', rental });
    } catch (err) {
        console.error("Error in approveRental:", err);
        next(err);
    }
}

/**
 * Cancel rental (admin/system)
 */
async function cancelRental(req, res, next) {
    try {
        console.log("Cancelling rental:", req.params.id);
        const rental = await VehicleRental.findByPk(req.params.id);
        if (!rental) return res.status(404).json({ error: 'Rental not found' });

        rental.status = 'CANCELLED';
        await rental.save();

        console.log("Rental cancelled:", rental.id);

        res.json({ message: 'Rental cancelled', rental });
    } catch (err) {
        console.error("Error in cancelRental:", err);
        next(err);
    }
}

/**
 * User views their rentals
 */
async function listUserRentals(req, res, next) {
    try {
        console.log("Fetching rentals for user:", req.params.userId);
        const rentals = await VehicleRental.findAll({
            where: { userId: req.params.userId },
            include: [
                {
                    model: Vehicle,
                    attributes: ['id','plate','makeModel','color','images'],
                    include: [{ model: Account, as: 'partner', attributes: ['uuid','first_name','last_name','email'] }]
                }
            ]
        });
        console.log("User rentals found:", rentals.length);
        res.json(rentals);
    } catch (err) {
        console.error("Error in listUserRentals:", err);
        next(err);
    }
}


async function listAllRentals(req, res, next) {
    try {
        console.log("Admin fetching all rentals...");
        if (!req.user || req.user.user_type !== 'ADMIN') {
            console.log("Unauthorized attempt to view all rentals:", req.user);
            return res.status(403).json({ error: 'Only admins can view all rentals' });
        }

        const rentals = await VehicleRental.findAll({
            include: [
                {
                    model: Vehicle,
                    attributes: ['id','plate','makeModel','color','images'],
                    include: [{ model: Account, as: 'partner', attributes: ['uuid','first_name','last_name'] }]
                },
                { model: Account, as: 'user', attributes: ['uuid','first_name','last_name','email'] }
            ]
        });
        console.log("Total rentals found:", rentals.length);
        res.json(rentals);
    } catch (err) {
        console.error("Error in listAllRentals:", err);
        next(err);
    }
}

/**
 * List categories dynamically
 */
async function listCategories(req, res, next) {
    try {
        console.log("Fetching categories...");
        const categories = await VehicleCategory.findAll({
            where: { isActive: true },
            order: [['sortOrder','ASC']]
        });
        res.json(categories);
    } catch (err) {
        console.error("Error in listCategories:", err);
        next(err);
    }
}



module.exports = {
    createVehicle,
    listAvailableVehicles,
    createRental,
    approveRental,
    cancelRental,
    listUserRentals,
    listAllRentals,
    listCategories
};
