// src/services/delivery/deliverySocket.service.js
//
// ═══════════════════════════════════════════════════════════════════════════════
// DELIVERY SOCKET SERVICE
// ═══════════════════════════════════════════════════════════════════════════════
//
// Handles all real-time delivery events, routing them based on delivery_type:
//
//   EXPRESS deliveries:
//     → Driver location is streamed to the sender every time the driver
//       emits a GPS update via 'driver:location' socket event.
//     → The sender's app receives 'delivery:driver_location' continuously,
//       allowing a live moving-map experience.
//     → Tracking points are written to DeliveryTracking table (dense — every 3-5s).
//
//   REGULAR deliveries:
//     → No live map. Driver location is NOT forwarded to the sender.
//     → Sender receives 'delivery:status_updated' only when the driver
//       moves between stages (en_route_pickup, arrived_pickup, etc.).
//     → Tracking points still written but sparsely (every 30-60s).
//
// Integration with existing socket infrastructure:
//   This service is called FROM locationHandlers.js (where driver:location
//   is already handled for the ride module). The caller passes the socket,
//   io, and location payload — this service handles delivery-specific logic.
//
// Usage in locationHandlers.js:
//   const deliverySocketService = require('../services/delivery/deliverySocket.service');
//
//   socket.on('driver:location', async (data) => {
//       // ... existing ride location handling ...
//
//       // NEW: If driver is in delivery mode and has an active delivery, handle it
//       if (socket.currentMode === 'delivery') {
//           await deliverySocketService.handleDriverLocationUpdate(socket, io, data);
//       }
//   });
//
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const { redisClient, redisHelpers } = require('../../config/redis');
const { DeliveryTracking, Delivery, Driver } = require('../../models');

// ─── Constants ────────────────────────────────────────────────────────────────

// Express: record every GPS ping (called ~every 3-5s by the app)
// Regular: only record if at least this many seconds have passed since last point
const REGULAR_TRACKING_INTERVAL_S = 30;

// GPS accuracy threshold — discard points worse than this
const MAX_ACCURACY_METERS = 100;

// Redis key patterns
const DELIVERY_ACTIVE_KEY   = (id)      => `delivery:active:${id}`;
const DRIVER_DELIVERY_KEY   = (driverId) => `driver:active_delivery:${driverId}`;
const LAST_TRACK_TIME_KEY   = (driverId) => `delivery:last_track:${driverId}`;

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Emit to sender reliably — tries passenger room, user room, then direct socket.
 */
async function emitToSender(io, senderUuid, event, data) {
    io.to(`passenger:${senderUuid}`).emit(event, data);
    io.to(`user:${senderUuid}`).emit(event, data);
    try {
        const socketId = await redisClient.get(`socket:user:${senderUuid}`);
        if (socketId && io.sockets.sockets.get(socketId)) {
            io.to(socketId).emit(event, data);
        }
    } catch (_) { /* Redis miss is non-fatal */ }
}

/**
 * Resolve the current active delivery for a driver from Redis.
 * Falls back to DB if Redis cache is cold.
 *
 * @param {string} driverId
 * @returns {Promise<{deliveryId: number, deliveryType: string, senderId: string}|null>}
 */
async function resolveActiveDelivery(driverId) {
    // Fast path: Redis
    try {
        const deliveryId = await redisClient.get(DRIVER_DELIVERY_KEY(driverId));
        if (deliveryId) {
            const cached = await redisHelpers.getJson(DELIVERY_ACTIVE_KEY(deliveryId));
            if (cached && ['accepted','en_route_pickup','arrived_pickup','picked_up','en_route_dropoff','arrived_dropoff'].includes(cached.status)) {
                return {
                    deliveryId:   parseInt(deliveryId),
                    deliveryType: cached.deliveryType || 'regular',
                    senderId:     cached.senderId,
                    status:       cached.status,
                };
            }
        }
    } catch (_) { /* Redis miss — fall through to DB */ }

    // Slow path: DB
    const delivery = await Delivery.findOne({
        where: {
            driver_id: driverId,
            status:    ['accepted','en_route_pickup','arrived_pickup','picked_up','en_route_dropoff','arrived_dropoff'],
        },
        attributes: ['id', 'delivery_type', 'sender_id', 'status'],
        order:      [['accepted_at', 'DESC']],
    });

    if (!delivery) return null;

    return {
        deliveryId:   delivery.id,
        deliveryType: delivery.delivery_type || 'regular',
        senderId:     delivery.sender_id,
        status:       delivery.status,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT — called by locationHandlers.js on every driver:location event
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle a GPS location update from a driver in delivery mode.
 *
 * @param {import('socket.io').Socket} socket
 * @param {import('socket.io').Server} io
 * @param {object} data
 * @param {number}  data.lat
 * @param {number}  data.lng
 * @param {number}  [data.heading]
 * @param {number}  [data.speed_kmh]
 * @param {number}  [data.accuracy_meters]
 */
async function handleDriverLocationUpdate(socket, io, data) {
    const driverId = socket.userId;

    if (!driverId) return;

    // Discard inaccurate GPS readings
    if (data.accuracy_meters && data.accuracy_meters > MAX_ACCURACY_METERS) {
        return;
    }

    const { lat, lng, heading = null, speed_kmh = null, accuracy_meters = null } = data;

    if (!lat || !lng) return;

    try {
        const activeDelivery = await resolveActiveDelivery(driverId);
        if (!activeDelivery) return; // Driver has no active delivery

        const { deliveryId, deliveryType, senderId, status } = activeDelivery;

        // Determine current phase for tracking record
        const phase = statusToTrackingPhase(status);

        if (deliveryType === 'express') {
            // ── EXPRESS: stream every ping to sender + write dense tracking ──
            await handleExpressLocationUpdate(io, {
                driverId, deliveryId, senderId, phase,
                lat, lng, heading, speed_kmh, accuracy_meters,
            });
        } else {
            // ── REGULAR: throttled tracking only, no live stream to sender ──
            await handleRegularLocationUpdate(driverId, {
                deliveryId, phase,
                lat, lng, heading, speed_kmh, accuracy_meters,
            });
        }

    } catch (error) {
        console.error(`❌ [DELIVERY SOCKET] handleDriverLocationUpdate error for driver ${driverId}:`, error.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPRESS HANDLER
// ─────────────────────────────────────────────────────────────────────────────

async function handleExpressLocationUpdate(io, { driverId, deliveryId, senderId, phase, lat, lng, heading, speed_kmh, accuracy_meters }) {
    // 1. Write every point to DeliveryTracking (dense trail)
    await DeliveryTracking.record({
        deliveryId,
        driverId,
        latitude:        lat,
        longitude:       lng,
        bearing:         heading,
        speedKmh:        speed_kmh,
        accuracyMeters:  accuracy_meters,
        phase,
    });

    // 2. Cache latest driver position in Redis (for live monitor + reconnect replay)
    await redisClient.setEx(
        `driver:live:${driverId}`,
        300, // 5 minute TTL — auto-clears if driver goes offline
        JSON.stringify({ lat, lng, heading, speed_kmh, updatedAt: Date.now() })
    );

    // 3. Stream real-time location to the sender's app
    await emitToSender(io, senderId, 'delivery:driver_location', {
        deliveryId,
        driver: {
            lat,
            lng,
            heading:   heading || null,
            speed_kmh: speed_kmh || null,
        },
        phase,
        timestamp: new Date().toISOString(),
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// REGULAR HANDLER
// ─────────────────────────────────────────────────────────────────────────────

async function handleRegularLocationUpdate(driverId, { deliveryId, phase, lat, lng, heading, speed_kmh, accuracy_meters }) {
    // Throttle: only write a tracking point every REGULAR_TRACKING_INTERVAL_S seconds
    const lastTrackKey = LAST_TRACK_TIME_KEY(driverId);
    const lastTrack    = await redisClient.get(lastTrackKey);

    if (lastTrack) {
        const secondsSinceLast = (Date.now() - parseInt(lastTrack)) / 1000;
        if (secondsSinceLast < REGULAR_TRACKING_INTERVAL_S) {
            return; // Too soon — skip this point
        }
    }

    await DeliveryTracking.record({
        deliveryId,
        driverId,
        latitude:       lat,
        longitude:      lng,
        bearing:        heading,
        speedKmh:       speed_kmh,
        accuracyMeters: accuracy_meters,
        phase,
    });

    // Update throttle timestamp
    await redisClient.setEx(lastTrackKey, REGULAR_TRACKING_INTERVAL_S + 10, Date.now().toString());

    // NOTE: No location event emitted to sender for regular deliveries.
    // Sender only receives status stage events via delivery:status_updated.
}

// ═══════════════════════════════════════════════════════════════════════════════
// STAGE UPDATE EMITTER
// Called by delivery.controller.js updateStatus() for both delivery types
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Emit a stage change event to the sender.
 * Used for both regular (primary notification) and express (supplementary).
 *
 * @param {import('socket.io').Server} io
 * @param {string} senderUuid
 * @param {object} payload
 * @param {number}  payload.deliveryId
 * @param {string}  payload.deliveryCode
 * @param {string}  payload.deliveryType
 * @param {string}  payload.status
 * @param {string}  [payload.pickupPhotoUrl]
 * @param {object}  [payload.driverLocation]  - current lat/lng snapshot for regular
 */
async function emitStageUpdate(io, senderUuid, payload) {
    const event = 'delivery:status_updated';

    const data = {
        deliveryId:      payload.deliveryId,
        deliveryCode:    payload.deliveryCode,
        deliveryType:    payload.deliveryType,
        status:          payload.status,
        statusLabel:     statusToLabel(payload.status),
        pickupPhotoUrl:  payload.pickupPhotoUrl  || null,
        // For regular deliveries, send a one-off location snapshot so the sender
        // can show an approximate position on a static map thumbnail
        driverLocation:  payload.driverLocation  || null,
        timestamp:       new Date().toISOString(),
    };

    await emitToSender(io, senderUuid, event, data);

    console.log(`📡 [DELIVERY SOCKET] Stage update: ${payload.deliveryCode} → ${payload.status} (${payload.deliveryType})`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DRIVER ROOM MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Join the driver to a delivery-specific socket room on accept.
 * This allows targeted events without broadcasting to unrelated rooms.
 * Room name: `delivery:${deliveryId}`
 *
 * @param {import('socket.io').Socket} socket
 * @param {number} deliveryId
 */
function joinDeliveryRoom(socket, deliveryId) {
    const room = `delivery:${deliveryId}`;
    socket.join(room);
    console.log(`🚪 [DELIVERY SOCKET] Driver ${socket.userId} joined room ${room}`);
}

/**
 * Remove driver from delivery room on completion or cancellation.
 *
 * @param {import('socket.io').Socket} socket
 * @param {number} deliveryId
 */
function leaveDeliveryRoom(socket, deliveryId) {
    const room = `delivery:${deliveryId}`;
    socket.leave(room);
    console.log(`🚪 [DELIVERY SOCKET] Driver ${socket.userId} left room ${room}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Map delivery status → tracking phase string stored in DeliveryTracking.
 */
function statusToTrackingPhase(status) {
    const map = {
        accepted:        'en_route_pickup',
        en_route_pickup: 'en_route_pickup',
        arrived_pickup:  'at_pickup',
        picked_up:       'en_route_dropoff',
        en_route_dropoff:'en_route_dropoff',
        arrived_dropoff: 'at_dropoff',
        delivered:       'completed',
    };
    return map[status] || 'unknown';
}

/**
 * Map delivery status → human-readable label for the sender's UI.
 */
function statusToLabel(status) {
    const labels = {
        accepted:         'Driver assigned',
        en_route_pickup:  'Driver on the way',
        arrived_pickup:   'Driver arrived at pickup',
        picked_up:        'Package picked up',
        en_route_dropoff: 'Package on the way to you',
        arrived_dropoff:  'Driver arrived at destination',
        delivered:        'Delivered',
        cancelled:        'Cancelled',
    };
    return labels[status] || status;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
    handleDriverLocationUpdate,
    emitStageUpdate,
    joinDeliveryRoom,
    leaveDeliveryRoom,
    statusToTrackingPhase,
    statusToLabel,
};