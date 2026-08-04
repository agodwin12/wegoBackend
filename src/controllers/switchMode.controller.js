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
//   PASSENGER → nothing (native passenger accounts can never switch)
//
// ── Guard ────────────────────────────────────────────────────────────
//
//   Refused with 400 ACTIVE_JOB_IN_PROGRESS if Driver.status === 'busy' —
//   switching mode mid-trip or mid-delivery would strand a real passenger
//   or package with a frozen tracking screen and no warning to anyone.
//
// ── Side effects (via services/driverModeState.service.js) ─────────────
//
//   → PASSENGER:
//     • Driver removed from Redis geo-index + availability sets
//     • Driver.status = offline, Driver.current_mode = ride
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
//   In every case Account.active_mode is updated in lock-step with
//   Driver.current_mode — this is the single writer both fields share with
//   the legacy mobile toggle and the backoffice admin override, so the two
//   can never drift out of sync regardless of which endpoint changed them.
//
// ═══════════════════════════════════════════════════════════════════════

'use strict';

const { v4: uuidv4 }      = require('uuid');
const { Account }         = require('../models');
const { signAccessToken, generateRefreshToken } = require('../utils/jwt');
const { setDriverMode, ModeSwitchBlockedError } = require('../services/driverModeState.service');

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

        // ── 4. Mutate mode (refuses if the driver has a live job) ──────
        //
        // setDriverMode() is the single place Driver.current_mode AND
        // Account.active_mode are ever written, and it unconditionally
        // refuses while status === 'busy' — switching mode mid-trip or
        // mid-delivery would strand a real passenger/package with a frozen
        // tracking screen and no warning to anyone.

        try {
            await setDriverMode(driverId, target_mode);
        } catch (err) {
            if (err instanceof ModeSwitchBlockedError) {
                console.log(`❌ [SWITCH-MODE] Blocked — driver has an active job:`, driverId);
                return res.status(400).json({
                    success: false,
                    message: err.message,
                    code:    err.code,
                });
            }
            throw err;
        }

        console.log(`✅ [SWITCH-MODE] DB updated: active_mode = ${target_mode}`);

        // ── 5. Issue fresh token pair ─────────────────────────────────

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

// Mode-mutation side effects (Redis cleanup, Driver.current_mode,
// Account.active_mode, DeliveryWallet provisioning, busy-guard) now live in
// driverModeState.service.js — the single place shared with the legacy
// mobile toggle and the backoffice admin override, so the two DB fields can
// never drift out of sync regardless of which endpoint changed them.