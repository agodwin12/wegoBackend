// src/controllers/backoffice/vehicleRentalController.js

const VehicleRental     = require('../../models/VehicleRental');
const Vehicle           = require('../../models/Vehicle');
const Account           = require('../../models/Account');
const PassengerProfile  = require('../../models/PassengerProfile');
const Employee          = require('../../models/Employee');
const { Op }            = require('sequelize');
const dayjs             = require('dayjs');

// ── Notification service (lazy — avoids circular dep at startup) ──────────────
const getNotificationService = () => require('../../services/NotificationService');

// ═══════════════════════════════════════════════════════════════════════
// HELPER: Calculate duration between dates
// ═══════════════════════════════════════════════════════════════════════

const calculateDuration = (startDate, endDate) => {
    try {
        const start   = new Date(startDate);
        const end     = new Date(endDate);
        const diffMs  = end - start;
        return {
            days:      Math.ceil(diffMs / (1000 * 60 * 60 * 24)),
            hours:     Math.ceil(diffMs / (1000 * 60 * 60)),
            weeks:     Math.ceil(diffMs / (1000 * 60 * 60 * 24 * 7)),
            months:    Math.ceil(diffMs / (1000 * 60 * 60 * 24 * 30)),
            isOverdue: new Date() > end,
        };
    } catch (error) {
        console.error('❌ Error calculating duration:', error);
        return { days: 0, hours: 0, weeks: 0, months: 0, isOverdue: false };
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET ALL VEHICLE RENTALS WITH FILTERS
// ═══════════════════════════════════════════════════════════════════════

exports.getAllRentals = async (req, res) => {
    try {
        console.log('📥 Fetching vehicle rentals...');

        const {
            page = 1, limit = 10,
            status, paymentStatus, rentalType, search,
            sortBy = 'created_at', sortOrder = 'DESC',
            startDate, endDate, isOverdue, pickupsToday, returnsToday,
        } = req.query;

        const offset = (parseInt(page) - 1) * parseInt(limit);
        const where  = {};

        if (status)        where.status        = status;
        if (paymentStatus) where.payment_status = paymentStatus;
        if (rentalType)    where.rental_type    = rentalType;
        if (startDate)     where.start_date     = { [Op.gte]: new Date(startDate) };
        if (endDate)       where.end_date       = { [Op.lte]: new Date(endDate) };

        if (pickupsToday === 'true') {
            const today    = new Date(); today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
            where.start_date = { [Op.gte]: today, [Op.lt]: tomorrow };
        }

        if (returnsToday === 'true') {
            const today    = new Date(); today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
            where.end_date = { [Op.gte]: today, [Op.lt]: tomorrow };
        }

        if (isOverdue === 'true') {
            where.end_date = { [Op.lt]: new Date() };
            where.status   = { [Op.in]: ['PENDING', 'CONFIRMED'] };
        }

        const vehicleInclude = {
            model:      Vehicle,
            as:         'vehicle',
            attributes: ['id', 'plate', 'make_model', 'year', 'color', 'images', 'region', 'seats'],
            required:   false,
        };

        if (search) {
            vehicleInclude.where = {
                [Op.or]: [
                    { plate:      { [Op.like]: `%${search}%` } },
                    { make_model: { [Op.like]: `%${search}%` } },
                ],
            };
            vehicleInclude.required = true;
        }

        const include = [
            vehicleInclude,
            {
                model:      Account,
                as:         'user',
                attributes: ['uuid', 'email'],
                required:   false,
                include:    [{ model: PassengerProfile, as: 'passenger_profile', required: false }],
            },
            {
                model:      Account,
                as:         'approvedByAdmin',
                attributes: ['uuid', 'email'],
                required:   false,
            },
        ];

        const { count, rows } = await VehicleRental.findAndCountAll({
            where,
            include,
            limit:    parseInt(limit),
            offset,
            order:    [[sortBy, sortOrder]],
            distinct: true,
        });

        console.log(`✅ Found ${count} vehicle rentals, returning ${rows.length} rows`);

        const rentalsWithDuration = rows.map(rental => {
            const r        = rental.toJSON();
            r.duration     = calculateDuration(r.startDate, r.endDate);
            return r;
        });

        return res.status(200).json({
            success:    true,
            data:       rentalsWithDuration,
            pagination: { total: count, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(count / parseInt(limit)) },
        });

    } catch (error) {
        console.error('❌ Error fetching vehicle rentals:', error);
        return res.status(500).json({ success: false, message: 'Error fetching vehicle rentals', error: error.message });
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
                    model:      Vehicle,
                    as:         'vehicle',
                    attributes: ['id', 'plate', 'make_model', 'year', 'color', 'region', 'seats', 'transmission', 'fuel_type', 'images', 'insurance_document', 'permit_document'],
                },
                {
                    model:      Account,
                    as:         'user',
                    attributes: ['uuid', 'email'],
                    include:    [{ model: PassengerProfile, as: 'passenger_profile' }],
                },
                { model: Account, as: 'approvedByAdmin', attributes: ['uuid', 'email'] },
            ],
        });

        if (!rental) return res.status(404).json({ success: false, message: 'Vehicle rental not found' });

        const duration = calculateDuration(rental.start_date, rental.end_date);

        return res.status(200).json({
            success: true,
            data:    { ...rental.toJSON(), duration },
        });

    } catch (error) {
        console.error('❌ Error fetching rental:', error);
        return res.status(500).json({ success: false, message: 'Error fetching rental', error: error.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// UPDATE RENTAL STATUS
// ═══════════════════════════════════════════════════════════════════════

exports.updateRentalStatus = async (req, res) => {
    try {
        const { id }             = req.params;
        const { status, reason } = req.body;

        const validStatuses = ['PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ success: false, message: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
        }

        const rental = await VehicleRental.findByPk(id, {
            include: [{ model: Vehicle, as: 'vehicle', attributes: ['id', 'makeModel', 'plate'] }],
        });
        if (!rental) return res.status(404).json({ success: false, message: 'Vehicle rental not found' });

        const previousStatus = rental.status;
        rental.status = status;

        if (status === 'CONFIRMED' && !rental.approvedByAdminId) {
            rental.approvedByAdminId = req.user?.accountId || null;
        }

        if (status === 'CANCELLED' && reason) {
            rental.cancellationReason = reason;
        }

        await rental.save();

        console.log(`✅ [BACKOFFICE RENTAL] Rental ${id}: ${previousStatus} → ${status}`);

        // ── 🔔 NOTIFICATION: Rental approved → passenger ─────────────────────
        if (status === 'CONFIRMED' && previousStatus !== 'CONFIRMED') {
            const makeModel  = rental.vehicle?.makeModel || 'Your rental vehicle';
            const plate      = rental.vehicle?.plate     || '';
            const startDate  = dayjs(rental.startDate).format('DD MMM YYYY [at] HH:mm');
            const vehicleStr = plate ? `${makeModel} (${plate})` : makeModel;

            getNotificationService().send({
                accountUuid: rental.userId,
                type:        'RENTAL_APPROVED',
                title:       '🚗 Rental booking confirmed!',
                body:        `${vehicleStr} is confirmed from ${startDate}. Total: ${rental.totalPrice?.toLocaleString()} XAF.`,
                data: {
                    screen:    'rental_detail',
                    rental_id: String(rental.id),
                    start_date: String(rental.startDate),
                    end_date:   String(rental.endDate),
                    total:      String(rental.totalPrice || 0),
                },
            }).catch(e => console.warn('⚠️  [BACKOFFICE RENTAL] Approval push failed:', e.message));
        }

        return res.status(200).json({ success: true, message: 'Rental status updated successfully', data: rental });

    } catch (error) {
        console.error('❌ Error updating rental status:', error);
        return res.status(500).json({ success: false, message: 'Error updating rental status', error: error.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// UPDATE PAYMENT STATUS
// ═══════════════════════════════════════════════════════════════════════

exports.updatePaymentStatus = async (req, res) => {
    try {
        const { id }                                         = req.params;
        const { paymentStatus, paymentMethod, transactionRef } = req.body;

        const validStatuses = ['unpaid', 'paid', 'refunded'];
        if (!validStatuses.includes(paymentStatus)) {
            return res.status(400).json({ success: false, message: `Invalid payment status. Must be one of: ${validStatuses.join(', ')}` });
        }

        const rental = await VehicleRental.findByPk(id);
        if (!rental) return res.status(404).json({ success: false, message: 'Vehicle rental not found' });

        rental.paymentStatus = paymentStatus;
        if (paymentMethod)  rental.paymentMethod  = paymentMethod;
        if (transactionRef) rental.transactionRef = transactionRef;
        await rental.save();

        console.log(`✅ Rental ${id} payment status updated to ${paymentStatus}`);

        return res.status(200).json({ success: true, message: 'Payment status updated successfully', data: rental });

    } catch (error) {
        console.error('❌ Error updating payment status:', error);
        return res.status(500).json({ success: false, message: 'Error updating payment status', error: error.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// ADD NOTES
// ═══════════════════════════════════════════════════════════════════════

exports.addNotes = async (req, res) => {
    try {
        const { id }    = req.params;
        const { notes } = req.body;

        if (!notes?.trim()) return res.status(400).json({ success: false, message: 'Notes are required' });

        const rental = await VehicleRental.findByPk(id);
        if (!rental) return res.status(404).json({ success: false, message: 'Vehicle rental not found' });

        rental.adminNotes = notes;
        await rental.save();

        return res.status(200).json({ success: true, message: 'Notes added successfully', data: rental });

    } catch (error) {
        console.error('❌ Error adding notes:', error);
        return res.status(500).json({ success: false, message: 'Error adding notes', error: error.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// DELETE RENTAL
// ═══════════════════════════════════════════════════════════════════════

exports.deleteRental = async (req, res) => {
    try {
        const { id } = req.params;
        const rental = await VehicleRental.findByPk(id);
        if (!rental) return res.status(404).json({ success: false, message: 'Vehicle rental not found' });

        await rental.destroy();

        return res.status(200).json({ success: true, message: 'Rental deleted successfully' });

    } catch (error) {
        console.error('❌ Error deleting rental:', error);
        return res.status(500).json({ success: false, message: 'Error deleting rental', error: error.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET RENTAL STATS
// ═══════════════════════════════════════════════════════════════════════

exports.getRentalStats = async (req, res) => {
    try {
        const today    = new Date(); today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);

        const [
            totalRentals, pendingRentals, confirmedRentals,
            completedRentals, cancelledRentals,
            unpaidRentals, paidRentals,
            todayPickups, todayReturns, overdueRentals,
        ] = await Promise.all([
            VehicleRental.count(),
            VehicleRental.count({ where: { status: 'PENDING' } }),
            VehicleRental.count({ where: { status: 'CONFIRMED' } }),
            VehicleRental.count({ where: { status: 'COMPLETED' } }),
            VehicleRental.count({ where: { status: 'CANCELLED' } }),
            VehicleRental.count({ where: { payment_status: 'unpaid' } }),
            VehicleRental.count({ where: { payment_status: 'paid' } }),
            VehicleRental.count({ where: { start_date: { [Op.gte]: today, [Op.lt]: tomorrow } } }),
            VehicleRental.count({ where: { end_date: { [Op.gte]: today, [Op.lt]: tomorrow } } }),
            VehicleRental.count({ where: { end_date: { [Op.lt]: new Date() }, status: { [Op.in]: ['PENDING', 'CONFIRMED'] } } }),
        ]);

        return res.status(200).json({
            success: true,
            data: {
                total: totalRentals, pending: pendingRentals, confirmed: confirmedRentals,
                completed: completedRentals, cancelled: cancelledRentals,
                unpaid: unpaidRentals, paid: paidRentals,
                todayPickups, todayReturns, overdue: overdueRentals,
            },
        });

    } catch (error) {
        console.error('❌ Error fetching rental stats:', error);
        return res.status(500).json({ success: false, message: 'Error fetching rental statistics', error: error.message });
    }
};

module.exports = exports;