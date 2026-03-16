// src/controllers/backoffice/deliveryHistory.controller.js

const { Op } = require('sequelize');
const { Delivery, Account, Driver, DeliveryDispute } = require('../../models');

// ═══════════════════════════════════════════════════════════════════════════════
// GET DELIVERY HISTORY
// GET /api/backoffice/delivery/history
// ═══════════════════════════════════════════════════════════════════════════════
exports.getHistory = async (req, res) => {
    try {
        const {
            page             = 1,
            limit            = 20,
            search           = '',
            status           = '',
            payment_method   = '',
            package_size     = '',
            package_category = '',
            start_date       = '',
            end_date         = '',
        } = req.query;

        const offset = (parseInt(page) - 1) * parseInt(limit);
        const where  = {};

        if (status)           where.status           = status;
        if (payment_method)   where.payment_method   = payment_method;
        if (package_size)     where.package_size     = package_size;
        if (package_category) where.package_category = package_category;

        if (start_date || end_date) {
            where.created_at = {};
            if (start_date) where.created_at[Op.gte] = new Date(start_date);
            if (end_date)   where.created_at[Op.lte] = new Date(new Date(end_date).setHours(23, 59, 59));
        }

        if (search) {
            where[Op.or] = [
                { delivery_code:   { [Op.like]: `%${search}%` } },
                { recipient_name:  { [Op.like]: `%${search}%` } },
                { recipient_phone: { [Op.like]: `%${search}%` } },
                { pickup_address:  { [Op.like]: `%${search}%` } },
                { dropoff_address: { [Op.like]: `%${search}%` } },
            ];
        }

        const { count, rows } = await Delivery.findAndCountAll({
            where,
            include: [
                {
                    model:      Account,
                    as:         'sender',
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164'],
                    required:   false,
                },
                {
                    model:      Driver,
                    as:         'driver',
                    attributes: ['id', 'userId'],
                    required:   false,
                    include: [{
                        model:      Account,
                        as:         'account',
                        attributes: ['first_name', 'last_name'],
                        required:   false,
                    }],
                },
                {
                    model:      DeliveryDispute,
                    as:         'dispute',
                    attributes: ['id', 'dispute_code', 'status', 'priority'],
                    required:   false,
                },
            ],
            order:    [['created_at', 'DESC']],
            limit:    parseInt(limit),
            offset,
            distinct: true,
        });

        const deliveries = rows.map(d => ({
            id:                       d.id,
            delivery_code:            d.delivery_code,
            status:                   d.status,
            payment_method:           d.payment_method,
            payment_status:           d.payment_status,
            package_size:             d.package_size,
            package_category:         d.package_category,
            package_description:      d.package_description,
            package_photo_url:        d.package_photo_url,
            pickup_photo_url:         d.pickup_photo_url,
            is_fragile:               d.is_fragile,
            pickup_address:           d.pickup_address,
            pickup_landmark:          d.pickup_landmark,
            dropoff_address:          d.dropoff_address,
            dropoff_landmark:         d.dropoff_landmark,
            recipient_name:           d.recipient_name,
            recipient_phone:          d.recipient_phone,
            recipient_note:           d.recipient_note,
            total_price:              parseFloat(d.total_price),
            commission_amount:        parseFloat(d.commission_amount),
            driver_payout:            parseFloat(d.driver_payout),
            distance_km:              parseFloat(d.distance_km),
            surge_multiplier_applied: parseFloat(d.surge_multiplier_applied),
            created_at:               d.created_at,
            accepted_at:              d.accepted_at,
            picked_up_at:             d.picked_up_at,
            delivered_at:             d.delivered_at,
            cancelled_at:             d.cancelled_at,
            cancellation_reason:      d.cancellation_reason,
            rating:                   d.rating ? parseFloat(d.rating) : null,
            rating_comment:           d.rating_comment,
            senderName: d.sender
                ? `${d.sender.first_name} ${d.sender.last_name}`.trim()
                : 'Unknown',
            driverName: d.driver?.account
                ? `${d.driver.account.first_name} ${d.driver.account.last_name}`.trim()
                : 'Unassigned',
            hasDispute: !!d.dispute,
            dispute: d.dispute ? {
                id:           d.dispute.id,
                dispute_code: d.dispute.dispute_code,
                status:       d.dispute.status,
                priority:     d.dispute.priority,
            } : null,
        }));

        return res.json({
            success: true,
            deliveries,
            pagination: {
                total:      count,
                page:       parseInt(page),
                limit:      parseInt(limit),
                totalPages: Math.ceil(count / parseInt(limit)),
            },
        });

    } catch (error) {
        console.error('❌ [DELIVERY HISTORY] getHistory error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch delivery history' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET STATS
// GET /api/backoffice/delivery/history/stats
// ═══════════════════════════════════════════════════════════════════════════════
exports.getStats = async (req, res) => {
    try {
        const { start_date = '', end_date = '' } = req.query;

        const where = {};
        if (start_date || end_date) {
            where.created_at = {};
            if (start_date) where.created_at[Op.gte] = new Date(start_date);
            if (end_date)   where.created_at[Op.lte] = new Date(new Date(end_date).setHours(23, 59, 59));
        }

        const [
            total, delivered, cancelled, disputed, expired,
            totalRevenue, totalCommission,
            cashCount, mtnCount, orangeCount,
        ] = await Promise.all([
            Delivery.count({ where }),
            Delivery.count({ where: { ...where, status: 'delivered' } }),
            Delivery.count({ where: { ...where, status: 'cancelled' } }),
            Delivery.count({ where: { ...where, status: 'disputed'  } }),
            Delivery.count({ where: { ...where, status: 'expired'   } }),
            Delivery.sum('total_price',       { where: { ...where, status: 'delivered' } }),
            Delivery.sum('commission_amount', { where: { ...where, status: 'delivered' } }),
            Delivery.count({ where: { ...where, payment_method: 'cash'             } }),
            Delivery.count({ where: { ...where, payment_method: 'mtn_mobile_money' } }),
            Delivery.count({ where: { ...where, payment_method: 'orange_money'     } }),
        ]);

        return res.json({
            success: true,
            stats: {
                total,
                delivered,
                cancelled,
                disputed,
                expired,
                completionRate:  total > 0 ? Math.round((delivered / total) * 100) : 0,
                totalRevenue:    totalRevenue    || 0,
                totalCommission: totalCommission || 0,
                paymentMethods:  { cash: cashCount, mtn: mtnCount, orange: orangeCount },
            },
        });

    } catch (error) {
        console.error('❌ [DELIVERY HISTORY] getStats error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch stats' });
    }
};