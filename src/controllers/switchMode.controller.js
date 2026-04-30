// src/controllers/switchMode.controller.js
//
// ═══════════════════════════════════════════════════════════════════════
// SWITCH MODE CONTROLLER
// ═══════════════════════════════════════════════════════════════════════
//
// POST /api/auth/switch-mode
//
// Allows drivers and delivery agents to switch their active operating
// context. The switch updates accounts.active_mode in the DB, then
// issues a fresh token pair so every subsequent API call carries the
// correct active_mode claim without requiring a full re-login.
//
// ── Allowed transitions ───────────────────────────────────────────────
//
//   DRIVER          → PASSENGER          always allowed
//   DRIVER          → DELIVERY_AGENT     allowed (auto-creates DeliveryWallet
//                                        if this is the driver's first time)
//   DELIVERY_AGENT  → PASSENGER          always allowed
//   DELIVERY_AGENT  → DRIVER             NOT allowed (wrong base role)
//   PASSENGER       → anything           NOT allowed (can't self-promote)
//   Same mode       → Same mode          rejected (no-op)
//
// ── Side effects ──────────────────────────────────────────────────────
//
//   Switching to PASSENGER:
//     • Driver is removed from Redis geo-index (DRIVERS_GEO)
//     • Driver is removed from ONLINE_DRIVERS and AVAILABLE_DRIVERS sets
//     • Driver.status set to 'offline' in DB
//     → They can no longer receive trip or delivery offers.
//
//   DRIVER → DELIVERY_AGENT:
//     • Driver.current_mode set to 'delivery' (the legacy per-record mode)
//     • DeliveryWallet auto-created if not exists
//     • Driver removed from Redis (they must re-call goOnline in delivery mode)
//
//   Any → DRIVER:
//     (only DELIVERY_AGENT → DRIVER is blocked; this path is DRIVER coming
//      back from PASSENGER or DELIVERY_AGENT mode)
//     • Driver.current_mode set back to 'ride'
//     • Redis cleaned — must re-call goOnline
//
// ── Response ──────────────────────────────────────────────────────────
//
//   {
//     success: true,
//     data: {
//       active_mode:   'PASSENGER' | 'DRIVER' | 'DELIVERY_AGENT',
//       previous_mode: '...',
//       access_token:  '<new JWT>',
//       dashboard:     'passenger' | 'driver' | 'delivery',
//     }
//   }
//
//   Flutter reads `dashboard` to know which screen to navigate to.
//
// ═══════════════════════════════════════════════════════════════════════

'use strict';

const { v4: uuidv4 }         = require('uuid');
const { Account, Driver }    = require('../models');
const { signAccessToken, generateRefreshToken } = require('../utils/jwt');
const { redisClient, REDIS_KEYS }               = require('../config/redis');

// ── Allowed transition map ────────────────────────────────────────────
// Key   = user_type (permanent base role)
// Value = set of modes that user_type can switch TO
const ALLOWED_TRANSITIONS = {
    DRIVER:          new Set(['PASSENGER', 'DELIVERY_AGENT']),
    DELIVERY_AGENT:  new Set(['PASSENGER']),
    // PASSENGER, PARTNER, ADMIN have no allowed transitions
};

// ── Dashboard routing hint for Flutter ───────────────────────────────
const DASHBOARD_FOR_MODE = {
    PASSENGER:      'passenger',
    DRIVER:         'driver',
    DELIVERY_AGENT: 'delivery',
};

// ═══════════════════════════════════════════════════════════════════════
// POST /api/auth/switch-mode
// ═══════════════════════════════════════════════════════════════════════

exports.switchMode = async (req, res, next) => {
    try {
        const driverId   = req.user.uuid;
        const userType   = req.user.user_type;
        const currentMode = req.auth.active_mode; // resolved by auth middleware

        const { target_mode } = req.body;

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔄 [SWITCH-MODE] Request');
        console.log('   Driver     :', driverId);
        console.log('   user_type  :', userType);
        console.log('   current    :', currentMode);
        console.log('   target     :', target_mode);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        // ── Validate target_mode provided ─────────────────────────────
        if (!target_mode) {
            return res.status(400).json({
                success: false,
                message: 'target_mode is required.',
                code:    'MISSING_TARGET_MODE',
            });
        }

        const validModes = ['PASSENGER', 'DRIVER', 'DELIVERY_AGENT'];
        if (!validModes.includes(target_mode)) {
            return res.status(400).json({
                success: false,
                message: `target_mode must be one of: ${validModes.join(', ')}`,
                code:    'INVALID_TARGET_MODE',
            });
        }

        // ── Guard: no-op switch ───────────────────────────────────────
        if (target_mode === currentMode) {
            return res.status(400).json({
                success: false,
                message: `You are already in ${currentMode} mode.`,
                code:    'ALREADY_IN_MODE',
                data:    { active_mode: currentMode },
            });
        }

        // ── Guard: check allowed transitions ──────────────────────────
        const allowed = ALLOWED_TRANSITIONS[userType];
        if (!allowed || !allowed.has(target_mode)) {
            const reason = !allowed
                ? `${userType} accounts cannot switch modes.`
                : `${userType} accounts cannot switch to ${target_mode} mode.`;

            console.log('❌ [SWITCH-MODE] Transition not allowed:', userType, '→', target_mode);
            return res.status(403).json({
                success: false,
                message: reason,
                code:    'TRANSITION_NOT_ALLOWED',
                data: {
                    user_type:    userType,
                    current_mode: currentMode,
                    target_mode,
                    allowed_targets: allowed ? [...allowed] : [],
                },
            });
        }

        // ── Side effects based on target mode ─────────────────────────

        if (target_mode === 'PASSENGER') {
            await _sideEffectsToPassenger(driverId, userType);
        } else if (target_mode === 'DELIVERY_AGENT') {
            // Only DRIVER can reach here (ALLOWED_TRANSITIONS enforced above)
            await _sideEffectsToDelivery(driverId);
        } else if (target_mode === 'DRIVER') {
            // A DRIVER returning from PASSENGER mode (DELIVERY_AGENT → DRIVER
            // is blocked by ALLOWED_TRANSITIONS so only DRIVER can hit this)
            await _sideEffectsToDriver(driverId);
        }

        // ── Persist new active_mode to DB ─────────────────────────────
        await Account.update(
            { active_mode: target_mode },
            { where: { uuid: driverId } }
        );

        console.log(`✅ [SWITCH-MODE] DB updated: active_mode = ${target_mode}`);

        // ── Issue fresh token pair ────────────────────────────────────
        // Re-fetch the account so signAccessToken gets the updated active_mode.
        const updatedAccount = await Account.findByPk(driverId);

        const newAccessToken  = signAccessToken(updatedAccount);
        const newRefreshToken = generateRefreshToken();

        // Persist new refresh token to DB (replace old one)
        // We reuse the existing RefreshToken model pattern from auth_controller
        try {
            const { RefreshToken } = require('../models');
            const expiresAt = new Date();
            expiresAt.setFullYear(expiresAt.getFullYear() + 1);

            // Invalidate all existing refresh tokens for this account
            await RefreshToken.destroy({ where: { account_id: driverId } });

            await RefreshToken.create({
                id:         uuidv4(),
                account_id: driverId,
                token:      newRefreshToken,
                expires_at: expiresAt,
            });
            console.log('✅ [SWITCH-MODE] Refresh token rotated');
        } catch (tokenErr) {
            // Non-fatal — the access token is already issued.
            // The old refresh token will still work until it expires naturally.
            console.warn('⚠️  [SWITCH-MODE] Refresh token rotation failed (non-fatal):', tokenErr.message);
        }

        console.log(`✅ [SWITCH-MODE] Complete: ${currentMode} → ${target_mode}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({
            success: true,
            message: `Switched to ${target_mode} mode successfully.`,
            data: {
                previous_mode: currentMode,
                active_mode:   target_mode,
                user_type:     userType,
                // Flutter reads `dashboard` to know which screen to push
                dashboard:     DASHBOARD_FOR_MODE[target_mode],
                access_token:  newAccessToken,
                refresh_token: newRefreshToken,
            },
        });

    } catch (error) {
        console.error('❌ [SWITCH-MODE] Error:', error.message);
        console.error(error.stack);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET /api/auth/mode  —  current mode info
// ═══════════════════════════════════════════════════════════════════════
//
// Lightweight endpoint Flutter calls on app resume to confirm the
// current mode without a full re-login.

exports.getCurrentMode = async (req, res) => {
    const userType    = req.user.user_type;
    const activeMode  = req.auth.active_mode;
    const allowed     = ALLOWED_TRANSITIONS[userType];

    return res.status(200).json({
        success: true,
        data: {
            user_type:       userType,
            active_mode:     activeMode,
            dashboard:       DASHBOARD_FOR_MODE[activeMode] || null,
            allowed_targets: allowed ? [...allowed].filter(m => m !== activeMode) : [],
        },
    });
};

// ═══════════════════════════════════════════════════════════════════════
// PRIVATE SIDE-EFFECT HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Side effects when switching TO passenger mode.
 * The driver/agent goes invisible to dispatch — removed from geo-index,
 * availability sets, and their Driver record is set to offline.
 */
async function _sideEffectsToPassenger(accountUuid, userType) {
    console.log(`🚶 [SWITCH-MODE] Side effects: → PASSENGER for ${accountUuid}`);

    // Remove from Redis geo-index and availability sets
    await _cleanRedisPresence(accountUuid);

    // Update Driver record to offline
    // Driver.id === Account.uuid for both DRIVER and DELIVERY_AGENT accounts
    try {
        await Driver.update(
            { status: 'offline', current_mode: 'ride' },
            { where: { id: accountUuid } }
        );
        console.log('✅ [SWITCH-MODE] Driver record set to offline');
    } catch (e) {
        // Non-fatal — Redis is the source of truth for real-time availability.
        // If the DB update fails the driver won't appear online anyway
        // because we already removed them from Redis.
        console.warn('⚠️  [SWITCH-MODE] Driver DB update failed (non-fatal):', e.message);
    }
}

/**
 * Side effects when a DRIVER switches TO delivery agent mode.
 * Updates Driver.current_mode to 'delivery' and ensures a
 * DeliveryWallet exists (auto-creates on first switch).
 */
async function _sideEffectsToDelivery(accountUuid) {
    console.log(`📦 [SWITCH-MODE] Side effects: → DELIVERY_AGENT for ${accountUuid}`);

    // Remove from Redis — must re-call goOnline in delivery mode
    await _cleanRedisPresence(accountUuid);

    // Update Driver.current_mode so existing delivery dispatch logic works
    try {
        await Driver.update(
            { status: 'offline', current_mode: 'delivery' },
            { where: { id: accountUuid } }
        );
        console.log('✅ [SWITCH-MODE] Driver.current_mode = delivery');
    } catch (e) {
        console.warn('⚠️  [SWITCH-MODE] Driver mode update failed (non-fatal):', e.message);
    }

    // Auto-create DeliveryWallet if this is the driver's first time
    // in delivery mode — they need a wallet to accept deliveries.
    try {
        const { DeliveryWallet } = require('../models');
        const [wallet, created]  = await DeliveryWallet.findOrCreate({
            where:    { driver_id: accountUuid },
            defaults: {
                driver_id:             accountUuid,
                balance:               0.00,
                total_earned:          0.00,
                total_cash_collected:  0.00,
                total_commission_owed: 0.00,
                total_commission_paid: 0.00,
                total_withdrawn:       0.00,
                pending_withdrawal:    0.00,
                status:                'active',
            },
        });

        if (created) {
            console.log('✅ [SWITCH-MODE] DeliveryWallet auto-created for driver:', accountUuid);
        } else {
            console.log('ℹ️  [SWITCH-MODE] DeliveryWallet already exists — balance:', wallet.balance, 'XAF');
        }
    } catch (e) {
        // Non-fatal — driver can still switch but should top up before accepting deliveries.
        // The delivery accept endpoint will enforce the balance requirement.
        console.warn('⚠️  [SWITCH-MODE] DeliveryWallet findOrCreate failed (non-fatal):', e.message);
    }
}

/**
 * Side effects when a DRIVER returns TO driver mode
 * (from PASSENGER or DELIVERY_AGENT mode).
 * Resets Driver.current_mode back to 'ride'.
 */
async function _sideEffectsToDriver(accountUuid) {
    console.log(`🚗 [SWITCH-MODE] Side effects: → DRIVER for ${accountUuid}`);

    // Remove from Redis — must re-call goOnline in ride mode
    await _cleanRedisPresence(accountUuid);

    try {
        await Driver.update(
            { status: 'offline', current_mode: 'ride' },
            { where: { id: accountUuid } }
        );
        console.log('✅ [SWITCH-MODE] Driver.current_mode = ride');
    } catch (e) {
        console.warn('⚠️  [SWITCH-MODE] Driver mode update failed (non-fatal):', e.message);
    }
}

/**
 * Removes the driver from all Redis online/availability structures.
 * Used by all mode transitions — in every case the driver must
 * re-call goOnline from their new dashboard.
 */
async function _cleanRedisPresence(accountUuid) {
    try {
        const id = accountUuid.toString();
        await Promise.all([
            redisClient.zrem(REDIS_KEYS.DRIVERS_GEO,      id),
            redisClient.srem(REDIS_KEYS.ONLINE_DRIVERS,    id),
            redisClient.srem(REDIS_KEYS.AVAILABLE_DRIVERS, id),
            redisClient.del(REDIS_KEYS.DRIVER_META(accountUuid)),
            redisClient.del(`driver:location:${accountUuid}`),
        ]);
        console.log('✅ [SWITCH-MODE] Redis presence cleared for:', accountUuid);
    } catch (e) {
        // Non-fatal — geo entry expiry will clean it up naturally
        console.warn('⚠️  [SWITCH-MODE] Redis cleanup failed (non-fatal):', e.message);
    }
}