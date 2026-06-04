// src/routes/deviceToken_routes.js
'use strict';

//
// ═══════════════════════════════════════════════════════════════════════
// DEVICE TOKEN ROUTES
// ═══════════════════════════════════════════════════════════════════════
//
// Mount in app.js:
//   const deviceTokenRoutes = require('./routes/deviceToken_routes');
//   app.use('/api/device-tokens', deviceTokenRoutes);
//
// ═══════════════════════════════════════════════════════════════════════

const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/deviceToken_controller');
const { authenticate } = require('../middleware/auth.middleware');

// ── Inline validation ─────────────────────────────────────────────────

const validateRegister = (req, res, next) => {
    const { fcm_token, device_id, platform } = req.body;
    const errors = [];

    if (!fcm_token || typeof fcm_token !== 'string' || fcm_token.trim() === '') {
        errors.push('fcm_token is required and must be a non-empty string.');
    }
    if (!device_id || typeof device_id !== 'string' || device_id.trim() === '') {
        errors.push('device_id is required and must be a non-empty string.');
    }
    if (!platform || !['android', 'ios'].includes(platform)) {
        errors.push('platform is required and must be "android" or "ios".');
    }

    if (errors.length > 0) {
        return res.status(400).json({ success: false, message: 'Validation failed.', errors });
    }

    next();
};

const validateDeactivate = (req, res, next) => {
    const { device_id } = req.body;

    if (!device_id || typeof device_id !== 'string' || device_id.trim() === '') {
        return res.status(400).json({
            success: false,
            message: 'device_id is required and must be a non-empty string.',
        });
    }

    next();
};

// ═══════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   POST /api/device-tokens
 * @desc    Register or refresh FCM token for the current device
 * @access  Private
 * @body    { fcm_token: string, device_id: string, platform: 'android'|'ios' }
 */
router.post(
    '/',
    authenticate,
    validateRegister,
    controller.registerToken
);

/**
 * @route   DELETE /api/device-tokens
 * @desc    Deactivate FCM token on logout
 * @access  Private
 * @body    { device_id: string }
 */
router.delete(
    '/',
    authenticate,
    validateDeactivate,
    controller.deactivateToken
);

module.exports = router;