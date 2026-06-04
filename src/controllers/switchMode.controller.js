// src/controllers/switchMode.controller.js
//
// ═══════════════════════════════════════════════════════════════════════
// SWITCH MODE CONTROLLER
// ═══════════════════════════════════════════════════════════════════════
//
// POST /api/auth/switch-mode
//
// ── Allowed transitions ───────────────────────────────────────────────
//
//   DRIVER in DRIVER mode          → PASSENGER, DELIVERY_AGENT
//   DRIVER in DELIVERY_AGENT mode  → DRIVER, PASSENGER
//   DRIVER in PASSENGER mode       → DRIVER, DELIVERY_AGENT
//
//   DELIVERY_AGENT in DELIVERY_AGENT mode → PASSENGER
//   DELIVERY_AGENT in PASSENGER mode      → DELIVERY_AGENT
//
//   PASSENGER → nothing
//
// ── Side effects ──────────────────────────────────────────────────────
//
//   → PASSENGER:
//     • Driver removed from Redis geo-index + availability sets
//     • Driver.status = offline
//
//   → DELIVERY_AGENT:
//     • Redis cleaned (must re-call goOnline in delivery mode)
//     • Driver.current_mode = delivery
//     • DeliveryWallet auto-created if first time
//
//   → DRIVER:
//     • Redis cleaned (must re-call goOnline in ride mode)
//     • Driver.current_mode = ride
//
// ═══════════════════════════════════════════════════════════════════════

'use strict';

const { v4: uuidv4 }      = require('uuid');
const { Account, Driver } = require('../models');
const { signAccessToken, generateRefreshToken } = require('../utils/jwt');
const { redisClient, REDIS_KEYS }               = require('../config/redis');

// ── Mode-aware allowed transitions ───────────────────────────────────
// ALLOWED_TRANSITIONS[user_type][current_active_mode] → Set of allowed targets
const ALLOWED_TRANSITIONS = {
    DRIVER: {
        DRIVER:         new Set(['PASSENGER', 'DELIVERY_AGENT']),
        DELIVERY_AGENT: new Set(['DRIVER',    'PASSENGER']),
        PASSENGER:      new Set(['DRIVER',    'DELIVERY_AGENT']),
    },
    DELIVERY_AGENT: {
        DELIVERY_AGENT: new Set(['PASSENGER']),
        PASSENGER:      new Set(['DELIVERY_AGENT']),
    },
    // PASSENGER, PARTNER, ADMIN — no switching
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
        const driverId    = req.user.uuid;
        const userType    = req.user.user_type;
        const currentMode = req.auth.active_mode; // resolved by auth middleware

        const { target_mode } = req.body;

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔄 [SWITCH-MODE] Request');
        console.log('   Driver     :', driverId);
        console.log('   user_type  :', userType);
        console.log('   current    :', currentMode);
        console.log('   target     :', target_mode);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        // ── 1. Validate target_mode provided ──────────────────────────

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

        // ── 2. No-op guard ────────────────────────────────────────────

        if (target_mode === currentMode) {
            return res.status(400).json({
                success: false,
                message: `You are already in ${currentMode} mode.`,
                code:    'ALREADY_IN_MODE',
                data:    { active_mode: currentMode },
            });
        }

        // ── 3. Mode-aware permission check ────────────────────────────

        const allowedForType = ALLOWED_TRANSITIONS[userType];
        const allowedFromMode = allowedForType?.[currentMode];

        if (!allowedFromMode || !allowedFromMode.has(target_mode)) {
            const allowedList = allowedFromMode ? [...allowedFromMode] : [];
            console.log(`❌ [SWITCH-MODE] Not allowed: ${userType} in ${currentMode} → ${target_mode}`);
            console.log('   allowed    :', allowedList.join(', ') || '(none)');

            return res.status(403).json({
                success: false,
                message: `Cannot switch from ${currentMode} to ${target_mode}.`,
                code:    'TRANSITION_NOT_ALLOWED',
                data: {
                    user_type:       userType,
                    current_mode:    currentMode,
                    target_mode,
                    allowed_targets: allowedList,
                },
            });
        }

        console.log('   allowed    :', [...allowedFromMode].join(', '));

        // ── 4. Side effects based on target mode ──────────────────────

        if (target_mode === 'PASSENGER') {
            await _sideEffectsToPassenger(driverId, userType);
        } else if (target_mode === 'DELIVERY_AGENT') {
            await _sideEffectsToDelivery(driverId);
        } else if (target_mode === 'DRIVER') {
            await _sideEffectsToDriver(driverId);
        }

        // ── 5. Persist new active_mode to DB ──────────────────────────

        await Account.update(
            { active_mode: target_mode },
            { where: { uuid: driverId } }
        );

        console.log(`✅ [SWITCH-MODE] DB updated: active_mode = ${target_mode}`);

        // ── 6. Issue fresh token pair ─────────────────────────────────

        const updatedAccount  = await Account.findByPk(driverId);
        const newAccessToken  = signAccessToken(updatedAccount);
        const newRefreshToken = generateRefreshToken();

        // Persist new refresh token (non-fatal if it fails)
        try {
            const { RefreshToken } = require('../models');
            const expiresAt = new Date();
            expiresAt.setFullYear(expiresAt.getFullYear() + 1);

            await RefreshToken.destroy({ where: { account_uuid: driverId } });

            await RefreshToken.create({
                id:           uuidv4(),
                account_uuid: driverId,
                token:        newRefreshToken,
                expires_at:   expiresAt,
            });
            console.log('✅ [SWITCH-MODE] Refresh token rotated');
        } catch (tokenErr) {
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

exports.getCurrentMode = async (req, res) => {
    const userType   = req.user.user_type;
    const activeMode = req.auth.active_mode;

    const allowedFromMode =
        ALLOWED_TRANSITIONS[userType]?.[activeMode];

    const allowedTargets = allowedFromMode
        ? [...allowedFromMode].filter(m => m !== activeMode)
        : [];

    return res.status(200).json({
        success: true,
        data: {
            user_type:       userType,
            active_mode:     activeMode,
            dashboard:       DASHBOARD_FOR_MODE[activeMode] || null,
            allowed_targets: allowedTargets,
        },
    });
};

// ═══════════════════════════════════════════════════════════════════════
// PRIVATE SIDE-EFFECT HELPERS
// ═══════════════════════════════════════════════════════════════════════

async function _sideEffectsToPassenger(accountUuid, userType) {
    console.log(`🚶 [SWITCH-MODE] Side effects: → PASSENGER for ${accountUuid}`);

    await _cleanRedisPresence(accountUuid);

    try {
        await Driver.update(
            { status: 'offline', current_mode: 'ride' },
            { where: { id: accountUuid } }
        );
        console.log('✅ [SWITCH-MODE] Driver record set to offline');
    } catch (e) {
        console.warn('⚠️  [SWITCH-MODE] Driver DB update failed (non-fatal):', e.message);
    }
}

async function _sideEffectsToDelivery(accountUuid) {
    console.log(`📦 [SWITCH-MODE] Side effects: → DELIVERY_AGENT for ${accountUuid}`);

    await _cleanRedisPresence(accountUuid);

    try {
        await Driver.update(
            { status: 'offline', current_mode: 'delivery' },
            { where: { id: accountUuid } }
        );
        console.log('✅ [SWITCH-MODE] Driver.current_mode = delivery');
    } catch (e) {
        console.warn('⚠️  [SWITCH-MODE] Driver mode update failed (non-fatal):', e.message);
    }

    // Auto-create DeliveryWallet on first delivery mode switch
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
        console.warn('⚠️  [SWITCH-MODE] DeliveryWallet findOrCreate failed (non-fatal):', e.message);
    }
}

async function _sideEffectsToDriver(accountUuid) {
    console.log(`🚗 [SWITCH-MODE] Side effects: → DRIVER for ${accountUuid}`);

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
        console.warn('⚠️  [SWITCH-MODE] Redis cleanup failed (non-fatal):', e.message);
    }
}