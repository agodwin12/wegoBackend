// src/services/NotificationService.js
//
// ═══════════════════════════════════════════════════════════════════════
// NOTIFICATION SERVICE — Central notification dispatcher
// ═══════════════════════════════════════════════════════════════════════
//
// This is the ONLY place in the codebase that sends push notifications.
// Every controller, socket handler, and cron job calls this service.
// Never call FCM directly from a controller.
//
// Responsibilities:
//   1. Insert a Notification row in the DB (inbox persistence)
//   2. Look up the FCM token for the target account
//   3. Fire the FCM push via Firebase Admin SDK
//   4. Handle broadcast fan-out (one Notification row per target user)
//
// FCM strategy:
//   - Foreground + background handled by Flutter firebase_messaging
//   - `data` payload only (no `notification` block) so Flutter has full
//     control over how the notification looks in all app states
//   - Flutter's onMessage / onBackgroundMessage reads data.type to route
//
// Usage:
//   const NotificationService = require('../services/NotificationService');
//
//   // Single user notification
//   await NotificationService.send({
//       accountUuid: trip.passenger_id,
//       type:        'RIDE_DRIVER_MATCHED',
//       title:       'Driver on the way!',
//       body:        'Jean-Paul is heading to your pickup.',
//       data:        { screen: 'trip_detail', trip_id: String(trip.id) },
//   });
//
//   // Broadcast (called by backoffice controller or cron)
//   await NotificationService.sendBroadcast(broadcastRecord);
//
// ═══════════════════════════════════════════════════════════════════════

'use strict';

const admin = require('firebase-admin');

// Models loaded lazily to avoid circular dependencyissues at startup
const getNotification      = () => require('../models/Notification');
const getBroadcastMessage  = () => require('../models/BroadcastMessage');
const getAccount           = () => require('../models/Account');
const getDeviceToken       = () => require('../models/DeviceToken');

// ── Firebase Admin initialisation guard ──────────────────────────────
// Firebase Admin is initialised once at app startup (server.js).
// This getter just returns the messaging instance safely.
function getMessaging() {
    if (!admin.apps.length) {
        console.warn('⚠️  [NOTIF] Firebase Admin not initialised — push will be skipped');
        return null;
    }
    return admin.messaging();
}

// ═══════════════════════════════════════════════════════════════════════
// INTERNAL: Send FCM to a single token
// ═══════════════════════════════════════════════════════════════════════

async function _sendFcm({ fcmToken, title, body, type, data = {} }) {
    const messaging = getMessaging();
    if (!messaging) return { success: false, reason: 'firebase_not_initialised' };
    if (!fcmToken)   return { success: false, reason: 'no_fcm_token' };

    try {
        // Data-only message — Flutter handles display in all app states
        const message = {
            token: fcmToken,
            data:  {
                type,
                title,
                body,
                // All data values must be strings for FCM data payloads
                ...Object.fromEntries(
                    Object.entries(data).map(([k, v]) => [k, String(v)])
                ),
            },
            android: {
                priority: 'high',
            },
            apns: {
                headers: { 'apns-priority': '10' },
            },
        };

        const response = await messaging.send(message);
        console.log(`✅ [NOTIF:FCM] Sent to token ...${fcmToken.slice(-8)} | msgId: ${response}`);
        return { success: true, messageId: response };

    } catch (error) {
        // Token is stale / unregistered — log but don't throw
        if (
            error.code === 'messaging/registration-token-not-registered' ||
            error.code === 'messaging/invalid-registration-token'
        ) {
            console.warn(`⚠️  [NOTIF:FCM] Stale token for account — removing`);
            return { success: false, reason: 'stale_token', stale: true };
        }
        console.error('❌ [NOTIF:FCM] Send error:', error.message);
        return { success: false, reason: error.message };
    }
}

// ═══════════════════════════════════════════════════════════════════════
// INTERNAL: Persist notification row to DB
// ═══════════════════════════════════════════════════════════════════════

async function _persist({ accountUuid, title, body, type, data, broadcastId }) {
    try {
        const Notification = getNotification();
        const notif = await Notification.create({
            account_uuid: accountUuid,
            title,
            body,
            type,
            data:         data || null,
            broadcast_id: broadcastId || null,
        });
        return notif;
    } catch (error) {
        // Persistence failure should never block the push from being sent
        console.error('❌ [NOTIF:DB] Failed to persist notification:', error.message);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════
// INTERNAL: Get active FCM token for an account
// Returns null if no token found
// ═══════════════════════════════════════════════════════════════════════

async function _getFcmToken(accountUuid) {
    try {
        const DeviceToken = getDeviceToken();
        const token = await DeviceToken.findOne({
            where:  { account_uuid: accountUuid, is_active: true },
            order:  [['updated_at', 'DESC']],
            attributes: ['fcm_token'],
        });
        return token?.fcm_token || null;
    } catch (error) {
        console.error('❌ [NOTIF] Failed to fetch FCM token:', error.message);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC: Send notification to a single user
// ═══════════════════════════════════════════════════════════════════════

/**
 * @param {object} opts
 * @param {string} opts.accountUuid   - Target account UUID
 * @param {string} opts.type          - NOTIFICATION_TYPES value
 * @param {string} opts.title         - Notification title
 * @param {string} opts.body          - Notification body text
 * @param {object} [opts.data]        - Deep-link payload for Flutter
 * @param {number} [opts.broadcastId] - Set when called from sendBroadcast()
 */
async function send({ accountUuid, type, title, body, data, broadcastId }) {
    console.log(`📢 [NOTIF] Sending "${type}" to account ${accountUuid}`);

    // 1. Persist to DB (inbox)
    await _persist({ accountUuid, title, body, type, data, broadcastId });

    // 2. Get FCM token
    const fcmToken = await _getFcmToken(accountUuid);

    // 3. Fire push
    const result = await _sendFcm({ fcmToken, title, body, type, data: data || {} });

    // 4. If token is stale, deactivate it
    if (result.stale) {
        try {
            const DeviceToken = getDeviceToken();
            await DeviceToken.update(
                { is_active: false },
                { where: { account_uuid: accountUuid, fcm_token: fcmToken } }
            );
        } catch (_) { /* non-critical */ }
    }

    return result;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC: Fan-out a broadcast to all target accounts
// Called by backoffice controller (immediate) or cron (scheduled)
// ═══════════════════════════════════════════════════════════════════════

/**
 * @param {BroadcastMessage} broadcast - BroadcastMessage model instance
 */
async function sendBroadcast(broadcast) {
    const Account          = getAccount();
    const BroadcastMessage = getBroadcastMessage();

    console.log(`📢 [NOTIF:BROADCAST] Starting fan-out for broadcast #${broadcast.id} → ${broadcast.target_type}`);

    // ── Build account filter ──────────────────────────────────────────
    const where = { status: 'ACTIVE' };
    if (broadcast.target_type !== 'ALL') {
        where.user_type = broadcast.target_type;
    }

    const accounts = await Account.findAll({
        where,
        attributes: ['uuid'],
    });

    if (accounts.length === 0) {
        console.warn(`⚠️  [NOTIF:BROADCAST] No active accounts found for target: ${broadcast.target_type}`);
        await broadcast.update({ status: 'SENT', sent_at: new Date(), recipients_count: 0 });
        return;
    }

    console.log(`📋 [NOTIF:BROADCAST] Fanning out to ${accounts.length} accounts...`);

    // ── Fan-out: persist + push per account ──────────────────────────
    // Process in batches of 100 to avoid memory spikes on large user bases
    const BATCH_SIZE = 100;
    let totalSent = 0;

    for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
        const batch = accounts.slice(i, i + BATCH_SIZE);

        await Promise.allSettled(
            batch.map(account =>
                send({
                    accountUuid: account.uuid,
                    type:        'BROADCAST',
                    title:       broadcast.title,
                    body:        broadcast.body,
                    data:        broadcast.data || undefined,
                    broadcastId: broadcast.id,
                })
            )
        );

        totalSent += batch.length;
        console.log(`📦 [NOTIF:BROADCAST] Processed ${totalSent}/${accounts.length} accounts`);
    }

    // ── Mark broadcast as sent ────────────────────────────────────────
    await broadcast.update({
        status:           'SENT',
        sent_at:          new Date(),
        recipients_count: accounts.length,
    });

    console.log(`✅ [NOTIF:BROADCAST] Broadcast #${broadcast.id} complete — ${accounts.length} recipients`);
}

// ═══════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════

module.exports = {
    send,
    sendBroadcast,
};