// src/sockets/locationHandlers.js
//
// Handles all driver GPS location events from the mobile app.
//
// Events handled:
//   driver:location_update  — emitted by delivery agent app (every 3–15s)
//   driver:location         — emitted by ride-hailing driver app
//   location:nearby_drivers — debug/admin tool
//
// Mode routing:
//   current_mode = 'ride'     → update Redis geo-index + forward to trip passenger
//   current_mode = 'delivery' → update Redis geo-index + delegate to deliverySocketService
//
// IMPORTANT — key alignment:
//   locationService / Redis geo-index  : keyed by Account.uuid  (socket.userId)
//   deliverySocketService Redis keys   : keyed by Driver.id     (integer)
//   acceptDelivery sets:
//     driver:active_delivery:{Driver.id}
//   So before calling deliverySocketService we temporarily set
//   socket.userId = driver.id (integer) then restore it after.
//
// The ride-hailing section is UNCHANGED from the working version.

'use strict';

const { Driver, Trip }      = require('../models');
const { redisClient,
    redisHelpers,
    REDIS_KEYS }        = require('../config/redis');
const locationService       = require('../services/locationService');
const deliverySocketService = require('../services/delivery/deliverySocket.service');

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_ACCURACY_METERS = 100;

const ACTIVE_TRIP_STATUSES = [
    'MATCHED', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Write driver position into Redis geo-index AND the JSON location store.
 * Both are required:
 *   - DRIVERS_GEO       → locationService.findNearbyDrivers() reads this
 *   - driver:location:* → deliverySocketService + admin monitor reads this
 */
async function _updateRedisGeo(accountUuid, lat, lng, heading, speedKmh, accuracy) {
    await redisClient.geoadd(
        REDIS_KEYS.DRIVERS_GEO,
        parseFloat(lng),
        parseFloat(lat),
        accountUuid.toString(),
    );

    await redisHelpers.setJson(`driver:location:${accountUuid}`, {
        driverId:    accountUuid,
        lat:         parseFloat(lat),
        lng:         parseFloat(lng),
        heading:     heading  || 0,
        speed:       speedKmh || 0,
        accuracy:    accuracy || 10,
        lastUpdated: new Date().toISOString(),
    }, 3600);
}

/**
 * Persist lat/lng to Driver DB row — fire-and-forget, never blocks the event.
 */
function _persistToDb(driverDbId, lat, lng, heading, speedKmh) {
    Driver.update(
        { lat, lng, heading, lastHeartbeat: new Date() },
        { where: { id: driverDbId } },
    ).catch(err =>
        console.error(`⚠️  [LOCATION] DB persist error driver#${driverDbId}:`, err.message),
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE HANDLER — called by both event names
// ═══════════════════════════════════════════════════════════════════════════════

async function _handleLocationEvent(io, socket, data) {
    try {
        // Gate: only drivers emit location
        if (socket.userType !== 'DRIVER' && socket.userType !== 'DELIVERY_AGENT') {
            return socket.emit('error', { message: 'Only drivers can update location' });
        }

        const accountUuid = socket.userId; // Account.uuid — always stable on this socket

        const {
            lat,
            lng,
            heading         = 0,
            speed           = 0,      // m/s from ride app
            speed_kmh       = null,   // km/h from delivery app
            accuracy        = 10,
            accuracy_meters = null,   // alias from delivery app
        } = data || {};

        // Validate
        if (!lat || !lng) return; // silent — cold GPS sends nulls on startup
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return;

        const accuracyVal  = accuracy_meters ?? accuracy;
        if (accuracyVal && accuracyVal > MAX_ACCURACY_METERS) return; // too inaccurate

        const parsedLat   = parseFloat(lat);
        const parsedLng   = parseFloat(lng);
        const parsedSpeed = speed_kmh ?? (speed ? speed * 3.6 : 0); // normalise to km/h

        // ── 1. Update Redis geo-index (all modes) ──────────────────────────────
        await _updateRedisGeo(accountUuid, parsedLat, parsedLng, heading, parsedSpeed, accuracyVal);

        // ── 2. Resolve Driver DB record ────────────────────────────────────────
        const driver = await Driver.findOne({
            where:      { userId: accountUuid },
            attributes: ['id', 'current_mode', 'status'],
        });

        if (!driver) return; // no Driver row yet — ignore

        // ── 3. Persist to DB (fire-and-forget) ────────────────────────────────
        _persistToDb(driver.id, parsedLat, parsedLng, heading, parsedSpeed);

        // ── 4a. RIDE mode ──────────────────────────────────────────────────────
        // Forward location to the trip passenger if driver has an active trip.
        // This section is UNCHANGED from the original working implementation.
        if (driver.current_mode === 'ride' || driver.current_mode == null) {

            const driverMeta = await locationService.getDriverLocation(accountUuid);

            if (driverMeta?.currentTripId) {
                const trip = await Trip.findByPk(driverMeta.currentTripId, {
                    attributes: ['id', 'passengerId'],
                });

                if (trip?.passengerId) {
                    const passengerSocketId = await redisHelpers.getJson(
                        REDIS_KEYS.USER_SOCKET(trip.passengerId),
                    );

                    if (passengerSocketId && io.sockets.sockets.get(passengerSocketId)) {
                        io.to(passengerSocketId).emit('driver:location_updated', {
                            tripId:  driverMeta.currentTripId,
                            lat:     parsedLat,
                            lng:     parsedLng,
                            heading: heading || 0,
                            speed:   parsedSpeed,
                        });
                    }
                }
            }

            socket.emit('driver:location_update:success', { lat: parsedLat, lng: parsedLng });
            return;
        }

        // ── 4b. DELIVERY mode ──────────────────────────────────────────────────
        // deliverySocketService.resolveActiveDelivery() looks up:
        //   driver:active_delivery:{driverId}
        // This Redis key is set in acceptDelivery as:
        //   redisClient.set(`driver:active_delivery:${driver.id}`, ...)
        // where driver.id is the INTEGER Driver primary key.
        //
        // socket.userId is the Account UUID — which does NOT match.
        // We temporarily swap socket.userId to Driver.id so the service finds
        // the correct Redis key, then restore it immediately after.
        if (driver.current_mode === 'delivery') {
            const originalUserId  = socket.userId;   // Account UUID — must be restored
            socket.userId         = driver.id;        // ✅ Driver.id integer — matches Redis key
            socket.currentMode    = 'delivery';

            try {
                await deliverySocketService.handleDriverLocationUpdate(socket, io, {
                    lat:             parsedLat,
                    lng:             parsedLng,
                    heading,
                    speed_kmh:       parsedSpeed,
                    accuracy_meters: accuracyVal,
                });
            } finally {
                // ✅ Always restore — even if deliverySocketService throws
                socket.userId = originalUserId;
            }

            socket.emit('driver:location_update:success', { lat: parsedLat, lng: parsedLng });
            return;
        }

        // Unknown mode — geo-index already updated above, nothing more to do
        socket.emit('driver:location_update:success', { lat: parsedLat, lng: parsedLng });

    } catch (error) {
        console.error('❌ [LOCATION] _handleLocationEvent error:', error.message);
        // Never emit error back for location events — causes noise in mobile app
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = (io, socket) => {

    // ── Primary event — delivery agent app (every 3 s express, 15 s regular) ──
    socket.on('driver:location_update', (data) => {
        _handleLocationEvent(io, socket, data);
        // Fire-and-forget — never await socket event handlers
    });

    // ── Alias — ride-hailing driver app ───────────────────────────────────────
    socket.on('driver:location', (data) => {
        _handleLocationEvent(io, socket, data);
    });

    // ── Nearby drivers — debug / admin tool ───────────────────────────────────
    socket.on('location:nearby_drivers', async (data) => {
        try {
            const { lat, lng, radius = 5 } = data || {};

            if (!lat || !lng) {
                return socket.emit('error', { message: 'lat and lng are required' });
            }

            const nearbyDrivers = await locationService.findNearbyDrivers(
                parseFloat(lng),
                parseFloat(lat),
                radius,
            );

            socket.emit('location:nearby_drivers:result', {
                count:   nearbyDrivers.length,
                drivers: nearbyDrivers,
            });
        } catch (error) {
            console.error('❌ [LOCATION] nearby_drivers error:', error.message);
            socket.emit('error', { message: 'Failed to get nearby drivers' });
        }
    });
};