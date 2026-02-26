// wegobackend/src/controllers/backoffice/vehicleRentalController.js

const VehicleRental = require('../../models/VehicleRental');
const Vehicle = require('../../models/Vehicle');
const Account = require('../../models/Account');
const PassengerProfile = require('../../models/PassengerProfile');
const Employee = require('../../models/Employee');
const { Op } = require('sequelize');

// ═══════════════════════════════════════════════════════════════════════
// HELPER: Calculate duration between dates
// ═══════════════════════════════════════════════════════════════════════

const calculateDuration = (startDate, endDate) => {
    try {
        const start = new Date(startDate);
        const end = new Date(endDate);
        const diffMs = end - start;
        const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
        const diffHours = Math.ceil(diffMs / (1000 * 60 * 60));
        const diffWeeks = Math.ceil(diffDays / 7);
        const diffMonths = Math.ceil(diffDays / 30);

        return {
            days: diffDays,
            hours: diffHours,
            weeks: diffWeeks,
            months: diffMonths,
            isOverdue: new Date() > end
        };
    } catch (error) {
        console.error('❌ Error calculating duration:', error);
        return {
            days: 0,
            hours: 0,
            weeks: 0,
            months: 0,
            isOverdue: false
        };
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET ALL VEHICLE RENTALS WITH FILTERS
// ═══════════════════════════════════════════════════════════════════════

exports.getAllRentals = async (req, res) => {
    try {
        console.log('📥 Fetching vehicle rentals...');

        const {
            page = 1,
            limit = 10,
            status,
            paymentStatus,
            rentalType,
            search,
            sortBy = 'created_at',
            sortOrder = 'DESC',
            startDate,
            endDate,
            isOverdue,
            pickupsToday,
            returnsToday
        } = req.query;

        const offset = (parseInt(page) - 1) * parseInt(limit);
        const where = {};

        if (status) where.status = status;
        if (paymentStatus) where.payment_status = paymentStatus;
        if (rentalType) where.rental_type = rentalType;

        // Date filters
        if (startDate) where.start_date = { [Op.gte]: new Date(startDate) };
        if (endDate) where.end_date = { [Op.lte]: new Date(endDate) };

        // Pickups today filter
        if (pickupsToday === 'true') {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);
            where.start_date = { [Op.gte]: today, [Op.lt]: tomorrow };
        }

        // Returns today filter
        if (returnsToday === 'true') {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);
            where.end_date = { [Op.gte]: today, [Op.lt]: tomorrow };
        }

        // Overdue filter
        if (isOverdue === 'true') {
            where.end_date = { [Op.lt]: new Date() };
            where.status = { [Op.in]: ['PENDING', 'CONFIRMED'] };
        }

        console.log('🔍 Query where:', JSON.stringify(where, null, 2));

        // Build include with search
        const vehicleInclude = {
            model: Vehicle,
            as: 'vehicle',
            attributes: ['id', 'plate', 'make_model', 'year', 'color', 'images', 'region', 'seats'],
            required: false
        };

        if (search) {
            vehicleInclude.where = {
                [Op.or]: [
                    { plate: { [Op.like]: `%${search}%` } },
                    { make_model: { [Op.like]: `%${search}%` } }
                ]
            };
            vehicleInclude.required = true;
        }

        const include = [
            vehicleInclude,
            {
                model: Account,
                as: 'user',
                attributes: ['uuid', 'email'],
                required: false,
                include: [
                    {
                        model: PassengerProfile,
                        as: 'passenger_profile',
                        // ✅ NO attributes specified - let Sequelize auto-map everything
                        required: false
                    }
                ]
            },
            {
                model: Account,
                as: 'approvedByAdmin',
                attributes: ['uuid', 'email'],
                required: false
            }
        ];

        console.log('📊 Executing query...');

        const { count, rows } = await VehicleRental.findAndCountAll({
            where,
            include,
            limit: parseInt(limit),
            offset,
            order: [[sortBy, sortOrder]],
            distinct: true
        });

        console.log(`✅ Found ${count} vehicle rentals, returning ${rows.length} rows`);

        // Calculate duration for each rental
        const rentalsWithDuration = rows.map(rental => {
            const rentalJSON = rental.toJSON();
            const duration = calculateDuration(rentalJSON.startDate, rentalJSON.endDate);
            return {
                ...rentalJSON,
                duration
            };
        });

        res.status(200).json({
            success: true,
            data: rentalsWithDuration,
            pagination: {
                total: count,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(count / parseInt(limit))
            }
        });

    } catch (error) {
        console.error('❌ Error fetching vehicle rentals:', error);
        console.error('❌ Error stack:', error.stack);
        res.status(500).json({
            success: false,
            message: 'Error fetching vehicle rentals',
            error: error.message,
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET SINGLE RENTAL BY ID
// ═══════════════════════════════════════════════════════════════════════

exports.getRentalById = async (req, res) => {
    try {
        const { id } = req.params;

        const rental = await VehicleRental.findByPk(id, {
            include: [
                {
                    model: Vehicle,
                    as: 'vehicle',
                    attributes: ['id', 'plate', 'make_model', 'year', 'color', 'region', 'seats', 'transmission', 'fuel_type', 'images', 'insurance_document', 'permit_document']
                },
                {
                    model: Account,
                    as: 'user',
                    attributes: ['uuid', 'email'],
                    include: [
                        {
                            model: PassengerProfile,
                            as: 'passenger_profile',
                            // ✅ NO attributes specified - let Sequelize auto-map everything
                        }
                    ]
                },
                {
                    model: Account,
                    as: 'approvedByAdmin',
                    attributes: ['uuid', 'email']
                }
            ]
        });

        if (!rental) {
            return res.status(404).json({
                success: false,
                message: 'Vehicle rental not found'
            });
        }

        const duration = calculateDuration(rental.start_date, rental.end_date);

        console.log('✅ Rental found:', rental.id);

        res.status(200).json({
            success: true,
            data: {
                ...rental.toJSON(),
                duration
            }
        });

    } catch (error) {
        console.error('❌ Error fetching rental:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching rental',
            error: error.message
        });
    }
};



exports.updateRentalStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status, reason } = req.body;

        const validStatuses = ['PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
            });
        }

        const rental = await VehicleRental.findByPk(id);

        if (!rental) {
            return res.status(404).json({
                success: false,
                message: 'Vehicle rental not found'
            });
        }

        rental.status = status;

        // ✅ Use camelCase - Sequelize will convert to snake_case
        if (status === 'CONFIRMED' && !rental.approvedByAdminId) {
            rental.approvedByAdminId = req.user.accountId;
        }

        if (status === 'CANCELLED' && reason) {
            rental.cancellationReason = reason;
        }

        await rental.save();

        console.log(`✅ Rental ${id} status updated to ${status}`);

        res.status(200).json({
            success: true,
            message: 'Rental status updated successfully',
            data: rental
        });

    } catch (error) {
        console.error('❌ Error updating rental status:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating rental status',
            error: error.message
        });
    }
};



exports.updatePaymentStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { paymentStatus, paymentMethod, transactionRef } = req.body;

        const validStatuses = ['unpaid', 'paid', 'refunded'];
        if (!validStatuses.includes(paymentStatus)) {
            return res.status(400).json({
                success: false,
                message: `Invalid payment status. Must be one of: ${validStatuses.join(', ')}`
            });
        }

        const rental = await VehicleRental.findByPk(id);

        if (!rental) {
            return res.status(404).json({
                success: false,
                message: 'Vehicle rental not found'
            });
        }

        // ✅ Use camelCase - Sequelize will convert to snake_case
        rental.paymentStatus = paymentStatus;
        if (paymentMethod) rental.paymentMethod = paymentMethod;
        if (transactionRef) rental.transactionRef = transactionRef;

        await rental.save();

        console.log(`✅ Rental ${id} payment status updated to ${paymentStatus}`);
        console.log(`✅ Updated rental data:`, rental.toJSON());

        res.status(200).json({
            success: true,
            message: 'Payment status updated successfully',
            data: rental
        });

    } catch (error) {
        console.error('❌ Error updating payment status:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating payment status',
            error: error.message
        });
    }
};


exports.addNotes = async (req, res) => {
    try {
        const { id } = req.params;
        const { notes } = req.body;

        if (!notes || !notes.trim()) {
            return res.status(400).json({
                success: false,
                message: 'Notes are required'
            });
        }

        const rental = await VehicleRental.findByPk(id);

        if (!rental) {
            return res.status(404).json({
                success: false,
                message: 'Vehicle rental not found'
            });
        }

        // ✅ Use camelCase - Sequelize will convert to snake_case
        rental.adminNotes = notes;
        await rental.save();

        console.log(`✅ Notes added to rental ${id}`);

        res.status(200).json({
            success: true,
            message: 'Notes added successfully',
            data: rental
        });

    } catch (error) {
        console.error('❌ Error adding notes:', error);
        res.status(500).json({
            success: false,
            message: 'Error adding notes',
            error: error.message
        });
    }
};


exports.deleteRental = async (req, res) => {
    try {
        const { id } = req.params;

        const rental = await VehicleRental.findByPk(id);

        if (!rental) {
            return res.status(404).json({
                success: false,
                message: 'Vehicle rental not found'
            });
        }

        await rental.destroy();

        console.log(`✅ Rental ${id} deleted`);

        res.status(200).json({
            success: true,
            message: 'Rental deleted successfully'
        });

    } catch (error) {
        console.error('❌ Error deleting rental:', error);
        res.status(500).json({
            success: false,
            message: 'Error deleting rental',
            error: error.message
        });
    }
};

exports.getRentalStats = async (req, res) => {
    try {
        const totalRentals = await VehicleRental.count();
        const pendingRentals = await VehicleRental.count({ where: { status: 'PENDING' } });
        const confirmedRentals = await VehicleRental.count({ where: { status: 'CONFIRMED' } });
        const completedRentals = await VehicleRental.count({ where: { status: 'COMPLETED' } });
        const cancelledRentals = await VehicleRental.count({ where: { status: 'CANCELLED' } });

        const unpaidRentals = await VehicleRental.count({ where: { payment_status: 'unpaid' } });
        const paidRentals = await VehicleRental.count({ where: { payment_status: 'paid' } });

        // Today's pickups
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const todayPickups = await VehicleRental.count({
            where: {
                start_date: { [Op.gte]: today, [Op.lt]: tomorrow }
            }
        });

        const todayReturns = await VehicleRental.count({
            where: {
                end_date: { [Op.gte]: today, [Op.lt]: tomorrow }
            }
        });

        // Overdue rentals
        const overdueRentals = await VehicleRental.count({
            where: {
                end_date: { [Op.lt]: new Date() },
                status: { [Op.in]: ['PENDING', 'CONFIRMED'] }
            }
        });

        const stats = {
            total: totalRentals,
            pending: pendingRentals,
            confirmed: confirmedRentals,
            completed: completedRentals,
            cancelled: cancelledRentals,
            unpaid: unpaidRentals,
            paid: paidRentals,
            todayPickups,
            todayReturns,
            overdue: overdueRentals
        };

        console.log('✅ Rental statistics:', stats);

        res.status(200).json({
            success: true,
            data: stats
        });

    } catch (error) {
        console.error('❌ Error fetching rental stats:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching rental statistics',
            error: error.message
        });
    }
};

module.exports = exports;