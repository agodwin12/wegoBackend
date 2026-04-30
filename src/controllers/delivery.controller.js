'use strict';

const { Op }         = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const axios          = require('axios');

const {
    Delivery,
    DeliveryPricing,
    DeliverySurgeRule,
    DeliveryWallet,
    DeliveryWalletTransaction,
    Account,
    Driver,
} = require('../models');

const { redisClient, REDIS_KEYS, redisHelpers } = require('../config/redis');
const locationService           = require('../services/locationService');
const deliveryEarningsService   = require('../services/deliveryEarningsService');
const deliveryCommissionService = require('../services/delivery/deliveryCommission.service');
const deliverySocketService     = require('../sockets/delivery/deliverySocket.service');
const { EXPRESS_SURCHARGE }     = require('../middleware/delivery.middleware');
const { getIO }                 = require('../sockets/exports');
const { sendSms }               = require('../services/comm/sms.service');

// ─── Constants ────────────────────────────────────────────────────────────────

const DELIVERY_SEARCH_RADIUS_KM = parseFloat(process.env.DELIVERY_SEARCH_RADIUS_KM || 5);
const DELIVERY_OFFER_TTL_MS     = parseInt(process.env.DELIVERY_OFFER_TTL_MS || 25000, 10);

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

const ACTIVE_STATUSES = [
    'searching', 'accepted', 'en_route_pickup', 'arrived_pickup',
    'picked_up', 'en_route_dropoff', 'arrived_dropoff',
];

// In-memory timeout map — deliveryId → setTimeout handle
const activeTimeouts = new Map();

const debugPrint = (...args) => {
    if (process.env.NODE_ENV !== 'production') console.log(...args);
};

// ═══════════════════════════════════════════════════════════════════════════════
// PRIVATE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Safe io accessor.
 * req.app.get('io') only works if app.set('io', instance) was called at boot.
 * Falls back to the module-level socket registry (sockets/exports.js) which
 * is always populated when the server starts.
 */
function _getIO(req) {
    try {
        const fromApp = req?.app?.get('io');
        if (fromApp && fromApp.sockets) return fromApp;
    } catch (_) {}
    return getIO();
}

async function getGoogleMapsDistance(originLat, originLng, destLat, destLng) {
    try {
        const response = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
            params: {
                origin:      `${originLat},${originLng}`,
                destination: `${destLat},${destLng}`,
                key:         process.env.GOOGLE_MAPS_API_KEY,
            },
        });
        const route = response.data.routes?.[0]?.legs?.[0];
        if (!route) throw new Error('No route found');
        return {
            distanceKm:      route.distance.value / 1000,
            durationSeconds: route.duration.value,
            distanceText:    route.distance.text,
            durationText:    route.duration.text,
        };
    } catch (error) {
        console.error('❌ [DELIVERY] Google Maps error:', error.message);
        // Haversine fallback with 1.3x road factor
        const R    = 6371;
        const dLat = (destLat - originLat) * Math.PI / 180;
        const dLng = (destLng - originLng) * Math.PI / 180;
        const a    = Math.sin(dLat / 2) ** 2
            + Math.cos(originLat * Math.PI / 180) * Math.cos(destLat * Math.PI / 180)
            * Math.sin(dLng / 2) ** 2;
        return {
            distanceKm:      parseFloat((R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 1.3).toFixed(3)),
            durationSeconds: null, distanceText: null, durationText: null,
        };
    }
}

async function findPricingZone() {
    return DeliveryPricing.findOne({ where: { is_active: true }, order: [['id', 'ASC']] });
}

async function sendPinSms(recipientPhone, pin, deliveryCode) {
    try {
        const message = `WEGO Delivery ${deliveryCode}: Your delivery PIN is ${pin}. Share only with your driver.`;
        await sendSms(recipientPhone, message);
        debugPrint(`📱 [DELIVERY] PIN SMS sent to ${recipientPhone}`);
    } catch (error) {
        console.error('❌ [DELIVERY] PIN SMS failed:', error.message);
    }
}

async function emitToDriver(io, driverId, event, data) {
    if (!io) return false;
    let emitted = false;
    for (const room of [`driver:${driverId}`, `user:${driverId}`]) {
        if ((io.sockets.adapter.rooms.get(room)?.size || 0) > 0) {
            io.to(room).emit(event, data);
            emitted = true;
        }
    }
    const socketId = await redisClient.get(REDIS_KEYS.USER_SOCKET(driverId));
    if (socketId && io.sockets.sockets.get(socketId)) {
        io.to(socketId).emit(event, data);
        emitted = true;
    }
    return emitted;
}

async function emitToSender(io, senderUuid, event, data) {
    if (!io) return;
    io.to(`passenger:${senderUuid}`).emit(event, data);
    io.to(`user:${senderUuid}`).emit(event, data);
    const socketId = await redisClient.get(REDIS_KEYS.USER_SOCKET(senderUuid));
    if (socketId && io.sockets.sockets.get(socketId)) {
        io.to(socketId).emit(event, data);
    }
}

async function getDriverByAccountUuid(accountUuid) {
    return Driver.findOne({
        where:      { userId: accountUuid },
        attributes: ['id', 'userId', 'status', 'current_mode', 'phone', 'rating', 'lat', 'lng'],
    });
}

function trackingMode(deliveryType) {
    return deliveryType === 'express' ? 'live_map' : 'stage_updates';
}

// ═══════════════════════════════════════════════════════════════════════════════
// 0. GET PACKAGE CATEGORIES
// GET /api/deliveries/categories
// ═══════════════════════════════════════════════════════════════════════════════

exports.getCategories = (req, res) => {
    const categories = Delivery.PACKAGE_CATEGORIES.map(key => ({
        value: key,
        label: CATEGORY_META[key]?.label || key,
        emoji: CATEGORY_META[key]?.emoji || '📦',
    }));
    return res.json({ success: true, categories });
};

// ═══════════════════════════════════════════════════════════════════════════════
// 1. GET FARE ESTIMATE
// GET /api/deliveries/estimate
// ═══════════════════════════════════════════════════════════════════════════════

exports.getEstimate = async (req, res) => {
    try {
        const {
            pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
            package_size, delivery_type = 'regular',
        } = req.query;

        if (!pickup_lat || !pickup_lng || !dropoff_lat || !dropoff_lng || !package_size) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }
        if (!['small', 'medium', 'large'].includes(package_size)) {
            return res.status(400).json({ success: false, message: 'package_size must be small, medium, or large' });
        }
        if (!['regular', 'express'].includes(delivery_type)) {
            return res.status(400).json({ success: false, message: "delivery_type must be 'regular' or 'express'" });
        }

        const { distanceKm, durationSeconds, distanceText, durationText } =
            await getGoogleMapsDistance(
                parseFloat(pickup_lat), parseFloat(pickup_lng),
                parseFloat(dropoff_lat), parseFloat(dropoff_lng),
            );

        const pricingZone = await findPricingZone();
        if (!pricingZone) {
            return res.status(503).json({ success: false, message: 'Delivery service not available in your area' });
        }

        const { rule: surgeRule, multiplier: surgeMultiplier } =
            await DeliverySurgeRule.getActiveSurge(pricingZone.id);

        const priceBreakdown = pricingZone.calculatePrice(distanceKm, package_size, surgeMultiplier);

        let expressSurchargeXAF = 0;
        let totalPrice          = priceBreakdown.totalPrice;
        if (delivery_type === 'express' && EXPRESS_SURCHARGE > 0) {
            expressSurchargeXAF = Math.round(priceBreakdown.totalPrice * EXPRESS_SURCHARGE);
            totalPrice += expressSurchargeXAF;
        }

        return res.json({
            success: true,
            estimate: {
                ...priceBreakdown,
                totalPrice,
                expressSurcharge: expressSurchargeXAF,
                deliveryType:     delivery_type,
                trackingMode:     trackingMode(delivery_type),
                distanceKm, durationSeconds, distanceText, durationText,
                pricingZoneId:    pricingZone.id,
                pricingZoneName:  pricingZone.zone_name,
                surgeActive:      surgeMultiplier > 1.00,
                surgeRuleName:    surgeRule?.name || null,
                currency:         'XAF',
            },
        });

    } catch (error) {
        console.error('❌ [DELIVERY] getEstimate error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to calculate estimate' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 2. BOOK DELIVERY
// POST /api/deliveries/book
// ═══════════════════════════════════════════════════════════════════════════════

exports.bookDelivery = async (req, res) => {
    try {
        const senderUuid        = req.user.uuid;
        const deliveryType      = req.deliveryType      || 'regular';
        const expressMultiplier = req.expressMultiplier || 1.0;

        const {
            pickup_address, pickup_latitude, pickup_longitude, pickup_landmark,
            dropoff_address, dropoff_latitude, dropoff_longitude, dropoff_landmark,
            recipient_name, recipient_phone, recipient_note,
            package_size, package_category, package_description,
            package_photo_url, is_fragile, payment_method,
        } = req.body;

        // Validation
        const required = {
            pickup_address, pickup_latitude, pickup_longitude,
            dropoff_address, dropoff_latitude, dropoff_longitude,
            recipient_name, recipient_phone,
            package_size, package_category, package_photo_url, payment_method,
        };
        for (const [field, value] of Object.entries(required)) {
            if (!value && value !== 0) {
                return res.status(400).json({ success: false, message: `${field} is required` });
            }
        }
        if (!['small', 'medium', 'large'].includes(package_size)) {
            return res.status(400).json({ success: false, message: 'package_size must be small, medium, or large' });
        }
        if (!Delivery.PACKAGE_CATEGORIES.includes(package_category)) {
            return res.status(400).json({
                success: false,
                message: `package_category must be one of: ${Delivery.PACKAGE_CATEGORIES.join(', ')}`,
            });
        }
        if (!['mtn_mobile_money', 'orange_money', 'cash'].includes(payment_method)) {
            return res.status(400).json({ success: false, message: 'Invalid payment method' });
        }
        if (!package_photo_url.startsWith('http://') && !package_photo_url.startsWith('https://')) {
            return res.status(400).json({ success: false, message: 'package_photo_url must be a valid URL' });
        }

        // No duplicate active delivery
        const existing = await Delivery.findOne({
            where: { sender_id: senderUuid, status: { [Op.in]: ACTIVE_STATUSES } },
        });
        if (existing) {
            return res.status(400).json({
                success:            false,
                message:            'You already have an active delivery in progress',
                activeDeliveryCode: existing.delivery_code,
            });
        }

        // Distance + pricing
        const { distanceKm } = await getGoogleMapsDistance(
            parseFloat(pickup_latitude), parseFloat(pickup_longitude),
            parseFloat(dropoff_latitude), parseFloat(dropoff_longitude),
        );
        const pricingZone = await findPricingZone();
        if (!pricingZone) {
            return res.status(503).json({ success: false, message: 'Delivery service not available in your area' });
        }
        if (distanceKm > pricingZone.max_distance_km) {
            return res.status(400).json({
                success: false,
                message: `Distance (${distanceKm.toFixed(1)} km) exceeds maximum (${pricingZone.max_distance_km} km)`,
            });
        }

        const { rule: surgeRule, multiplier: surgeMultiplier } =
            await DeliverySurgeRule.getActiveSurge(pricingZone.id);
        const priceBreakdown = pricingZone.calculatePrice(distanceKm, package_size, surgeMultiplier);

        let finalTotalPrice     = priceBreakdown.totalPrice;
        let finalCommission     = priceBreakdown.commissionAmount;
        let expressSurchargeXAF = 0;

        if (deliveryType === 'express' && expressMultiplier > 1.0) {
            expressSurchargeXAF = Math.round(priceBreakdown.totalPrice * (expressMultiplier - 1.0));
            finalTotalPrice    += expressSurchargeXAF;
            finalCommission    += expressSurchargeXAF;
            debugPrint(`⚡ [DELIVERY] Express surcharge: +${expressSurchargeXAF} XAF`);
        }

        const deliveryCode                          = await Delivery.generateDeliveryCode();
        const { plain: pinPlain, hashed: pinHashed } = await Delivery.generateDeliveryPin();

        const delivery = await Delivery.create({
            delivery_code:                 deliveryCode,
            delivery_type:                 deliveryType,
            sender_id:                     senderUuid,
            driver_id:                     null,
            recipient_name,
            recipient_phone,
            recipient_note:                recipient_note       || null,
            pickup_address,
            pickup_latitude:               parseFloat(pickup_latitude),
            pickup_longitude:              parseFloat(pickup_longitude),
            pickup_landmark:               pickup_landmark      || null,
            dropoff_address,
            dropoff_latitude:              parseFloat(dropoff_latitude),
            dropoff_longitude:             parseFloat(dropoff_longitude),
            dropoff_landmark:              dropoff_landmark     || null,
            package_size,
            package_category,
            package_description:           package_description  || null,
            package_photo_url,
            is_fragile:                    is_fragile           || false,
            pricing_zone_id:               pricingZone.id,
            distance_km:                   priceBreakdown.distanceKm,
            base_fee_applied:              priceBreakdown.baseFeeApplied,
            per_km_rate_applied:           priceBreakdown.perKmRateApplied,
            size_multiplier_applied:       priceBreakdown.sizeMultiplierApplied,
            surge_multiplier_applied:      priceBreakdown.surgeMultiplierApplied,
            surge_rule_id:                 surgeRule?.id        || null,
            subtotal:                      priceBreakdown.subtotal,
            total_price:                   finalTotalPrice,
            commission_percentage_applied: priceBreakdown.commissionPercentageApplied,
            commission_amount:             finalCommission,
            driver_payout:                 priceBreakdown.driverPayout,
            payment_method,
            payment_status:  payment_method === 'cash' ? 'cash_pending' : 'pending',
            delivery_pin:    pinHashed,
            pin_attempts:    0,
            status:          'searching',
            search_attempts: 0,
        });

        debugPrint(`📦 [DELIVERY] ${deliveryCode} (${deliveryType}) — ${package_category}/${package_size} — ${finalTotalPrice} XAF`);

        await sendPinSms(recipient_phone, pinPlain, deliveryCode);

        // Redis cache
        await redisHelpers.setJson(`delivery:active:${delivery.id}`, {
            id:              delivery.id,
            deliveryCode,
            deliveryType,
            senderId:        senderUuid,
            status:          'searching',
            pickupLat:       parseFloat(pickup_latitude),
            pickupLng:       parseFloat(pickup_longitude),
            dropoffLat:      parseFloat(dropoff_latitude),
            dropoffLng:      parseFloat(dropoff_longitude),
            totalPrice:      finalTotalPrice,
            paymentMethod:   payment_method,
            packageSize:     package_size,
            packageCategory: package_category,
            packagePhotoUrl: package_photo_url,
            recipientName:   recipient_name,
            recipientPhone:  recipient_phone,
        }, 7200);

        await redisClient.set(`sender:active_delivery:${senderUuid}`, delivery.id, 'EX', 7200);

        // Launch driver search — fire-and-forget
        const io = _getIO(req);
        _searchForDriver(delivery.id, io).catch(err => {
            console.error(`❌ [DELIVERY] Driver search failed for ${deliveryCode}:`, err.message);
        });

        return res.status(201).json({
            success: true,
            message: 'Delivery booked. Searching for a driver...',
            delivery: {
                id:           delivery.id,
                deliveryCode,
                deliveryType,
                trackingMode: trackingMode(deliveryType),
                status:       'searching',
                totalPrice:   finalTotalPrice,
                priceBreakdown: {
                    baseFee:          priceBreakdown.baseFeeApplied,
                    distanceFee:      parseFloat((priceBreakdown.distanceKm * priceBreakdown.perKmRateApplied).toFixed(2)),
                    sizeMultiplier:   priceBreakdown.sizeMultiplierApplied,
                    surgeMultiplier:  priceBreakdown.surgeMultiplierApplied,
                    surgeActive:      priceBreakdown.isSurging,
                    expressSurcharge: expressSurchargeXAF,
                    total:            finalTotalPrice,
                },
                packageSize:     package_size,
                packageCategory: package_category,
                categoryLabel:   CATEGORY_META[package_category]?.label,
                categoryEmoji:   CATEGORY_META[package_category]?.emoji,
                packagePhotoUrl: package_photo_url,
                recipientName:   recipient_name,
                recipientPhone:  recipient_phone,
                paymentMethod:   payment_method,
            },
        });

    } catch (error) {
        console.error('❌ [DELIVERY] bookDelivery error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to book delivery' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// INTERNAL — Driver search + timeout handlers
// ═══════════════════════════════════════════════════════════════════════════════

async function _searchForDriver(deliveryId, io) {
    // Safe io accessor — falls back to module-level getIO() if argument is invalid
    const _io = () => {
        if (io && io.sockets) return io;
        try { return getIO(); } catch (_) { return null; }
    };

    try {
        debugPrint(`\n🔍 [DELIVERY] Searching drivers for delivery #${deliveryId}`);

        const deliveryData = await redisHelpers.getJson(`delivery:active:${deliveryId}`);
        if (!deliveryData) {
            debugPrint(`⚠️  [DELIVERY] No Redis data for delivery #${deliveryId}`);
            return;
        }

        // Step 1 — geo search (returns Account UUIDs)
        const nearbyDrivers = await locationService.findNearbyDrivers(
            deliveryData.pickupLng,
            deliveryData.pickupLat,
            DELIVERY_SEARCH_RADIUS_KM,
        );

        debugPrint(`📍 [DELIVERY] Geo search returned ${nearbyDrivers?.length || 0} drivers nearby`);

        if (!nearbyDrivers || nearbyDrivers.length === 0) {
            await _handleNoDriversFound(deliveryId, deliveryData, _io());
            return;
        }

        // Step 2 — resolve Account UUIDs → Driver records
        // locationService stores drivers by Account.uuid (NOT Driver.id)
        const accountUuids = nearbyDrivers.map(d => d.driverId);

        const driverRecords = await Driver.findAll({
            where: {
                userId:       accountUuids,  // Driver.userId = Account.uuid
                current_mode: 'delivery',
                status:       'online',
            },
            attributes: ['id', 'userId', 'status', 'current_mode'],
        });

        debugPrint(`✅ [DELIVERY] ${driverRecords.length}/${nearbyDrivers.length} in delivery mode`);

        if (driverRecords.length === 0) {
            await _handleNoDriversFound(deliveryId, deliveryData, _io());
            return;
        }

        // Map: accountUuid → Driver record
        const driverByAccountUuid = new Map(driverRecords.map(d => [d.userId, d]));

        // Keep only nearby drivers that have a matching Driver record
        const filteredDrivers = nearbyDrivers
            .filter(nd => driverByAccountUuid.has(nd.driverId))
            .map(nd => ({ ...nd, driver: driverByAccountUuid.get(nd.driverId) }));

        debugPrint(`📋 [DELIVERY] ${filteredDrivers.length} drivers will receive offer`);

        // Step 3 — load delivery for offer payload
        const delivery = await Delivery.findByPk(deliveryId, {
            include: [{ association: 'sender', attributes: ['uuid', 'first_name', 'last_name'] }],
        });
        if (!delivery) return;

        // Step 4 — build offer payload
        const deliveryOffer = {
            deliveryId:         delivery.id,
            deliveryCode:       delivery.delivery_code,
            deliveryType:       delivery.delivery_type,
            trackingMode:       trackingMode(delivery.delivery_type),
            packageSize:        delivery.package_size,
            packageCategory:    delivery.package_category,
            categoryLabel:      CATEGORY_META[delivery.package_category]?.label,
            categoryEmoji:      CATEGORY_META[delivery.package_category]?.emoji,
            packagePhotoUrl:    delivery.package_photo_url,
            packageDescription: delivery.package_description,
            isFragile:          delivery.is_fragile,
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
            distanceKm:       parseFloat(delivery.distance_km),
            totalPrice:       parseFloat(delivery.total_price),
            driverPayout:     parseFloat(delivery.driver_payout),
            commissionAmount: parseFloat(delivery.commission_amount),
            paymentMethod:    delivery.payment_method,
            isSurging:        parseFloat(delivery.surge_multiplier_applied) > 1.00,
            surgeMultiplier:  parseFloat(delivery.surge_multiplier_applied),
            sender: {
                name: `${delivery.sender?.first_name || ''} ${delivery.sender?.last_name || ''}`.trim(),
            },
            expiresAt: Date.now() + DELIVERY_OFFER_TTL_MS,
            expiresIn: Math.floor(DELIVERY_OFFER_TTL_MS / 1000),
        };

        // Step 5 — emit to each driver
        // Socket rooms are keyed by Account.uuid — emit to nd.driverId (Account UUID)
        const ioInstance = _io();
        if (!ioInstance) {
            console.error('❌ [DELIVERY] Socket.IO instance unavailable — cannot emit offers');
            return;
        }

        const notifiedAccountUuids = [];
        for (const nd of filteredDrivers) {
            const emitted = await emitToDriver(ioInstance, nd.driverId, 'delivery:new_request', {
                ...deliveryOffer,
                distanceToPickup:   Math.round(nd.distance * 1000),
                distanceToPickupKm: parseFloat(nd.distance.toFixed(2)),
            });
            if (emitted) {
                notifiedAccountUuids.push(nd.driverId);
                debugPrint(`📤 [DELIVERY] Offer → driver ${nd.driverId} (${nd.distance.toFixed(2)} km)`);
            } else {
                debugPrint(`⚠️  [DELIVERY] Driver ${nd.driverId} in geo-index but socket not connected`);
            }
        }

        if (notifiedAccountUuids.length === 0) {
            await _handleNoDriversFound(deliveryId, deliveryData, ioInstance);
            return;
        }

        // Step 6 — cache who received the offer
        await redisHelpers.setJson(`delivery:offers:${deliveryId}`, {
            drivers:     notifiedAccountUuids,
            broadcastAt: Date.now(),
            expiresAt:   Date.now() + DELIVERY_OFFER_TTL_MS,
        }, Math.ceil(DELIVERY_OFFER_TTL_MS / 1000) + 60);

        await delivery.increment('search_attempts');

        // Step 7 — set expiry timeout
        const timeoutId = setTimeout(async () => {
            await _handleDeliveryTimeout(deliveryId, _io());
            activeTimeouts.delete(deliveryId);
        }, DELIVERY_OFFER_TTL_MS);
        activeTimeouts.set(deliveryId, timeoutId);

        debugPrint(`✅ [DELIVERY] Broadcast complete — ${notifiedAccountUuids.length}/${filteredDrivers.length} drivers notified`);

    } catch (error) {
        console.error('❌ [DELIVERY] _searchForDriver error:', error.message);
        console.error(error.stack);
    }
}

async function _handleDeliveryTimeout(deliveryId, io) {
    try {
        const deliveryData = await redisHelpers.getJson(`delivery:active:${deliveryId}`);
        if (!deliveryData || deliveryData.status !== 'searching') return;

        await Delivery.update(
            { status: 'expired' },
            { where: { id: deliveryId, status: 'searching' } },
        );
        await redisClient.del(`delivery:active:${deliveryId}`);
        await redisClient.del(`delivery:offers:${deliveryId}`);
        await redisClient.del(`sender:active_delivery:${deliveryData.senderId}`);

        if (io) {
            await emitToSender(io, deliveryData.senderId, 'delivery:no_drivers', {
                deliveryId,
                deliveryCode: deliveryData.deliveryCode,
                message:      'No drivers available right now. Please try again.',
            });
        }
    } catch (error) {
        console.error('❌ [DELIVERY] Timeout handler error:', error.message);
    }
}

async function _handleNoDriversFound(deliveryId, deliveryData, io) {
    try {
        await Delivery.update({ status: 'expired' }, { where: { id: deliveryId } });
        await redisClient.del(`delivery:active:${deliveryId}`);
        await redisClient.del(`sender:active_delivery:${deliveryData.senderId}`);

        if (io) {
            await emitToSender(io, deliveryData.senderId, 'delivery:no_drivers', {
                deliveryId,
                message: 'No delivery drivers available nearby. Please try again.',
            });
        }
    } catch (error) {
        console.error('❌ [DELIVERY] _handleNoDriversFound error:', error.message);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. ACCEPT DELIVERY (Driver)
// POST /api/deliveries/:id/accept
// ═══════════════════════════════════════════════════════════════════════════════

exports.acceptDelivery = async (req, res) => {
    const lockKey   = `delivery:lock:${req.params.id}`;
    const lockValue = uuidv4();

    try {
        const accountUuid = req.user.uuid;
        const deliveryId  = parseInt(req.params.id);
        const io          = _getIO(req);  // ✅ safe accessor

        const driver = req.deliveryDriver || await getDriverByAccountUuid(accountUuid);
        if (!driver) {
            return res.status(404).json({ success: false, message: 'Driver record not found' });
        }
        if (driver.current_mode !== 'delivery') {
            return res.status(400).json({ success: false, message: 'Switch to delivery mode first' });
        }
        if (driver.status !== 'online') {
            return res.status(400).json({ success: false, message: 'You must be online to accept deliveries' });
        }

        const lockAcquired = await redisClient.set(lockKey, lockValue, 'EX', 10, 'NX');
        if (!lockAcquired) {
            return res.status(409).json({ success: false, message: 'Delivery already being accepted' });
        }

        try {
            const delivery = await Delivery.findByPk(deliveryId, {
                include: [{ association: 'sender', attributes: ['uuid', 'first_name', 'last_name', 'phone_e164'] }],
            });
            if (!delivery) {
                return res.status(404).json({ success: false, message: 'Delivery not found' });
            }
            if (delivery.status !== 'searching') {
                return res.status(409).json({ success: false, message: 'Delivery no longer available' });
            }

            // Reserve commission before status transition
            try {
                await deliveryCommissionService.reserveCommission(deliveryId, driver.id);
            } catch (commErr) {
                return res.status(commErr.statusCode || 402).json({
                    success:   false,
                    message:   commErr.message,
                    code:      commErr.code      || 'COMMISSION_RESERVE_FAILED',
                    shortfall: commErr.shortfall  || null,
                    required:  commErr.required   || null,
                    available: commErr.available  || null,
                });
            }

            const timeoutId = activeTimeouts.get(deliveryId);
            if (timeoutId) { clearTimeout(timeoutId); activeTimeouts.delete(deliveryId); }

            await delivery.transitionTo('accepted', { driver_id: driver.id });

            // Update Redis
            const deliveryData = await redisHelpers.getJson(`delivery:active:${deliveryId}`);
            if (deliveryData) {
                deliveryData.status   = 'accepted';
                deliveryData.driverId = driver.id;
                await redisHelpers.setJson(`delivery:active:${deliveryId}`, deliveryData, 7200);
            }

            await redisClient.set(`driver:active_delivery:${driver.id}`, deliveryId, 'EX', 7200);
            await locationService.updateDriverStatus(driver.id, 'busy', null);

            // Expire other drivers who received the offer
            const offersData = await redisHelpers.getJson(`delivery:offers:${deliveryId}`);
            for (const otherId of (offersData?.drivers || []).filter(id => id !== driver.userId)) {
                await emitToDriver(io, otherId, 'delivery:request_expired', { deliveryId });
            }
            await redisClient.del(`delivery:offers:${deliveryId}`);

            // Join delivery socket room
            // Socket is keyed by Account.uuid — use driver.userId not driver.id
            const driverSocketId = await redisClient.get(REDIS_KEYS.USER_SOCKET(driver.userId));
            if (driverSocketId) {
                const driverSocket = io.sockets.sockets.get(driverSocketId);
                if (driverSocket) deliverySocketService.joinDeliveryRoom(driverSocket, deliveryId);
            }

            // Notify sender
            await emitToSender(io, delivery.sender_id, 'delivery:driver_assigned', {
                deliveryId,
                deliveryCode: delivery.delivery_code,
                deliveryType: delivery.delivery_type,
                trackingMode: trackingMode(delivery.delivery_type),
                status:       'accepted',
                driver: {
                    id:     driver.id,
                    name:   `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim(),
                    phone:  driver.phone || req.user.phone_e164,
                    rating: driver.rating,
                    avatar: req.user.avatar_url || null,
                },
            });

            debugPrint(`✅ [DELIVERY] ${delivery.delivery_code} (${delivery.delivery_type}) accepted`);

            return res.json({
                success:  true,
                message:  'Delivery accepted',
                delivery: {
                    id:               delivery.id,
                    deliveryCode:     delivery.delivery_code,
                    deliveryType:     delivery.delivery_type,
                    trackingMode:     trackingMode(delivery.delivery_type),
                    status:           'accepted',
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
                    packageSize:        delivery.package_size,
                    packageCategory:    delivery.package_category,
                    categoryLabel:      CATEGORY_META[delivery.package_category]?.label,
                    categoryEmoji:      CATEGORY_META[delivery.package_category]?.emoji,
                    packagePhotoUrl:    delivery.package_photo_url,
                    packageDescription: delivery.package_description,
                    isFragile:          delivery.is_fragile,
                    totalPrice:         parseFloat(delivery.total_price),
                    driverPayout:       parseFloat(delivery.driver_payout),
                    commissionAmount:   parseFloat(delivery.commission_amount),
                    paymentMethod:      delivery.payment_method,
                    recipientName:      delivery.recipient_name,
                    recipientPhone:     delivery.recipient_phone,
                    recipientNote:      delivery.recipient_note,
                },
            });

        } finally {
            const cur = await redisClient.get(lockKey);
            if (cur === lockValue) await redisClient.del(lockKey);
        }

    } catch (error) {
        console.error('❌ [DELIVERY] acceptDelivery error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to accept delivery' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 4. UPDATE DELIVERY STATUS (Driver)
// POST /api/deliveries/:id/status
// ═══════════════════════════════════════════════════════════════════════════════

exports.updateStatus = async (req, res) => {
    try {
        const accountUuid                  = req.user.uuid;
        const deliveryId                   = parseInt(req.params.id);
        const { status, pickup_photo_url } = req.body;
        const io                           = _getIO(req);  // ✅

        const validStatuses = ['en_route_pickup', 'arrived_pickup', 'picked_up', 'en_route_dropoff', 'arrived_dropoff'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                message: `Invalid status. Must be: ${validStatuses.join(', ')}`,
            });
        }

        const driver = await getDriverByAccountUuid(accountUuid);
        if (!driver) return res.status(404).json({ success: false, message: 'Driver record not found' });

        const delivery = await Delivery.findOne({ where: { id: deliveryId, driver_id: driver.id } });
        if (!delivery) return res.status(404).json({ success: false, message: 'Delivery not found' });
        if (!delivery.canTransitionTo(status)) {
            return res.status(400).json({
                success: false,
                message: `Cannot transition from ${delivery.status} to ${status}`,
            });
        }

        const extraFields = {};
        if (status === 'picked_up' && pickup_photo_url) extraFields.pickup_photo_url = pickup_photo_url;

        await delivery.transitionTo(status, extraFields);

        const deliveryData = await redisHelpers.getJson(`delivery:active:${deliveryId}`);
        if (deliveryData) {
            deliveryData.status = status;
            await redisHelpers.setJson(`delivery:active:${deliveryId}`, deliveryData, 7200);
        }

        let driverLocation = null;
        if (delivery.delivery_type === 'regular' && driver.lat && driver.lng) {
            driverLocation = { lat: parseFloat(driver.lat), lng: parseFloat(driver.lng) };
        }

        await deliverySocketService.emitStageUpdate(io, delivery.sender_id, {
            deliveryId,
            deliveryCode:   delivery.delivery_code,
            deliveryType:   delivery.delivery_type,
            status,
            pickupPhotoUrl: pickup_photo_url || null,
            driverLocation,
        });

        debugPrint(`📦 [DELIVERY] ${delivery.delivery_code} → ${status}`);
        return res.json({
            success: true,
            status,
            message: deliverySocketService.statusToLabel(status),
        });

    } catch (error) {
        console.error('❌ [DELIVERY] updateStatus error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to update status' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 5. VERIFY PIN AND COMPLETE DELIVERY (Driver)
// POST /api/deliveries/:id/verify-pin
// ═══════════════════════════════════════════════════════════════════════════════

exports.verifyPin = async (req, res) => {
    try {
        const accountUuid = req.user.uuid;
        const deliveryId  = parseInt(req.params.id);
        const { pin }     = req.body;
        const io          = _getIO(req);

        if (!pin) return res.status(400).json({ success: false, message: 'PIN is required' });

        const driver = await getDriverByAccountUuid(accountUuid);
        if (!driver) return res.status(404).json({ success: false, message: 'Driver record not found' });

        const delivery = await Delivery.findOne({ where: { id: deliveryId, driver_id: driver.id } });
        if (!delivery) return res.status(404).json({ success: false, message: 'Delivery not found' });

        if (delivery.status !== 'arrived_dropoff') {
            return res.status(400).json({
                success: false,
                message: `Mark arrived at dropoff before verifying PIN. Current status: ${delivery.status}`,
            });
        }

        // ── Debug: log PIN storage length so we can catch truncation ──────────
        debugPrint(`🔑 [PIN DEBUG] stored pin length: ${delivery.delivery_pin?.length}, value: ${delivery.delivery_pin}`);
        debugPrint(`🔑 [PIN DEBUG] entered pin: ${pin}`);

        const result = await Delivery.verifyPin(delivery, pin);
        debugPrint(`🔑 [PIN DEBUG] verifyPin result: ${JSON.stringify(result)}`);

        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: result.message,
                locked:  result.locked || false,
            });
        }

        await delivery.transitionTo('delivered');
        if (delivery.payment_method === 'cash') {
            await delivery.update({ payment_status: 'cash_pending' });
        }

        deliveryCommissionService.confirmCommission(deliveryId, driver.id)
            .then(() => debugPrint(`💸 [DELIVERY] Commission confirmed for ${delivery.delivery_code}`))
            .catch(err => console.error(`❌ [DELIVERY] Commission confirm FAILED:`, err.message));

        deliveryEarningsService.postDeliveryEarnings(delivery.id)
            .then(() => debugPrint(`💰 [DELIVERY] Earnings posted for ${delivery.delivery_code}`))
            .catch(err => console.error(`❌ [DELIVERY] Earnings posting FAILED:`, err.message));

        await locationService.updateDriverStatus(driver.id, 'online', null);
        await redisClient.del(`delivery:active:${deliveryId}`);
        await redisClient.del(`sender:active_delivery:${delivery.sender_id}`);
        await redisClient.del(`driver:active_delivery:${driver.id}`);

        const driverSocketId = await redisClient.get(REDIS_KEYS.USER_SOCKET(driver.userId));
        if (driverSocketId) {
            const driverSocket = io.sockets.sockets.get(driverSocketId);
            if (driverSocket) deliverySocketService.leaveDeliveryRoom(driverSocket, deliveryId);
        }

        await emitToSender(io, delivery.sender_id, 'delivery:completed', {
            deliveryId,
            deliveryCode:  delivery.delivery_code,
            status:        'delivered',
            totalPrice:    parseFloat(delivery.total_price),
            paymentMethod: delivery.payment_method,
            message:       'Your package has been delivered!',
        });

        debugPrint(`✅ [DELIVERY] ${delivery.delivery_code} DELIVERED`);
        return res.json({
            success:      true,
            message:      'Delivery completed successfully',
            deliveryCode: delivery.delivery_code,
            totalPrice:   parseFloat(delivery.total_price),
            driverPayout: parseFloat(delivery.driver_payout),
        });

    } catch (error) {
        console.error('❌ [DELIVERY] verifyPin error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to verify PIN' });
    }
};
// ═══════════════════════════════════════════════════════════════════════════════
// 6. CONFIRM CASH PAYMENT (Driver)
// POST /api/deliveries/:id/confirm-cash
// ═══════════════════════════════════════════════════════════════════════════════

exports.confirmCash = async (req, res) => {
    try {
        const accountUuid = req.user.uuid;
        const deliveryId  = parseInt(req.params.id);
        const io          = _getIO(req);  // ✅

        const driver = await getDriverByAccountUuid(accountUuid);
        if (!driver) return res.status(404).json({ success: false, message: 'Driver record not found' });

        const delivery = await Delivery.findOne({
            where: {
                id:             deliveryId,
                driver_id:      driver.id,
                payment_method: 'cash',
                status:         'delivered',
                payment_status: 'cash_pending',
            },
        });
        if (!delivery) {
            return res.status(404).json({ success: false, message: 'Delivery not found or cash already confirmed' });
        }

        await delivery.update({ payment_status: 'cash_confirmed', paid_at: new Date() });

        await emitToSender(io, delivery.sender_id, 'delivery:payment_confirmed', {
            deliveryId,
            deliveryCode:  delivery.delivery_code,
            paymentMethod: 'cash',
            amount:        parseFloat(delivery.total_price),
        });

        return res.json({ success: true, message: 'Cash payment confirmed' });

    } catch (error) {
        console.error('❌ [DELIVERY] confirmCash error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to confirm cash payment' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 7. CANCEL DELIVERY
// POST /api/deliveries/:id/cancel
// ═══════════════════════════════════════════════════════════════════════════════

exports.cancelDelivery = async (req, res) => {
    try {
        const { reason } = req.body;
        const deliveryId = parseInt(req.params.id);
        const io         = _getIO(req);  // ✅

        const isDriver = ['DRIVER', 'DELIVERY_AGENT'].includes(req.user.user_type);
        let delivery, driver;

        if (isDriver) {
            driver = await getDriverByAccountUuid(req.user.uuid);
            if (!driver) return res.status(404).json({ success: false, message: 'Driver record not found' });
            delivery = await Delivery.findOne({ where: { id: deliveryId, driver_id: driver.id } });
        } else {
            delivery = await Delivery.findOne({ where: { id: deliveryId, sender_id: req.user.uuid } });
        }

        if (!delivery) return res.status(404).json({ success: false, message: 'Delivery not found' });

        if (['picked_up', 'en_route_dropoff', 'arrived_dropoff', 'delivered'].includes(delivery.status)) {
            return res.status(400).json({ success: false, message: 'Cannot cancel after pickup. Please file a dispute.' });
        }
        if (!delivery.canTransitionTo('cancelled')) {
            return res.status(400).json({ success: false, message: 'Delivery cannot be cancelled at this stage' });
        }

        const cancelledBy = isDriver ? 'driver' : 'sender';
        await delivery.transitionTo('cancelled', {
            cancelled_by:         cancelledBy,
            cancellation_reason:  reason || null,
        });

        if (delivery.driver_id) {
            if (isDriver) {
                deliveryCommissionService.penaliseCommission(deliveryId, delivery.driver_id)
                    .catch(err => console.error(`❌ [DELIVERY] Commission penalty failed:`, err.message));
            } else {
                deliveryCommissionService.releaseCommission(deliveryId, delivery.driver_id)
                    .catch(err => console.error(`❌ [DELIVERY] Commission release failed:`, err.message));
            }

            await locationService.updateDriverStatus(delivery.driver_id, 'online', null);
            await redisClient.del(`driver:active_delivery:${delivery.driver_id}`);

            // Socket keyed by Account.uuid — need driver.userId
            const cancelledDriver = await Driver.findByPk(delivery.driver_id, { attributes: ['userId'] });
            if (cancelledDriver) {
                const driverSocketId = await redisClient.get(REDIS_KEYS.USER_SOCKET(cancelledDriver.userId));
                if (driverSocketId) {
                    const driverSocket = io.sockets.sockets.get(driverSocketId);
                    if (driverSocket) deliverySocketService.leaveDeliveryRoom(driverSocket, deliveryId);
                }
                await emitToDriver(io, cancelledDriver.userId, 'delivery:cancelled', {
                    deliveryId, deliveryCode: delivery.delivery_code, cancelledBy, reason: reason || null,
                });
            }
        }

        const timeoutId = activeTimeouts.get(deliveryId);
        if (timeoutId) { clearTimeout(timeoutId); activeTimeouts.delete(deliveryId); }
        await redisClient.del(`delivery:active:${deliveryId}`);
        await redisClient.del(`delivery:offers:${deliveryId}`);
        await redisClient.del(`sender:active_delivery:${delivery.sender_id}`);

        if (cancelledBy === 'driver') {
            await emitToSender(io, delivery.sender_id, 'delivery:cancelled', {
                deliveryId,
                deliveryCode: delivery.delivery_code,
                cancelledBy:  'driver',
                message:      'The driver cancelled your delivery. Please rebook.',
            });
        }

        return res.json({ success: true, message: 'Delivery cancelled' });

    } catch (error) {
        console.error('❌ [DELIVERY] cancelDelivery error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to cancel delivery' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 8. RATE DELIVERY (Sender)
// POST /api/deliveries/:id/rate
// ═══════════════════════════════════════════════════════════════════════════════

exports.rateDelivery = async (req, res) => {
    try {
        const senderUuid         = req.user.uuid;
        const deliveryId         = parseInt(req.params.id);
        const { rating, comment } = req.body;

        if (!rating || rating < 1 || rating > 5) {
            return res.status(400).json({ success: false, message: 'Rating must be between 1 and 5' });
        }

        const delivery = await Delivery.findOne({
            where: { id: deliveryId, sender_id: senderUuid, status: 'delivered' },
        });
        if (!delivery) return res.status(404).json({ success: false, message: 'Delivery not found or not completed' });
        if (delivery.rated_at) return res.status(400).json({ success: false, message: 'Already rated this delivery' });

        await delivery.update({
            rating:         parseFloat(rating),
            rating_comment: comment || null,
            rated_at:       new Date(),
        });

        // Recalculate driver average rating
        const driverDeliveries = await Delivery.findAll({
            where:      { driver_id: delivery.driver_id, rating: { [Op.not]: null } },
            attributes: ['rating'],
        });
        if (driverDeliveries.length > 0) {
            const avg = driverDeliveries.reduce((s, d) => s + parseFloat(d.rating), 0) / driverDeliveries.length;
            await Driver.update(
                { rating: parseFloat(avg.toFixed(2)) },
                { where: { id: delivery.driver_id } },
            );
        }

        return res.json({ success: true, message: 'Rating submitted. Thank you!' });

    } catch (error) {
        console.error('❌ [DELIVERY] rateDelivery error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to submit rating' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 9. GET DELIVERY DETAILS
// GET /api/deliveries/:id
// ═══════════════════════════════════════════════════════════════════════════════

exports.getDelivery = async (req, res) => {
    try {
        const deliveryId = parseInt(req.params.id);
        const delivery   = await Delivery.findByPk(deliveryId, {
            include: [
                { association: 'sender',      attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'] },
                { association: 'driver',      attributes: ['id', 'phone', 'rating', 'lat', 'lng'] },
                { association: 'pricingZone', attributes: ['id', 'zone_name'] },
                { association: 'surgeRule',   attributes: ['id', 'name', 'multiplier'] },
                { association: 'dispute' },
            ],
        });
        if (!delivery) return res.status(404).json({ success: false, message: 'Delivery not found' });

        const isSender = delivery.sender_id === req.user.uuid;
        let isAssignedDriver = false;
        if (['DRIVER', 'DELIVERY_AGENT'].includes(req.user.user_type)) {
            const driver = await getDriverByAccountUuid(req.user.uuid);
            isAssignedDriver = driver && delivery.driver_id === driver.id;
        }
        if (!isSender && !isAssignedDriver) {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const response         = delivery.toJSON();
        delete response.delivery_pin;
        response.deliveryType  = response.delivery_type;
        response.trackingMode  = trackingMode(response.delivery_type);
        response.categoryLabel = CATEGORY_META[response.package_category]?.label || 'Other';
        response.categoryEmoji = CATEGORY_META[response.package_category]?.emoji || '📦';

        return res.json({ success: true, delivery: response });

    } catch (error) {
        console.error('❌ [DELIVERY] getDelivery error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to get delivery' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 10. GET MY DELIVERIES (Sender)
// GET /api/deliveries/my
// ═══════════════════════════════════════════════════════════════════════════════

exports.getMyDeliveries = async (req, res) => {
    try {
        const { page = 1, limit = 10, status } = req.query;
        const where = { sender_id: req.user.uuid };
        if (status) where.status = status;

        const { count, rows } = await Delivery.findAndCountAll({
            where,
            include: [{ association: 'driver', attributes: ['id', 'phone', 'rating'] }],
            order:   [['created_at', 'DESC']],
            limit:   parseInt(limit),
            offset:  (parseInt(page) - 1) * parseInt(limit),
        });

        const deliveries = rows.map(d => {
            const obj = d.toJSON();
            delete obj.delivery_pin;
            obj.deliveryType  = obj.delivery_type;
            obj.trackingMode  = trackingMode(obj.delivery_type);
            obj.categoryLabel = CATEGORY_META[obj.package_category]?.label || 'Other';
            obj.categoryEmoji = CATEGORY_META[obj.package_category]?.emoji || '📦';
            return obj;
        });

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
        console.error('❌ [DELIVERY] getMyDeliveries error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to get deliveries' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 11. GET DRIVER DELIVERIES
// GET /api/deliveries/driver/history
// ═══════════════════════════════════════════════════════════════════════════════

exports.getDriverDeliveries = async (req, res) => {
    try {
        const { page = 1, limit = 10, status } = req.query;

        const driver = await getDriverByAccountUuid(req.user.uuid);
        if (!driver) {
            return res.status(404).json({
                success: false,
                message: 'Driver record not found',
            });
        }

        const where = { driver_id: driver.id };
        if (status) where.status = status;

        const pageNum = Math.max(parseInt(page, 10) || 1, 1);
        const limitNum = Math.max(parseInt(limit, 10) || 10, 1);

        const { count, rows } = await Delivery.findAndCountAll({
            where,
            include: [
                {
                    association: 'sender',
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'],
                },
                {
                    association: 'pricingZone',
                    attributes: ['id', 'zone_name'],
                },
                {
                    association: 'surgeRule',
                    attributes: ['id', 'name', 'multiplier'],
                },
            ],
            order: [['created_at', 'DESC']],
            limit: limitNum,
            offset: (pageNum - 1) * limitNum,
        });

        const deliveries = rows.map(d => ({
            id: d.id,
            deliveryCode: d.delivery_code,
            deliveryType: d.delivery_type,
            trackingMode: trackingMode(d.delivery_type),
            status: d.status,

            pickup: {
                address: d.pickup_address,
                lat: parseFloat(d.pickup_latitude),
                lng: parseFloat(d.pickup_longitude),
                landmark: d.pickup_landmark,
            },

            dropoff: {
                address: d.dropoff_address,
                lat: parseFloat(d.dropoff_latitude),
                lng: parseFloat(d.dropoff_longitude),
                landmark: d.dropoff_landmark,
            },

            package: {
                size: d.package_size,
                category: d.package_category,
                categoryLabel: CATEGORY_META[d.package_category]?.label || 'Other',
                categoryEmoji: CATEGORY_META[d.package_category]?.emoji || '📦',
                description: d.package_description,
                photoUrl: d.package_photo_url,
                isFragile: d.is_fragile,
            },

            recipient: {
                name: d.recipient_name,
                phone: d.recipient_phone,
                note: d.recipient_note,
            },

            sender: d.sender ? {
                uuid: d.sender.uuid,
                name: `${d.sender.first_name || ''} ${d.sender.last_name || ''}`.trim(),
                phone: d.sender.phone_e164,
                avatar: d.sender.avatar_url,
            } : null,

            pricing: {
                currency: 'XAF',
                distanceKm: parseFloat(d.distance_km || 0),
                baseFee: parseFloat(d.base_fee_applied || 0),
                perKmRate: parseFloat(d.per_km_rate_applied || 0),
                sizeMultiplier: parseFloat(d.size_multiplier_applied || 0),
                surgeMultiplier: parseFloat(d.surge_multiplier_applied || 1),
                subtotal: parseFloat(d.subtotal || 0),
                totalPrice: parseFloat(d.total_price || 0),
                commissionPercentage: parseFloat(d.commission_percentage_applied || 0),
                commissionAmount: parseFloat(d.commission_amount || 0),
                driverPayout: parseFloat(d.driver_payout || 0),
            },

            payment: {
                method: d.payment_method,
                status: d.payment_status,
                paidAt: d.paid_at,
            },

            timestamps: {
                createdAt: d.created_at,
                updatedAt: d.updated_at,
                acceptedAt: d.accepted_at,
                pickedUpAt: d.picked_up_at,
                deliveredAt: d.delivered_at,
                cancelledAt: d.cancelled_at,
            },

            pricingZone: d.pricingZone ? {
                id: d.pricingZone.id,
                name: d.pricingZone.zone_name,
            } : null,

            surgeRule: d.surgeRule ? {
                id: d.surgeRule.id,
                name: d.surgeRule.name,
                multiplier: d.surgeRule.multiplier,
            } : null,
        }));

        return res.json({
            success: true,
            deliveries,
            pagination: {
                total: count,
                page: pageNum,
                limit: limitNum,
                totalPages: Math.ceil(count / limitNum),
            },
        });

    } catch (error) {
        console.error('❌ [DELIVERY] getDriverDeliveries error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Failed to get driver deliveries',
        });
    }
};



// ═══════════════════════════════════════════════════════════════════════════════
// AGENT HISTORY HELPERS
// Used by Flutter DeliveryHistoryScreen
// ═══════════════════════════════════════════════════════════════════════════════
function mapDeliveryForAgent(d) {
    const senderName = d.sender
        ? `${d.sender.first_name || ''} ${d.sender.last_name || ''}`.trim()
        : null;

    const acceptedAt = d.accepted_at || null;
    const deliveredAt = d.delivered_at || null;

    let durationMinutes = null;
    if (acceptedAt && deliveredAt) {
        durationMinutes = Math.round(
            (new Date(deliveredAt).getTime() - new Date(acceptedAt).getTime()) / 60000
        );
    }

    return {
        id: d.id,
        deliveryCode: d.delivery_code || '',
        deliveryType: d.delivery_type || 'regular',
        status: d.status || '',

        packageSize: d.package_size || '',
        packageCategory: d.package_category || '',
        categoryLabel: CATEGORY_META[d.package_category]?.label || 'Other',
        categoryEmoji: CATEGORY_META[d.package_category]?.emoji || '📦',

        pickup: {
            address: d.pickup_address || '',
            lat: Number(d.pickup_latitude || 0),
            lng: Number(d.pickup_longitude || 0),
            landmark: d.pickup_landmark || null,
        },

        dropoff: {
            address: d.dropoff_address || '',
            lat: Number(d.dropoff_latitude || 0),
            lng: Number(d.dropoff_longitude || 0),
            landmark: d.dropoff_landmark || null,
        },

        distanceKm: Number(d.distance_km || 0),
        totalPrice: Number(d.total_price || 0),
        driverPayout: Number(d.driver_payout || 0),
        commissionAmount: Number(d.commission_amount || 0),

        paymentMethod: d.payment_method || 'unknown',
        paymentStatus: d.payment_status || 'unknown',

        isSurging: Number(d.surge_multiplier_applied || 1) > 1,

        sender: d.sender ? {
            uuid: d.sender.uuid,
            name: senderName,
            phone: d.sender.phone_e164 || null,
            avatar: d.sender.avatar_url || null,
        } : null,

        senderName,

        recipientName: d.recipient_name || '',
        recipientPhone: d.recipient_phone || '',
        recipientNote: d.recipient_note || '',

        durationMinutes,

        createdAt: d.created_at || null,
        acceptedAt: d.accepted_at || null,
        arrivedPickupAt: d.arrived_pickup_at || null,
        pickedUpAt: d.picked_up_at || null,
        arrivedDropoffAt: d.arrived_dropoff_at || null,
        deliveredAt: d.delivered_at || null,
        cancelledAt: d.cancelled_at || null,

        cancelledBy: d.cancelled_by || null,
        cancellationReason: d.cancellation_reason || null,
    };
}

exports.getAgentDeliveryHistory = async (req, res) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📦 [AGENT-HISTORY] Request received');
        console.log('   URL        :', req.originalUrl);
        console.log('   user uuid  :', req.user?.uuid);
        console.log('   user type  :', req.user?.user_type);
        console.log('   activeMode :', req.auth?.active_mode || '(not set)');
        console.log('   query      :', req.query);

        const {
            page = 1,
            limit = 15,
            status,
            delivery_type,
            payment_method,
        } = req.query;

        const pageNum = Math.max(parseInt(page, 10) || 1, 1);
        const limitNum = Math.max(parseInt(limit, 10) || 15, 1);

        const driver = await getDriverByAccountUuid(req.user.uuid);

        console.log('👤 [AGENT-HISTORY] Driver lookup result:');
        console.log('   found      :', !!driver);

        if (!driver) {
            console.log('❌ [AGENT-HISTORY] No Driver row found for account uuid:', req.user.uuid);
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            return res.status(404).json({
                success: false,
                message: 'Driver record not found',
            });
        }

        console.log('   driver.id  :', driver.id);
        console.log('   driver.uuid:', driver.userId);
        console.log('   status     :', driver.status);
        console.log('   mode       :', driver.current_mode);

        const where = {
            driver_id: driver.id,
        };

        if (status) where.status = status;
        if (delivery_type) where.delivery_type = delivery_type;
        if (payment_method) where.payment_method = payment_method;

        console.log('🔎 [AGENT-HISTORY] Query params normalized:');
        console.log('   page       :', pageNum);
        console.log('   limit      :', limitNum);
        console.log('   where      :', JSON.stringify(where));

        const { count, rows } = await Delivery.findAndCountAll({
            where,
            include: [
                {
                    association: 'sender',
                    attributes: [
                        'uuid',
                        'first_name',
                        'last_name',
                        'phone_e164',
                        'avatar_url',
                    ],
                },
            ],
            order: [['created_at', 'DESC']],
            limit: limitNum,
            offset: (pageNum - 1) * limitNum,
        });

        console.log('✅ [AGENT-HISTORY] DB result:');
        console.log('   total count:', count);
        console.log('   rows fetched:', rows.length);

        rows.forEach((d, index) => {
            console.log(`\n🧾 [AGENT-HISTORY] Raw row #${index + 1}`);
            console.log('   id              :', d.id);
            console.log('   code            :', d.delivery_code);
            console.log('   status          :', d.status);
            console.log('   delivery_type   :', d.delivery_type);
            console.log('   distance_km     :', d.distance_km);
            console.log('   total_price     :', d.total_price);
            console.log('   driver_payout   :', d.driver_payout);
            console.log('   commission      :', d.commission_amount);
            console.log('   payment_method  :', d.payment_method);
            console.log('   payment_status  :', d.payment_status);
            console.log('   pickup_address  :', d.pickup_address);
            console.log('   dropoff_address :', d.dropoff_address);
            console.log('   created_at      :', d.created_at);
            console.log('   delivered_at    :', d.delivered_at);
        });

        const deliveries = rows.map(mapDeliveryForAgent);

        deliveries.forEach((d, index) => {
            console.log(`\n📤 [AGENT-HISTORY] Mapped response #${index + 1}`);
            console.log('   id              :', d.id);
            console.log('   deliveryCode    :', d.deliveryCode);
            console.log('   distanceKm      :', d.distanceKm);
            console.log('   totalPrice      :', d.totalPrice);
            console.log('   driverPayout    :', d.driverPayout);
            console.log('   commissionAmount:', d.commissionAmount);
            console.log('   paymentMethod   :', d.paymentMethod);
            console.log('   paymentStatus   :', d.paymentStatus);
            console.log('   pickup.address  :', d.pickup.address);
            console.log('   dropoff.address :', d.dropoff.address);
        });

        console.log('📦 [AGENT-HISTORY] Response ready');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.json({
            success: true,
            deliveries,
            pagination: {
                total: count,
                page: pageNum,
                limit: limitNum,
                totalPages: Math.ceil(count / limitNum),
            },
        });

    } catch (error) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ [AGENT-HISTORY] Error:', error.message);
        console.error(error.stack);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(500).json({
            success: false,
            message: 'Failed to get delivery history',
        });
    }
};
// ═══════════════════════════════════════════════════════════════════════════════
// GET AGENT DELIVERY DETAIL
// GET /api/deliveries/agent/history/:id
// ═══════════════════════════════════════════════════════════════════════════════

exports.getAgentDeliveryDetail = async (req, res) => {
    try {
        const deliveryId = parseInt(req.params.id, 10);

        const driver = await getDriverByAccountUuid(req.user.uuid);

        if (!driver) {
            return res.status(404).json({
                success: false,
                message: 'Driver record not found',
            });
        }

        const delivery = await Delivery.findOne({
            where: {
                id: deliveryId,
                driver_id: driver.id,
            },
            include: [
                {
                    association: 'sender',
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'],
                },
            ],
        });

        if (!delivery) {
            return res.status(404).json({
                success: false,
                message: 'Delivery not found',
            });
        }

        const walletTransactions = await DeliveryWalletTransaction.findAll({
            where: {
                delivery_id: delivery.id,
            },
            order: [['created_at', 'DESC']],
        });

        return res.json({
            success: true,
            delivery: {
                ...mapDeliveryForAgent(delivery),
                walletTransactions,
            },
        });

    } catch (error) {
        console.error('❌ [DELIVERY] getAgentDeliveryDetail error:', error.message);

        return res.status(500).json({
            success: false,
            message: 'Failed to get delivery detail',
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET AGENT DELIVERY EARNINGS
// GET /api/deliveries/agent/history/earnings
// ═══════════════════════════════════════════════════════════════════════════════

exports.getAgentDeliveryEarnings = async (req, res) => {
    try {
        const driver = await getDriverByAccountUuid(req.user.uuid);

        if (!driver) {
            return res.status(404).json({
                success: false,
                message: 'Driver record not found',
            });
        }

        const now = new Date();

        const startOfToday = new Date(now);
        startOfToday.setHours(0, 0, 0, 0);

        const startOfWeek = new Date(now);
        const day = startOfWeek.getDay() || 7;
        startOfWeek.setDate(startOfWeek.getDate() - day + 1);
        startOfWeek.setHours(0, 0, 0, 0);

        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        async function periodStats(startDate = null) {
            const where = {
                driver_id: driver.id,
                status: 'delivered',
            };

            if (startDate) {
                where.delivered_at = {
                    [Op.gte]: startDate,
                };
            }

            const deliveries = await Delivery.findAll({ where });

            let totalEarnings = 0;
            let cashCollected = 0;
            let cashOwedToWego = 0;
            let walletCredited = 0;
            let expressCount = 0;
            let regularCount = 0;

            for (const d of deliveries) {
                const payout = parseFloat(d.driver_payout || 0);
                const total = parseFloat(d.total_price || 0);
                const commission = parseFloat(d.commission_amount || 0);

                totalEarnings += payout;

                if (d.payment_method === 'cash') {
                    cashCollected += total;
                    cashOwedToWego += commission;
                } else {
                    walletCredited += payout;
                }

                if (d.delivery_type === 'express') {
                    expressCount++;
                } else {
                    regularCount++;
                }
            }

            return {
                deliveries: deliveries.length,
                totalEarnings,
                cashCollected,
                cashOwedToWego,
                walletCredited,
                expressCount,
                regularCount,
            };
        }

        return res.json({
            success: true,
            earnings: {
                today: await periodStats(startOfToday),
                week: await periodStats(startOfWeek),
                month: await periodStats(startOfMonth),
                allTime: await periodStats(null),
            },
        });

    } catch (error) {
        console.error('❌ [DELIVERY] getAgentDeliveryEarnings error:', error.message);

        return res.status(500).json({
            success: false,
            message: 'Failed to get earnings',
        });
    }
};


// ═══════════════════════════════════════════════════════════════════════════════
// 12. TOGGLE DRIVER MODE
// POST /api/deliveries/driver/mode
// ═══════════════════════════════════════════════════════════════════════════════

exports.toggleDriverMode = async (req, res) => {
    try {
        const { mode } = req.body;
        if (!['ride', 'delivery'].includes(mode)) {
            return res.status(400).json({ success: false, message: 'mode must be "ride" or "delivery"' });
        }

        const driver = await getDriverByAccountUuid(req.user.uuid);
        if (!driver) return res.status(404).json({ success: false, message: 'Driver record not found' });
        if (driver.status === 'busy') {
            return res.status(400).json({ success: false, message: 'Cannot switch mode during an active trip or delivery' });
        }
        if (req.user.user_type === 'DELIVERY_AGENT' && mode === 'ride') {
            return res.status(403).json({ success: false, message: 'Delivery agents cannot switch to ride mode' });
        }

        await Driver.update({ current_mode: mode }, { where: { id: driver.id } });
        debugPrint(`🔄 [DRIVER] ${req.user.uuid} switched to ${mode} mode`);

        return res.json({ success: true, message: `Switched to ${mode} mode`, currentMode: mode });

    } catch (error) {
        console.error('❌ [DELIVERY] toggleDriverMode error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to switch mode' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 13. GET WALLET BALANCE
// GET /api/deliveries/driver/wallet
// ═══════════════════════════════════════════════════════════════════════════════

exports.getWallet = async (req, res) => {
    try {
        const driver = await getDriverByAccountUuid(req.user.uuid);
        if (!driver) return res.status(404).json({ success: false, message: 'Driver record not found' });

        const wallet = await DeliveryWallet.findOne({ where: { driver_id: driver.id } });

        if (!wallet) {
            return res.json({
                success: true,
                wallet: {
                    exists:                false,
                    balance:               0,
                    availableBalance:      0,
                    reservedBalance:       0,
                    totalEarned:           0,
                    totalToppedUp:         0,
                    totalCashCollected:    0,
                    outstandingCommission: 0,
                    totalWithdrawn:        0,
                    pendingWithdrawal:     0,
                    status:                'active',
                    canAcceptJobs:         false,
                    message:               'Top up your wallet to start accepting deliveries',
                },
            });
        }

        return res.json({
            success: true,
            wallet: {
                exists:                true,
                id:                    wallet.id,
                balance:               wallet.balance,
                availableBalance:      wallet.availableBalance,
                reservedBalance:       wallet.reserved_balance,
                pendingWithdrawal:     wallet.pending_withdrawal,
                totalToppedUp:         wallet.total_topped_up,
                totalEarned:           wallet.total_earned,
                totalCashCollected:    wallet.total_cash_collected,
                totalCommissionOwed:   wallet.total_commission_owed,
                totalCommissionPaid:   wallet.total_commission_paid,
                outstandingCommission: wallet.outstandingCashCommission,
                totalWithdrawn:        wallet.total_withdrawn,
                status:                wallet.status,
                canAcceptJobs:         wallet.status === 'active' && wallet.availableBalance > 0,
                frozenReason:          wallet.status !== 'active' ? wallet.frozen_reason : null,
            },
        });

    } catch (error) {
        console.error('❌ [DELIVERY] getWallet error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to get wallet' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 14. REQUEST CASHOUT
// POST /api/deliveries/driver/cashout
// ═══════════════════════════════════════════════════════════════════════════════

exports.requestCashout = async (req, res) => {
    try {
        const { amount, payment_method, phone_number, notes } = req.body;

        if (!amount || !payment_method || !phone_number) {
            return res.status(400).json({ success: false, message: 'amount, payment_method, and phone_number are required' });
        }
        if (!['mtn_mobile_money', 'orange_money'].includes(payment_method)) {
            return res.status(400).json({ success: false, message: 'payment_method must be mtn_mobile_money or orange_money' });
        }

        const driver = await getDriverByAccountUuid(req.user.uuid);
        if (!driver) return res.status(404).json({ success: false, message: 'Driver record not found' });

        const request = await deliveryEarningsService.requestCashout(
            driver.id, parseFloat(amount), payment_method, phone_number.trim(), notes || null,
        );

        return res.status(201).json({
            success: true,
            message: 'Cashout request submitted. Admin will process it shortly.',
            request: {
                id:            request.id,
                payoutCode:    request.payout_code,
                amount:        request.amount,
                paymentMethod: request.payment_method,
                phoneNumber:   request.phone_number,
                status:        request.status,
                createdAt:     request.created_at,
            },
        });

    } catch (error) {
        console.error('❌ [DELIVERY] requestCashout error:', error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 15. CANCEL CASHOUT REQUEST
// POST /api/deliveries/driver/cashout/:requestId/cancel
// ═══════════════════════════════════════════════════════════════════════════════

exports.cancelCashout = async (req, res) => {
    try {
        const driver = await getDriverByAccountUuid(req.user.uuid);
        if (!driver) return res.status(404).json({ success: false, message: 'Driver record not found' });

        await deliveryEarningsService.cancelCashout(driver.id, parseInt(req.params.requestId));
        return res.json({ success: true, message: 'Cashout request cancelled' });

    } catch (error) {
        console.error('❌ [DELIVERY] cancelCashout error:', error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 16. GET WALLET TRANSACTIONS
// GET /api/deliveries/driver/wallet/transactions
// ═══════════════════════════════════════════════════════════════════════════════

exports.getWalletTransactions = async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;

        const driver = await getDriverByAccountUuid(req.user.uuid);
        if (!driver) return res.status(404).json({ success: false, message: 'Driver record not found' });

        const wallet = await DeliveryWallet.findOne({ where: { driver_id: driver.id } });
        if (!wallet) {
            return res.json({
                success:      true,
                transactions: [],
                pagination:   { total: 0, page: 1, limit: parseInt(limit), totalPages: 0 },
            });
        }

        const { count, rows } = await DeliveryWalletTransaction.findAndCountAll({
            where:  { wallet_id: wallet.id },
            order:  [['created_at', 'DESC']],
            limit:  parseInt(limit),
            offset: (parseInt(page) - 1) * parseInt(limit),
        });

        return res.json({
            success:      true,
            transactions: rows,
            pagination: {
                total:      count,
                page:       parseInt(page),
                limit:      parseInt(limit),
                totalPages: Math.ceil(count / parseInt(limit)),
            },
        });

    } catch (error) {
        console.error('❌ [DELIVERY] getWalletTransactions error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to get transactions' });
    }
};