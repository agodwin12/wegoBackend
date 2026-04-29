
'use strict';

const { Op }    = require('sequelize');
const { Delivery, Driver, DeliveryWalletTransaction } = require('../../models');

// ─── Category metadata (emoji + label) ───────────────────────────────────────
const CATEGORY_META = {
    document:    { emoji: '📄', label: 'Document' },
    food:        { emoji: '🍱', label: 'Food & Drinks' },
    electronics: { emoji: '📱', label: 'Electronics' },
    clothing:    { emoji: '👕', label: 'Clothing' },
    medicine:    { emoji: '💊', label: 'Medicine' },
    fragile:     { emoji: '🏺', label: 'Fragile Item' },
    groceries:   { emoji: '🛒', label: 'Groceries' },
    other:       { emoji: '📦', label: 'Other' },
};

function categoryMeta(key) {
    return CATEGORY_META[key] || { emoji: '📦', label: key || 'Other' };
}

function trackingMode(deliveryType) {
    return deliveryType === 'express' ? 'live_map' : 'stage_updates';
}

// ─── Duration helper ──────────────────────────────────────────────────────────
function durationMinutes(acceptedAt, deliveredAt) {
    if (!acceptedAt || !deliveredAt) return null;
    return Math.round((new Date(deliveredAt) - new Date(acceptedAt)) / 60000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET HISTORY
// GET /api/deliveries/agent/history
//
// Query params:
//   page            {number}   default 1
//   limit           {number}   default 15 (max 50)
//   status          {string}   filter by single status
//   delivery_type   {string}   'regular' | 'express'
//   payment_method  {string}   'cash' | 'mtn_mobile_money' | 'orange_money'
//   from            {string}   ISO date — start of range (inclusive)
//   to              {string}   ISO date — end of range (inclusive)
// ═══════════════════════════════════════════════════════════════════════════════

exports.getHistory = async (req, res) => {
    try {
        const accountUuid = req.user.uuid;

        // ── Resolve Driver record ─────────────────────────────────────────────
        const driver = await Driver.findOne({
            where:      { userId: accountUuid },
            attributes: ['id', 'userId', 'rating'],
        });
        if (!driver) {
            return res.status(404).json({ success: false, message: 'Driver record not found' });
        }

        // ── Parse query params ────────────────────────────────────────────────
        const page   = Math.max(1, parseInt(req.query.page)  || 1);
        const limit  = Math.min(50, parseInt(req.query.limit) || 15);
        const offset = (page - 1) * limit;

        const { status, delivery_type, payment_method, from, to } = req.query;

        // ── Build where clause ────────────────────────────────────────────────
        const where = { driver_id: driver.id };

        if (status) {
            const validStatuses = [
                'accepted', 'en_route_pickup', 'arrived_pickup', 'picked_up',
                'en_route_dropoff', 'arrived_dropoff', 'delivered',
                'cancelled', 'disputed', 'expired',
            ];
            if (!validStatuses.includes(status)) {
                return res.status(400).json({
                    success: false,
                    message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
                });
            }
            where.status = status;
        } else {
            // Default: all terminal + active statuses (exclude 'searching' — driver never sees that)
            where.status = {
                [Op.in]: [
                    'accepted', 'en_route_pickup', 'arrived_pickup', 'picked_up',
                    'en_route_dropoff', 'arrived_dropoff', 'delivered',
                    'cancelled', 'disputed', 'expired',
                ],
            };
        }

        if (delivery_type) {
            if (!['regular', 'express'].includes(delivery_type)) {
                return res.status(400).json({ success: false, message: "delivery_type must be 'regular' or 'express'" });
            }
            where.delivery_type = delivery_type;
        }

        if (payment_method) {
            if (!['cash', 'mtn_mobile_money', 'orange_money'].includes(payment_method)) {
                return res.status(400).json({ success: false, message: 'Invalid payment_method filter' });
            }
            where.payment_method = payment_method;
        }

        if (from || to) {
            where.created_at = {};
            if (from) where.created_at[Op.gte] = new Date(from);
            if (to) {
                // Include the full 'to' day
                const toDate = new Date(to);
                toDate.setHours(23, 59, 59, 999);
                where.created_at[Op.lte] = toDate;
            }
        }

        // ── Fetch deliveries ──────────────────────────────────────────────────
        const { count, rows } = await Delivery.findAndCountAll({
            where,
            include: [
                {
                    association: 'sender',
                    attributes:  ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'],
                },
            ],
            order:  [['created_at', 'DESC']],
            limit,
            offset,
        });

        // ── Shape each delivery ───────────────────────────────────────────────
        const deliveries = rows.map(d => {
            const meta = categoryMeta(d.package_category);

            // Earnings summary per delivery
            const isDelivered = d.status === 'delivered';
            const isCash      = d.payment_method === 'cash';

            const earningsSummary = isDelivered ? {
                driverPayout:     parseFloat(d.driver_payout),
                commissionAmount: parseFloat(d.commission_amount),
                totalPrice:       parseFloat(d.total_price),
                paymentMethod:    d.payment_method,
                // For cash: agent collected totalPrice, owes commissionAmount to WEGO
                // For digital: driverPayout was credited to wallet
                cashCollected:    isCash ? parseFloat(d.total_price) : 0,
                cashOwedToWego:   isCash ? parseFloat(d.commission_amount) : 0,
                walletCredited:   !isCash ? parseFloat(d.driver_payout) : 0,
            } : null;

            return {
                id:           d.id,
                deliveryCode: d.delivery_code,
                deliveryType: d.delivery_type,
                trackingMode: trackingMode(d.delivery_type),
                status:       d.status,

                // Package
                packageSize:        d.package_size,
                packageCategory:    d.package_category,
                categoryLabel:      meta.label,
                categoryEmoji:      meta.emoji,
                packagePhotoUrl:    d.package_photo_url,
                isFragile:          d.is_fragile,

                // Route
                pickup: {
                    address:  d.pickup_address,
                    lat:      parseFloat(d.pickup_latitude),
                    lng:      parseFloat(d.pickup_longitude),
                    landmark: d.pickup_landmark,
                },
                dropoff: {
                    address:  d.dropoff_address,
                    lat:      parseFloat(d.dropoff_latitude),
                    lng:      parseFloat(d.dropoff_longitude),
                    landmark: d.dropoff_landmark,
                },
                distanceKm: parseFloat(d.distance_km),

                // Recipient
                recipientName:  d.recipient_name,
                recipientPhone: d.recipient_phone,
                recipientNote:  d.recipient_note,

                // Sender (who booked)
                sender: d.sender ? {
                    name:   `${d.sender.first_name || ''} ${d.sender.last_name || ''}`.trim(),
                    phone:  d.sender.phone_e164,
                    avatar: d.sender.avatar_url,
                } : null,

                // Pricing
                totalPrice:      parseFloat(d.total_price),
                driverPayout:    parseFloat(d.driver_payout),
                commissionAmount: parseFloat(d.commission_amount),
                paymentMethod:   d.payment_method,
                paymentStatus:   d.payment_status,

                // Surge
                isSurging:       parseFloat(d.surge_multiplier_applied) > 1.00,
                surgeMultiplier: parseFloat(d.surge_multiplier_applied),

                // Earnings breakdown (only for delivered)
                earnings: earningsSummary,

                // Cancellation info
                cancelledBy:        d.cancelled_by        || null,
                cancellationReason: d.cancellation_reason || null,

                // Timing
                durationMinutes: durationMinutes(d.accepted_at, d.delivered_at),
                acceptedAt:      d.accepted_at      || null,
                arrivedPickupAt: d.arrived_pickup_at || null,
                pickedUpAt:      d.picked_up_at      || null,
                deliveredAt:     d.delivered_at      || null,
                cancelledAt:     d.cancelled_at      || null,
                createdAt:       d.created_at,
            };
        });

        // ── Aggregated summary for the filtered period ────────────────────────
        const delivered   = rows.filter(d => d.status === 'delivered');
        const cancelled   = rows.filter(d => d.status === 'cancelled');
        const cashDeliveries    = delivered.filter(d => d.payment_method === 'cash');
        const digitalDeliveries = delivered.filter(d => d.payment_method !== 'cash');

        const summary = {
            totalDeliveries:    count,
            delivered:          delivered.length,
            cancelled:          cancelled.length,
            totalEarnings:      delivered.reduce((s, d) => s + parseFloat(d.driver_payout), 0),
            cashCollected:      cashDeliveries.reduce((s, d) => s + parseFloat(d.total_price), 0),
            cashOwedToWego:     cashDeliveries.reduce((s, d) => s + parseFloat(d.commission_amount), 0),
            walletCredited:     digitalDeliveries.reduce((s, d) => s + parseFloat(d.driver_payout), 0),
            totalCommission:    delivered.reduce((s, d) => s + parseFloat(d.commission_amount), 0),
            avgDurationMinutes: delivered.length > 0
                ? Math.round(
                    delivered
                        .map(d => durationMinutes(d.accepted_at, d.delivered_at))
                        .filter(Boolean)
                        .reduce((s, n) => s + n, 0) / delivered.length
                )
                : null,
        };

        return res.json({
            success: true,
            summary,
            deliveries,
            pagination: {
                total:      count,
                page,
                limit,
                totalPages: Math.ceil(count / limit),
            },
            filters: {
                status:         status         || null,
                delivery_type:  delivery_type  || null,
                payment_method: payment_method || null,
                from:           from           || null,
                to:             to             || null,
            },
        });

    } catch (error) {
        console.error('❌ [AGENT HISTORY] getHistory error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch delivery history' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET SINGLE DELIVERY DETAIL
// GET /api/deliveries/agent/history/:id
// ═══════════════════════════════════════════════════════════════════════════════

exports.getDetail = async (req, res) => {
    try {
        const accountUuid = req.user.uuid;
        const deliveryId  = parseInt(req.params.id);

        const driver = await Driver.findOne({
            where:      { userId: accountUuid },
            attributes: ['id'],
        });
        if (!driver) {
            return res.status(404).json({ success: false, message: 'Driver record not found' });
        }

        const delivery = await Delivery.findOne({
            where:   { id: deliveryId, driver_id: driver.id },
            include: [
                {
                    association: 'sender',
                    attributes:  ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'],
                },
                {
                    association: 'pricingZone',
                    attributes:  ['id', 'zone_name'],
                },
            ],
        });

        if (!delivery) {
            return res.status(404).json({ success: false, message: 'Delivery not found' });
        }

        // Fetch wallet transactions for this delivery
        const transactions = await DeliveryWalletTransaction.findAll({
            where: { delivery_id: deliveryId },
            order: [['created_at', 'ASC']],
            attributes: ['id', 'type', 'amount', 'balance_before', 'balance_after', 'notes', 'created_at'],
        });

        const meta = categoryMeta(delivery.package_category);

        const response = {
            id:           delivery.id,
            deliveryCode: delivery.delivery_code,
            deliveryType: delivery.delivery_type,
            trackingMode: trackingMode(delivery.delivery_type),
            status:       delivery.status,

            packageSize:     delivery.package_size,
            packageCategory: delivery.package_category,
            categoryLabel:   meta.label,
            categoryEmoji:   meta.emoji,
            packagePhotoUrl: delivery.package_photo_url,
            pickupPhotoUrl:  delivery.pickup_photo_url,
            isFragile:       delivery.is_fragile,
            packageDescription: delivery.package_description,

            pickup: {
                address:  delivery.pickup_address,
                lat:      parseFloat(delivery.pickup_latitude),
                lng:      parseFloat(delivery.pickup_longitude),
                landmark: delivery.pickup_landmark,
            },
            dropoff: {
                address:  delivery.dropoff_address,
                lat:      parseFloat(delivery.dropoff_latitude),
                lng:      parseFloat(delivery.dropoff_longitude),
                landmark: delivery.dropoff_landmark,
            },
            distanceKm: parseFloat(delivery.distance_km),

            recipientName:  delivery.recipient_name,
            recipientPhone: delivery.recipient_phone,
            recipientNote:  delivery.recipient_note,

            sender: delivery.sender ? {
                name:   `${delivery.sender.first_name || ''} ${delivery.sender.last_name || ''}`.trim(),
                phone:  delivery.sender.phone_e164,
                avatar: delivery.sender.avatar_url,
            } : null,

            pricing: {
                totalPrice:       parseFloat(delivery.total_price),
                driverPayout:     parseFloat(delivery.driver_payout),
                commissionAmount: parseFloat(delivery.commission_amount),
                commissionPct:    parseFloat(delivery.commission_percentage_applied),
                baseFee:          parseFloat(delivery.base_fee_applied),
                distanceFee:      parseFloat((delivery.distance_km * delivery.per_km_rate_applied).toFixed(2)),
                sizeMultiplier:   parseFloat(delivery.size_multiplier_applied),
                surgeMultiplier:  parseFloat(delivery.surge_multiplier_applied),
                isSurging:        parseFloat(delivery.surge_multiplier_applied) > 1.00,
                pricingZone:      delivery.pricingZone?.zone_name || null,
            },

            payment: {
                method:    delivery.payment_method,
                status:    delivery.payment_status,
                paidAt:    delivery.paid_at || null,
                reference: delivery.payment_reference || null,
            },

            timeline: {
                createdAt:      delivery.created_at,
                acceptedAt:     delivery.accepted_at      || null,
                arrivedPickup:  delivery.arrived_pickup_at || null,
                pickedUp:       delivery.picked_up_at      || null,
                deliveredAt:    delivery.delivered_at      || null,
                cancelledAt:    delivery.cancelled_at      || null,
                durationMinutes: durationMinutes(delivery.accepted_at, delivery.delivered_at),
            },

            cancellation: delivery.status === 'cancelled' ? {
                cancelledBy: delivery.cancelled_by,
                reason:      delivery.cancellation_reason,
            } : null,

            rating: delivery.rated_at ? {
                score:   parseFloat(delivery.rating),
                comment: delivery.rating_comment,
                ratedAt: delivery.rated_at,
            } : null,

            walletTransactions: transactions,
        };

        // Remove PIN from response
        delete response.delivery_pin;

        return res.json({ success: true, delivery: response });

    } catch (error) {
        console.error('❌ [AGENT HISTORY] getDetail error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch delivery detail' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET EARNINGS SUMMARY
// GET /api/deliveries/agent/history/earnings
//
// Returns aggregated earnings stats broken down by period.
// ═══════════════════════════════════════════════════════════════════════════════

exports.getEarningsSummary = async (req, res) => {
    try {
        const accountUuid = req.user.uuid;

        const driver = await Driver.findOne({
            where:      { userId: accountUuid },
            attributes: ['id'],
        });
        if (!driver) {
            return res.status(404).json({ success: false, message: 'Driver record not found' });
        }

        const now       = new Date();
        const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
        const weekStart  = new Date(now); weekStart.setDate(now.getDate() - 6); weekStart.setHours(0, 0, 0, 0);
        const monthStart = new Date(now); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

        const baseWhere = { driver_id: driver.id, status: 'delivered' };

        const [today, week, month, allTime] = await Promise.all([
            Delivery.findAll({ where: { ...baseWhere, delivered_at: { [Op.gte]: todayStart } },     attributes: ['driver_payout', 'commission_amount', 'total_price', 'payment_method', 'delivery_type'] }),
            Delivery.findAll({ where: { ...baseWhere, delivered_at: { [Op.gte]: weekStart } },      attributes: ['driver_payout', 'commission_amount', 'total_price', 'payment_method', 'delivery_type'] }),
            Delivery.findAll({ where: { ...baseWhere, delivered_at: { [Op.gte]: monthStart } },     attributes: ['driver_payout', 'commission_amount', 'total_price', 'payment_method', 'delivery_type'] }),
            Delivery.findAll({ where: { ...baseWhere },                                             attributes: ['driver_payout', 'commission_amount', 'total_price', 'payment_method', 'delivery_type'] }),
        ]);

        function summarise(rows) {
            const cash    = rows.filter(d => d.payment_method === 'cash');
            const digital = rows.filter(d => d.payment_method !== 'cash');
            return {
                deliveries:      rows.length,
                totalEarnings:   rows.reduce((s, d) => s + parseFloat(d.driver_payout), 0),
                cashCollected:   cash.reduce((s, d) => s + parseFloat(d.total_price), 0),
                cashOwedToWego:  cash.reduce((s, d) => s + parseFloat(d.commission_amount), 0),
                walletCredited:  digital.reduce((s, d) => s + parseFloat(d.driver_payout), 0),
                expressCount:    rows.filter(d => d.delivery_type === 'express').length,
                regularCount:    rows.filter(d => d.delivery_type === 'regular').length,
            };
        }

        return res.json({
            success: true,
            earnings: {
                today:   summarise(today),
                week:    summarise(week),
                month:   summarise(month),
                allTime: summarise(allTime),
            },
        });

    } catch (error) {
        console.error('❌ [AGENT HISTORY] getEarningsSummary error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch earnings summary' });
    }
};