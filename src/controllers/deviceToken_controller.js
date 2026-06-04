// src/controllers/deviceToken_controller.js
'use strict';

//
// ═══════════════════════════════════════════════════════════════════════
// DEVICE TOKEN CONTROLLER
// ═══════════════════════════════════════════════════════════════════════
//
// Handles FCM token registration and deactivation.
// Flutter calls these two endpoints:
//
//   POST   /api/device-tokens   — on login + on FirebaseMessaging.onTokenRefresh
//   DELETE /api/device-tokens   — on logout
//
// ═══════════════════════════════════════════════════════════════════════

const DeviceToken = require('../models/DeviceToken');

// ═══════════════════════════════════════════════════════════════════════
// REGISTER / REFRESH TOKEN
// POST /api/device-tokens
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   POST /api/device-tokens
 * @desc    Register or refresh FCM token for the authenticated user's device.
 *          Upserts on (account_uuid, device_id) — same device re-registering
 *          simply updates its token and reactivates the row.
 * @access  Private
 */
exports.registerToken = async (req, res) => {
    try {
        const accountUuid        = req.user.uuid;
        const { fcm_token, device_id, platform } = req.body;

        console.log(`📱 [DEVICE_TOKEN] Registering token for account ${accountUuid} | device ${device_id} | platform ${platform}`);

        // Upsert: if same device already has a row, update it
        const [token, created] = await DeviceToken.findOrCreate({
            where: {
                account_uuid: accountUuid,
                device_id,
            },
            defaults: {
                fcm_token,
                platform,
                is_active: true,
            },
        });

        if (!created) {
            // Device already registered — update token and reactivate
            await token.update({
                fcm_token,
                platform,
                is_active: true,
            });
        }

        console.log(`✅ [DEVICE_TOKEN] Token ${created ? 'created' : 'updated'} for account ${accountUuid}`);

        return res.status(200).json({
            success: true,
            message: 'Device token registered successfully.',
        });

    } catch (error) {
        console.error('❌ [DEVICE_TOKEN] Register error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to register device token.',
            error:   process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// DEACTIVATE TOKEN ON LOGOUT
// DELETE /api/device-tokens
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   DELETE /api/device-tokens
 * @desc    Deactivate the FCM token for this device on logout.
 *          Marks is_active = false — does not hard-delete.
 * @access  Private
 */
exports.deactivateToken = async (req, res) => {
    try {
        const accountUuid = req.user.uuid;
        const { device_id } = req.body;

        console.log(`📱 [DEVICE_TOKEN] Deactivating token for account ${accountUuid} | device ${device_id}`);

        const updated = await DeviceToken.update(
            { is_active: false },
            {
                where: {
                    account_uuid: accountUuid,
                    device_id,
                    is_active:    true,
                },
            }
        );

        const rowsAffected = updated[0];

        if (rowsAffected === 0) {
            // Token not found or already inactive — not an error, just log it
            console.warn(`⚠️  [DEVICE_TOKEN] No active token found for device ${device_id} on account ${accountUuid}`);
        } else {
            console.log(`✅ [DEVICE_TOKEN] Token deactivated for account ${accountUuid}`);
        }

        return res.status(200).json({
            success: true,
            message: 'Device token deactivated.',
        });

    } catch (error) {
        console.error('❌ [DEVICE_TOKEN] Deactivate error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to deactivate device token.',
            error:   process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};