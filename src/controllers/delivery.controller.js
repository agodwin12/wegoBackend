// src/controllers/delivery.controller.js

const { Op } = require('sequelize');
const {
    Delivery,
    DeliveryPricing,
    DeliverySurgeRule,
    Account,
    Driver,
} = require('../models');
const { redisClient, REDIS_KEYS, redisHelpers } = require('../config/redis');
const locationService         = require('../services/locationService');
const { sendSmsNotification } = require('../services/comm/sms.service');
const deliveryEarningsService = require('../services/deliveryEarningsService');
const { v4: uuidv4 }          = require('uuid');
const axios                   = require('axios');

// ─── Constants ────────────────────────────────────────────────────────────────
const DELIVERY_SEARCH_RADIUS_KM = parseFloat(process.env.DELIVERY_SEARCH_RADIUS_KM || 5);
const DELIVERY_OFFER_TTL_MS     = parseInt(process.env.DELIVERY_OFFER_TTL_MS || 25000, 10);

// Category metadata — emoji + label for driver display
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

// In-memory timeout map — deliveryId → setTimeout handle
const activeTimeouts = new Map();

// ─── Debug logger ─────────────────────────────────────────────────────────────
const debugPrint = (...args) => {
    if (process.env.NODE_ENV !== 'production') console.log(...args);
};

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

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
        const R    = 6371;
        const dLat = (destLat - originLat) * Math.PI / 180;
        const dLng = (destLng - originLng) * Math.PI / 180;
        const a    = Math.sin(dLat/2)**2
            + Math.cos(originLat * Math.PI/180) * Math.cos(destLat * Math.PI/180)
            * Math.sin(dLng/2)**2;
        const straightLine = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return {
            distanceKm:      parseFloat((straightLine * 1.3).toFixed(3)),
            durationSeconds: null, distanceText: null, durationText: null,
        };
    }
}

async function findPricingZone() {
    return DeliveryPricing.findOne({ where: { is_active: true }, order: [['id', 'ASC']] });
}

async function sendPinSms(recipientPhone, pin, deliveryCode) {
    try {
        const message = `WEGO Delivery ${deliveryCode}: Your delivery confirmation PIN is ${pin}. Share only with your driver upon arrival.`;
        await sendSmsNotification(recipientPhone, message);
        debugPrint(`📱 [DELIVERY] PIN SMS sent to ${recipientPhone} for ${deliveryCode}`);
    } catch (error) {
        console.error(`❌ [DELIVERY] PIN SMS failed:`, error.message);
    }
}

async function emitToDriver(io, driverId, event, data) {
    let emitted = false;
    const driverRoom = `driver:${driverId}`;
    if ((io.sockets.adapter.rooms.get(driverRoom)?.size || 0) > 0) {
        io.to(driverRoom).emit(event, data); emitted = true;
    }
    const userRoom = `user:${driverId}`;
    if ((io.sockets.adapter.rooms.get(userRoom)?.size || 0) > 0) {
        io.to(userRoom).emit(event, data); emitted = true;
    }
    const socketId = await redisClient.get(REDIS_KEYS.USER_SOCKET(driverId));
    if (socketId && io.sockets.sockets.get(socketId)) {
        io.to(socketId).emit(event, data); emitted = true;
    }
    return emitted;
}

async function emitToSender(io, senderUuid, event, data) {
    io.to(`passenger:${senderUuid}`).emit(event, data);
    io.to(`user:${senderUuid}`).emit(event, data);
    const socketId = await redisClient.get(REDIS_KEYS.USER_SOCKET(senderUuid));
    if (socketId && io.sockets.sockets.get(socketId)) io.to(socketId).emit(event, data);
}

async function getDriverByAccountUuid(accountUuid) {
    return Driver.findOne({
        where:      { userId: accountUuid },
        attributes: ['id', 'userId', 'status', 'current_mode', 'phone', 'rating', 'lat', 'lng'],
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 0. GET PACKAGE CATEGORIES
// GET /api/deliveries/categories
// Returns category list with emoji and labels for Flutter UI
// ═══════════════════════════════════════════════════════════════════════════════
exports.getCategories = (req, res) => {
    const categories = Delivery.PACKAGE_CATEGORIES.map(key => ({
        value:  key,
        label:  CATEGORY_META[key]?.label || key,
        emoji:  CATEGORY_META[key]?.emoji || '📦',
    }));
    return res.json({ success: true, categories });
};

// ═══════════════════════════════════════════════════════════════════════════════
// 1. GET FARE ESTIMATE
// GET /api/deliveries/estimate
// ═══════════════════════════════════════════════════════════════════════════════
exports.getEstimate = async (req, res) => {
    try {
        const { pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, package_size } = req.query;

        if (!pickup_lat || !pickup_lng || !dropoff_lat || !dropoff_lng || !package_size) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }
        if (!['small', 'medium', 'large'].includes(package_size)) {
            return res.status(400).json({ success: false, message: 'package_size must be small, medium, or large' });
        }

        const { distanceKm, durationSeconds, distanceText, durationText } = await getGoogleMapsDistance(
            parseFloat(pickup_lat), parseFloat(pickup_lng),
            parseFloat(dropoff_lat), parseFloat(dropoff_lng)
        );

        const pricingZone = await findPricingZone();
        if (!pricingZone) {
            return res.status(503).json({ success: false, message: 'Delivery service not available in your area' });
        }

        const { rule: surgeRule, multiplier: surgeMultiplier } = await DeliverySurgeRule.getActiveSurge(pricingZone.id);
        const priceBreakdown = pricingZone.calculatePrice(distanceKm, package_size, surgeMultiplier);

        return res.json({
            success: true,
            estimate: {
                ...priceBreakdown,
                distanceKm, durationSeconds, distanceText, durationText,
                pricingZoneId:   pricingZone.id,
                pricingZoneName: pricingZone.zone_name,
                surgeActive:     surgeMultiplier > 1.00,
                surgeRuleName:   surgeRule?.name || null,
                currency:        'XAF',
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
// ✅ Now requires: package_category + package_photo_url
// ═══════════════════════════════════════════════════════════════════════════════
exports.bookDelivery = async (req, res) => {
    try {
        const senderUuid = req.user.uuid;

        const {
            pickup_address, pickup_latitude, pickup_longitude, pickup_landmark,
            dropoff_address, dropoff_latitude, dropoff_longitude, dropoff_landmark,
            recipient_name, recipient_phone, recipient_note,
            package_size, package_category, package_description,
            package_photo_url,   // ✅ Required — uploaded by Flutter before calling this
            is_fragile,
            payment_method,
        } = req.body;

        // ── Required field validation ─────────────────────────────────────────
        const required = {
            pickup_address, pickup_latitude, pickup_longitude,
            dropoff_address, dropoff_latitude, dropoff_longitude,
            recipient_name, recipient_phone,
            package_size,
            package_category,   // ✅ Required
            package_photo_url,  // ✅ Required
            payment_method,
        };
        for (const [field, value] of Object.entries(required)) {
            if (!value && value !== 0) {
                return res.status(400).json({ success: false, message: `${field} is required` });
            }
        }

        // ── Enum validation ───────────────────────────────────────────────────
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

        // ── Photo URL validation ──────────────────────────────────────────────
        if (!package_photo_url.startsWith('http://') && !package_photo_url.startsWith('https://')) {
            return res.status(400).json({ success: false, message: 'package_photo_url must be a valid URL (upload to R2 first)' });
        }

        // ── Active delivery check ─────────────────────────────────────────────
        const activeDelivery = await Delivery.findOne({
            where: {
                sender_id: senderUuid,
                status:    { [Op.in]: ['searching','accepted','en_route_pickup','arrived_pickup','picked_up','en_route_dropoff','arrived_dropoff'] },
            },
        });
        if (activeDelivery) {
            return res.status(400).json({
                success:            false,
                message:            'You already have an active delivery in progress',
                activeDeliveryCode: activeDelivery.delivery_code,
            });
        }

        // ── Distance + pricing ────────────────────────────────────────────────
        const { distanceKm } = await getGoogleMapsDistance(
            parseFloat(pickup_latitude),  parseFloat(pickup_longitude),
            parseFloat(dropoff_latitude), parseFloat(dropoff_longitude)
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

        const { rule: surgeRule, multiplier: surgeMultiplier } = await DeliverySurgeRule.getActiveSurge(pricingZone.id);
        const priceBreakdown = pricingZone.calculatePrice(distanceKm, package_size, surgeMultiplier);

        // ── Generate code + PIN ───────────────────────────────────────────────
        const deliveryCode = await Delivery.generateDeliveryCode();
        const { plain: pinPlain, hashed: pinHashed } = await Delivery.generateDeliveryPin();

        // ── Create delivery record ────────────────────────────────────────────
        const delivery = await Delivery.create({
            delivery_code:    deliveryCode,
            sender_id:        senderUuid,
            driver_id:        null,
            recipient_name,
            recipient_phone,
            recipient_note:      recipient_note    || null,
            pickup_address,
            pickup_latitude:     parseFloat(pickup_latitude),
            pickup_longitude:    parseFloat(pickup_longitude),
            pickup_landmark:     pickup_landmark   || null,
            dropoff_address,
            dropoff_latitude:    parseFloat(dropoff_latitude),
            dropoff_longitude:   parseFloat(dropoff_longitude),
            dropoff_landmark:    dropoff_landmark  || null,
            package_size,
            package_category,                           // ✅ saved
            package_description: package_description || null,
            package_photo_url,                          // ✅ saved
            is_fragile:          is_fragile || false,
            pricing_zone_id:               pricingZone.id,
            distance_km:                   priceBreakdown.distanceKm,
            base_fee_applied:              priceBreakdown.baseFeeApplied,
            per_km_rate_applied:           priceBreakdown.perKmRateApplied,
            size_multiplier_applied:       priceBreakdown.sizeMultiplierApplied,
            surge_multiplier_applied:      priceBreakdown.surgeMultiplierApplied,
            surge_rule_id:                 surgeRule?.id || null,
            subtotal:                      priceBreakdown.subtotal,
            total_price:                   priceBreakdown.totalPrice,
            commission_percentage_applied: priceBreakdown.commissionPercentageApplied,
            commission_amount:             priceBreakdown.commissionAmount,
            driver_payout:                 priceBreakdown.driverPayout,
            payment_method,
            payment_status:  payment_method === 'cash' ? 'cash_pending' : 'pending',
            delivery_pin:    pinHashed,
            pin_attempts:    0,
            status:          'searching',
            search_attempts: 0,
        });

        debugPrint(`📦 [DELIVERY] Created ${deliveryCode} — ${package_category} (${package_size}) — ${priceBreakdown.totalPrice} XAF`);

        await sendPinSms(recipient_phone, pinPlain, deliveryCode);

        // ── Cache in Redis ────────────────────────────────────────────────────
        await redisHelpers.setJson(`delivery:active:${delivery.id}`, {
            id:              delivery.id,
            deliveryCode,
            senderId:        senderUuid,
            status:          'searching',
            pickupLat:       parseFloat(pickup_latitude),
            pickupLng:       parseFloat(pickup_longitude),
            dropoffLat:      parseFloat(dropoff_latitude),
            dropoffLng:      parseFloat(dropoff_longitude),
            totalPrice:      priceBreakdown.totalPrice,
            paymentMethod:   payment_method,
            packageSize:     package_size,
            packageCategory: package_category,   // ✅ cached for driver search
            packagePhotoUrl: package_photo_url,  // ✅ cached
            recipientName:   recipient_name,
            recipientPhone:  recipient_phone,
        }, 7200);

        await redisClient.set(`sender:active_delivery:${senderUuid}`, delivery.id, 'EX', 7200);

        const io = req.app.get('io');
        _searchForDriver(delivery.id, io).catch(err => {
            console.error(`❌ [DELIVERY] Driver search failed for ${deliveryCode}:`, err.message);
        });

        return res.status(201).json({
            success: true,
            message: 'Delivery booked. Searching for a driver...',
            delivery: {
                id:           delivery.id,
                deliveryCode,
                status:       'searching',
                totalPrice:   priceBreakdown.totalPrice,
                priceBreakdown: {
                    baseFee:         priceBreakdown.baseFeeApplied,
                    distanceFee:     parseFloat((priceBreakdown.distanceKm * priceBreakdown.perKmRateApplied).toFixed(2)),
                    sizeMultiplier:  priceBreakdown.sizeMultiplierApplied,
                    surgeMultiplier: priceBreakdown.surgeMultiplierApplied,
                    surgeActive:     priceBreakdown.isSurging,
                    total:           priceBreakdown.totalPrice,
                },
                packageSize:      package_size,
                packageCategory:  package_category,                         // ✅
                categoryLabel:    CATEGORY_META[package_category]?.label,   // ✅
                categoryEmoji:    CATEGORY_META[package_category]?.emoji,   // ✅
                packagePhotoUrl:  package_photo_url,                        // ✅
                recipientName,
                recipientPhone,
                paymentMethod:    payment_method,
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
    try {
        debugPrint(`\n🔍 [DELIVERY] Searching drivers for delivery #${deliveryId}`);

        const deliveryData = await redisHelpers.getJson(`delivery:active:${deliveryId}`);
        if (!deliveryData) return;

        const nearbyDrivers = await locationService.findNearbyDrivers(
            deliveryData.pickupLng, deliveryData.pickupLat, DELIVERY_SEARCH_RADIUS_KM
        );

        if (!nearbyDrivers || nearbyDrivers.length === 0) {
            await _handleNoDriversFound(deliveryId, deliveryData, io);
            return;
        }

        const nearbyIds = nearbyDrivers.map(d => d.driverId);
        const deliveryModeDrivers = await Driver.findAll({
            where: { id: nearbyIds, current_mode: 'delivery' }, attributes: ['id'],
        });
        const deliveryModeIds = new Set(deliveryModeDrivers.map(d => d.id));
        const filteredDrivers = nearbyDrivers.filter(d => deliveryModeIds.has(d.driverId));

        debugPrint(`✅ [DELIVERY] ${filteredDrivers.length}/${nearbyDrivers.length} in delivery mode`);

        if (filteredDrivers.length === 0) {
            await _handleNoDriversFound(deliveryId, deliveryData, io);
            return;
        }

        const delivery = await Delivery.findByPk(deliveryId, {
            include: [{ association: 'sender', attributes: ['uuid','first_name','last_name'] }],
        });
        if (!delivery) return;

        // ✅ Include package_category and package_photo_url in offer to drivers
        const deliveryOffer = {
            deliveryId:         delivery.id,
            deliveryCode:       delivery.delivery_code,
            packageSize:        delivery.package_size,
            packageCategory:    delivery.package_category,                        // ✅
            categoryLabel:      CATEGORY_META[delivery.package_category]?.label,  // ✅
            categoryEmoji:      CATEGORY_META[delivery.package_category]?.emoji,  // ✅
            packagePhotoUrl:    delivery.package_photo_url,                       // ✅
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
            distanceKm:      parseFloat(delivery.distance_km),
            totalPrice:      parseFloat(delivery.total_price),
            driverPayout:    parseFloat(delivery.driver_payout),
            paymentMethod:   delivery.payment_method,
            isSurging:       parseFloat(delivery.surge_multiplier_applied) > 1.00,
            surgeMultiplier: parseFloat(delivery.surge_multiplier_applied),
            sender: {
                name: `${delivery.sender?.first_name || ''} ${delivery.sender?.last_name || ''}`.trim(),
            },
            expiresAt: Date.now() + DELIVERY_OFFER_TTL_MS,
            expiresIn: Math.floor(DELIVERY_OFFER_TTL_MS / 1000),
        };

        const notifiedDriverIds = [];
        for (const driver of filteredDrivers) {
            const emitted = await emitToDriver(io, driver.driverId, 'delivery:new_request', {
                ...deliveryOffer,
                distanceToPickup:   Math.round(driver.distance * 1000),
                distanceToPickupKm: driver.distance,
            });
            if (emitted) {
                notifiedDriverIds.push(driver.driverId);
                debugPrint(`📤 [DELIVERY] Offer → driver ${driver.driverId} (${driver.distance.toFixed(2)} km)`);
            }
        }

        if (notifiedDriverIds.length === 0) {
            await _handleNoDriversFound(deliveryId, deliveryData, io);
            return;
        }

        await redisHelpers.setJson(`delivery:offers:${deliveryId}`, {
            drivers: notifiedDriverIds, broadcastAt: Date.now(),
            expiresAt: Date.now() + DELIVERY_OFFER_TTL_MS,
        }, Math.ceil(DELIVERY_OFFER_TTL_MS / 1000) + 60);

        await delivery.increment('search_attempts');

        const timeoutId = setTimeout(async () => {
            await _handleDeliveryTimeout(deliveryId, io);
            activeTimeouts.delete(deliveryId);
        }, DELIVERY_OFFER_TTL_MS);
        activeTimeouts.set(deliveryId, timeoutId);

        debugPrint(`✅ [DELIVERY] Broadcast done — ${notifiedDriverIds.length} drivers notified`);

    } catch (error) {
        console.error(`❌ [DELIVERY] _searchForDriver error:`, error.message);
    }
}

async function _handleDeliveryTimeout(deliveryId, io) {
    try {
        const deliveryData = await redisHelpers.getJson(`delivery:active:${deliveryId}`);
        if (!deliveryData || deliveryData.status !== 'searching') return;

        await Delivery.update({ status: 'expired' }, { where: { id: deliveryId, status: 'searching' } });
        await redisClient.del(`delivery:active:${deliveryId}`);
        await redisClient.del(`delivery:offers:${deliveryId}`);
        await redisClient.del(`sender:active_delivery:${deliveryData.senderId}`);

        await emitToSender(io, deliveryData.senderId, 'delivery:no_drivers', {
            deliveryId, deliveryCode: deliveryData.deliveryCode,
            message: 'No drivers available right now. Please try again.',
        });
    } catch (error) {
        console.error(`❌ [DELIVERY] Timeout handler error:`, error.message);
    }
}

async function _handleNoDriversFound(deliveryId, deliveryData, io) {
    await Delivery.update({ status: 'expired' }, { where: { id: deliveryId } });
    await redisClient.del(`delivery:active:${deliveryId}`);
    await redisClient.del(`sender:active_delivery:${deliveryData.senderId}`);
    await emitToSender(io, deliveryData.senderId, 'delivery:no_drivers', {
        deliveryId, message: 'No delivery drivers available nearby. Please try again later.',
    });
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
        const io          = req.app.get('io');

        const driver = await getDriverByAccountUuid(accountUuid);
        if (!driver) return res.status(404).json({ success: false, message: 'Driver record not found' });
        if (driver.current_mode !== 'delivery') return res.status(400).json({ success: false, message: 'Switch to delivery mode first' });
        if (driver.status !== 'online') return res.status(400).json({ success: false, message: 'You must be online to accept deliveries' });

        const lockAcquired = await redisClient.set(lockKey, lockValue, 'EX', 10, 'NX');
        if (!lockAcquired) return res.status(409).json({ success: false, message: 'Delivery already being accepted' });

        try {
            const delivery = await Delivery.findByPk(deliveryId, {
                include: [{ association: 'sender', attributes: ['uuid','first_name','last_name','phone_e164'] }],
            });

            if (!delivery) return res.status(404).json({ success: false, message: 'Delivery not found' });
            if (delivery.status !== 'searching') return res.status(409).json({ success: false, message: 'Delivery no longer available' });

            const timeoutId = activeTimeouts.get(deliveryId);
            if (timeoutId) { clearTimeout(timeoutId); activeTimeouts.delete(deliveryId); }

            await delivery.transitionTo('accepted', { driver_id: driver.id });

            const deliveryData = await redisHelpers.getJson(`delivery:active:${deliveryId}`);
            if (deliveryData) {
                deliveryData.status   = 'accepted';
                deliveryData.driverId = driver.id;
                await redisHelpers.setJson(`delivery:active:${deliveryId}`, deliveryData, 7200);
            }

            await locationService.updateDriverStatus(driver.id, 'busy', null);

            const offersData = await redisHelpers.getJson(`delivery:offers:${deliveryId}`);
            for (const otherId of (offersData?.drivers || []).filter(id => id !== driver.id)) {
                await emitToDriver(io, otherId, 'delivery:request_expired', { deliveryId });
            }
            await redisClient.del(`delivery:offers:${deliveryId}`);

            await emitToSender(io, delivery.sender_id, 'delivery:driver_assigned', {
                deliveryId,
                deliveryCode: delivery.delivery_code,
                status:       'accepted',
                driver: {
                    id:     driver.id,
                    name:   `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim(),
                    phone:  driver.phone || req.user.phone_e164,
                    rating: driver.rating,
                    avatar: req.user.avatar_url || null,
                },
            });

            debugPrint(`✅ [DELIVERY] ${delivery.delivery_code} accepted by ${accountUuid}`);

            // ✅ Driver response includes category and photo
            return res.json({
                success:  true,
                message:  'Delivery accepted',
                delivery: {
                    id:                 delivery.id,
                    deliveryCode:       delivery.delivery_code,
                    status:             'accepted',
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
                    packageCategory:    delivery.package_category,                       // ✅
                    categoryLabel:      CATEGORY_META[delivery.package_category]?.label, // ✅
                    categoryEmoji:      CATEGORY_META[delivery.package_category]?.emoji, // ✅
                    packagePhotoUrl:    delivery.package_photo_url,                      // ✅
                    packageDescription: delivery.package_description,
                    isFragile:          delivery.is_fragile,
                    totalPrice:         parseFloat(delivery.total_price),
                    driverPayout:       parseFloat(delivery.driver_payout),
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
        const accountUuid = req.user.uuid;
        const deliveryId  = parseInt(req.params.id);
        const { status, pickup_photo_url } = req.body;
        const io = req.app.get('io');

        const validStatuses = ['en_route_pickup','arrived_pickup','picked_up','en_route_dropoff','arrived_dropoff'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ success: false, message: `Invalid status. Must be: ${validStatuses.join(', ')}` });
        }

        const driver = await getDriverByAccountUuid(accountUuid);
        if (!driver) return res.status(404).json({ success: false, message: 'Driver record not found' });

        const delivery = await Delivery.findOne({ where: { id: deliveryId, driver_id: driver.id } });
        if (!delivery) return res.status(404).json({ success: false, message: 'Delivery not found' });

        if (!delivery.canTransitionTo(status)) {
            return res.status(400).json({ success: false, message: `Cannot transition from ${delivery.status} to ${status}` });
        }

        const extraFields = {};
        if (status === 'picked_up' && pickup_photo_url) extraFields.pickup_photo_url = pickup_photo_url;

        await delivery.transitionTo(status, extraFields);

        const deliveryData = await redisHelpers.getJson(`delivery:active:${deliveryId}`);
        if (deliveryData) {
            deliveryData.status = status;
            await redisHelpers.setJson(`delivery:active:${deliveryId}`, deliveryData, 7200);
        }

        const statusEvents = {
            en_route_pickup:  { event: 'delivery:driver_en_route',       message: 'Driver is on the way to pick up your package' },
            arrived_pickup:   { event: 'delivery:driver_arrived_pickup',  message: 'Driver has arrived at pickup location' },
            picked_up:        { event: 'delivery:package_picked_up',      message: 'Your package has been picked up' },
            en_route_dropoff: { event: 'delivery:en_route_dropoff',       message: 'Driver is heading to the delivery address' },
            arrived_dropoff:  { event: 'delivery:driver_arrived_dropoff', message: 'Driver has arrived — please share your PIN' },
        };

        const { event, message } = statusEvents[status];
        await emitToSender(io, delivery.sender_id, event, {
            deliveryId, deliveryCode: delivery.delivery_code, status, message,
            timestamp: new Date().toISOString(),
            ...(status === 'picked_up' && pickup_photo_url && { pickupPhotoUrl: pickup_photo_url }),
        });

        debugPrint(`📦 [DELIVERY] ${delivery.delivery_code} → ${status}`);
        return res.json({ success: true, status, message });

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
        const io          = req.app.get('io');

        if (!pin) return res.status(400).json({ success: false, message: 'PIN is required' });

        const driver = await getDriverByAccountUuid(accountUuid);
        if (!driver) return res.status(404).json({ success: false, message: 'Driver record not found' });

        const delivery = await Delivery.findOne({ where: { id: deliveryId, driver_id: driver.id } });
        if (!delivery) return res.status(404).json({ success: false, message: 'Delivery not found' });

        if (delivery.status !== 'arrived_dropoff') {
            return res.status(400).json({ success: false, message: 'Mark arrived at dropoff before verifying PIN' });
        }

        const result = await Delivery.verifyPin(delivery, pin);
        if (!result.success) {
            return res.status(400).json({ success: false, message: result.message, locked: result.locked || false });
        }

        await delivery.transitionTo('delivered');

        if (delivery.payment_method === 'cash') {
            await delivery.update({ payment_status: 'cash_pending' });
        }

        // ── Post earnings (non-blocking) ──────────────────────────────────────
        deliveryEarningsService.postDeliveryEarnings(delivery.id).then(() => {
            debugPrint(`💰 [DELIVERY] Earnings posted for ${delivery.delivery_code}`);
        }).catch(earningsErr => {
            console.error(`❌ [DELIVERY] Earnings posting FAILED for ${delivery.delivery_code}:`, earningsErr.message);
        });

        await locationService.updateDriverStatus(driver.id, 'online', null);
        await redisClient.del(`delivery:active:${deliveryId}`);
        await redisClient.del(`sender:active_delivery:${delivery.sender_id}`);

        await emitToSender(io, delivery.sender_id, 'delivery:completed', {
            deliveryId, deliveryCode: delivery.delivery_code,
            status: 'delivered', totalPrice: parseFloat(delivery.total_price),
            paymentMethod: delivery.payment_method,
            message: 'Your package has been delivered!',
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
        const io          = req.app.get('io');

        const driver = await getDriverByAccountUuid(accountUuid);
        if (!driver) return res.status(404).json({ success: false, message: 'Driver record not found' });

        const delivery = await Delivery.findOne({
            where: {
                id: deliveryId, driver_id: driver.id,
                payment_method: 'cash', status: 'delivered', payment_status: 'cash_pending',
            },
        });
        if (!delivery) return res.status(404).json({ success: false, message: 'Delivery not found or cash already confirmed' });

        await delivery.update({ payment_status: 'cash_confirmed', paid_at: new Date() });

        await emitToSender(io, delivery.sender_id, 'delivery:payment_confirmed', {
            deliveryId, deliveryCode: delivery.delivery_code,
            paymentMethod: 'cash', amount: parseFloat(delivery.total_price),
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
        const io         = req.app.get('io');

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

        if (['picked_up','en_route_dropoff','arrived_dropoff','delivered'].includes(delivery.status)) {
            return res.status(400).json({ success: false, message: 'Cannot cancel after pickup. Please file a dispute.' });
        }
        if (!delivery.canTransitionTo('cancelled')) {
            return res.status(400).json({ success: false, message: 'Delivery cannot be cancelled at this stage' });
        }

        const cancelledBy = isDriver ? 'driver' : 'sender';
        await delivery.transitionTo('cancelled', { cancelled_by: cancelledBy, cancellation_reason: reason || null });

        if (delivery.driver_id) {
            await locationService.updateDriverStatus(delivery.driver_id, 'online', null);
            await emitToDriver(io, delivery.driver_id, 'delivery:cancelled', {
                deliveryId, deliveryCode: delivery.delivery_code, cancelledBy, reason: reason || null,
            });
        }

        const timeoutId = activeTimeouts.get(deliveryId);
        if (timeoutId) { clearTimeout(timeoutId); activeTimeouts.delete(deliveryId); }
        await redisClient.del(`delivery:active:${deliveryId}`);
        await redisClient.del(`delivery:offers:${deliveryId}`);
        await redisClient.del(`sender:active_delivery:${delivery.sender_id}`);

        if (cancelledBy === 'driver') {
            await emitToSender(io, delivery.sender_id, 'delivery:cancelled', {
                deliveryId, deliveryCode: delivery.delivery_code,
                cancelledBy: 'driver', message: 'The driver cancelled your delivery. Please rebook.',
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
        const senderUuid = req.user.uuid;
        const deliveryId = parseInt(req.params.id);
        const { rating, comment } = req.body;

        if (!rating || rating < 1 || rating > 5) {
            return res.status(400).json({ success: false, message: 'Rating must be between 1 and 5' });
        }

        const delivery = await Delivery.findOne({ where: { id: deliveryId, sender_id: senderUuid, status: 'delivered' } });
        if (!delivery) return res.status(404).json({ success: false, message: 'Delivery not found or not completed' });
        if (delivery.rated_at) return res.status(400).json({ success: false, message: 'Already rated this delivery' });

        await delivery.update({ rating: parseFloat(rating), rating_comment: comment || null, rated_at: new Date() });

        const driverDeliveries = await Delivery.findAll({
            where: { driver_id: delivery.driver_id, rating: { [Op.not]: null } },
            attributes: ['rating'],
        });
        if (driverDeliveries.length > 0) {
            const avg = driverDeliveries.reduce((s, d) => s + parseFloat(d.rating), 0) / driverDeliveries.length;
            await Driver.update({ rating: parseFloat(avg.toFixed(2)) }, { where: { id: delivery.driver_id } });
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
                { association: 'sender',      attributes: ['uuid','first_name','last_name','phone_e164','avatar_url'] },
                { association: 'driver',       attributes: ['id','phone','rating','lat','lng'] },
                { association: 'pricingZone', attributes: ['id','zone_name'] },
                { association: 'surgeRule',   attributes: ['id','name','multiplier'] },
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

        const response = delivery.toJSON();
        delete response.delivery_pin;

        // ✅ Add category metadata to response
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
            include: [{ association: 'driver', attributes: ['id','phone','rating'] }],
            order:   [['created_at', 'DESC']],
            limit:   parseInt(limit),
            offset:  (parseInt(page) - 1) * parseInt(limit),
        });

        const deliveries = rows.map(d => {
            const obj = d.toJSON();
            delete obj.delivery_pin;
            obj.categoryLabel = CATEGORY_META[obj.package_category]?.label || 'Other';
            obj.categoryEmoji = CATEGORY_META[obj.package_category]?.emoji || '📦';
            return obj;
        });

        return res.json({
            success: true, deliveries,
            pagination: { total: count, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(count / limit) },
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
        if (!driver) return res.status(404).json({ success: false, message: 'Driver record not found' });

        const where = { driver_id: driver.id };
        if (status) where.status = status;

        const { count, rows } = await Delivery.findAndCountAll({
            where, order: [['created_at', 'DESC']],
            limit: parseInt(limit), offset: (parseInt(page) - 1) * parseInt(limit),
        });

        const deliveries = rows.map(d => {
            const obj = d.toJSON();
            delete obj.delivery_pin;
            obj.categoryLabel = CATEGORY_META[obj.package_category]?.label || 'Other';
            obj.categoryEmoji = CATEGORY_META[obj.package_category]?.emoji || '📦';
            return obj;
        });

        return res.json({
            success: true, deliveries,
            pagination: { total: count, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(count / limit) },
        });

    } catch (error) {
        console.error('❌ [DELIVERY] getDriverDeliveries error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to get driver deliveries' });
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

        const wallet = await deliveryEarningsService.getWallet(driver.id);

        if (!wallet) {
            return res.json({
                success: true,
                wallet: {
                    exists: false, balance: 0, availableBalance: 0,
                    totalEarned: 0, totalCashCollected: 0, outstandingCommission: 0,
                    totalWithdrawn: 0, pendingWithdrawal: 0, status: 'active',
                    message: 'Complete your first delivery to activate your wallet',
                },
            });
        }

        return res.json({
            success: true,
            wallet: {
                exists:               true,
                id:                   wallet.id,
                balance:              wallet.balance,
                availableBalance:     wallet.availableBalance,
                totalEarned:          wallet.total_earned,
                totalCashCollected:   wallet.total_cash_collected,
                totalCommissionOwed:  wallet.total_commission_owed,
                totalCommissionPaid:  wallet.total_commission_paid,
                outstandingCommission:wallet.outstandingCashCommission,
                totalWithdrawn:       wallet.total_withdrawn,
                pendingWithdrawal:    wallet.pending_withdrawal,
                status:               wallet.status,
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
            driver.id, parseFloat(amount), payment_method, phone_number.trim(), notes || null
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
        const { DeliveryWallet, DeliveryWalletTransaction } = require('../models');

        const driver = await getDriverByAccountUuid(req.user.uuid);
        if (!driver) return res.status(404).json({ success: false, message: 'Driver record not found' });

        const wallet = await DeliveryWallet.findOne({ where: { driver_id: driver.id } });
        if (!wallet) {
            return res.json({
                success: true, transactions: [],
                pagination: { total: 0, page: 1, limit: parseInt(limit), totalPages: 0 },
            });
        }

        const { count, rows } = await DeliveryWalletTransaction.findAndCountAll({
            where:  { wallet_id: wallet.id },
            order:  [['created_at', 'DESC']],
            limit:  parseInt(limit),
            offset: (parseInt(page) - 1) * parseInt(limit),
        });

        return res.json({
            success: true, transactions: rows,
            pagination: {
                total: count, page: parseInt(page),
                limit: parseInt(limit), totalPages: Math.ceil(count / parseInt(limit)),
            },
        });

    } catch (error) {
        console.error('❌ [DELIVERY] getWalletTransactions error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to get transactions' });
    }
};