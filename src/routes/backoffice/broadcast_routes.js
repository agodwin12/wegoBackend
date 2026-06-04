// src/routes/backoffice/broadcast_routes.js
'use strict';

//
// ═══════════════════════════════════════════════════════════════════════
// BROADCAST ROUTES — Backoffice mass notification management
// ═══════════════════════════════════════════════════════════════════════
//
// Mount in app.js:
//   const broadcastRoutes = require('./routes/backoffice/broadcast_routes');
//   app.use('/api/backoffice/broadcasts', broadcastRoutes);
//
// ═══════════════════════════════════════════════════════════════════════

const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/backoffice/broadcast_controller');

const {
    authenticateEmployee,
    requireEmployeeRole,
} = require('../../middleware/employeeAuth.middleware');

const { BROADCAST_TARGET_TYPES } = require('../../models/BroadcastMessage');

// All broadcast routes require employee authentication
router.use(authenticateEmployee);

// ── Inline validation ─────────────────────────────────────────────────

const validateCreate = (req, res, next) => {
    const { title, body, target_type, scheduled_at } = req.body;
    const errors = [];

    if (!title || typeof title !== 'string' || title.trim() === '') {
        errors.push('title is required.');
    } else if (title.trim().length > 255) {
        errors.push('title must be 255 characters or fewer.');
    }

    if (!body || typeof body !== 'string' || body.trim() === '') {
        errors.push('body is required.');
    }

    if (!target_type || !BROADCAST_TARGET_TYPES.includes(target_type)) {
        errors.push(`target_type must be one of: ${BROADCAST_TARGET_TYPES.join(', ')}.`);
    }

    if (scheduled_at !== undefined && scheduled_at !== null) {
        const date = new Date(scheduled_at);
        if (isNaN(date.getTime())) {
            errors.push('scheduled_at must be a valid ISO datetime string.');
        }
    }

    if (errors.length > 0) {
        return res.status(400).json({ success: false, message: 'Validation failed.', errors });
    }

    next();
};

// ═══════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   POST /api/backoffice/broadcasts
 * @desc    Create a new broadcast (immediate or scheduled)
 * @access  super_admin, admin, manager
 */
router.post(
    '/',
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    validateCreate,
    ctrl.createBroadcast
);

/**
 * @route   GET /api/backoffice/broadcasts
 * @desc    List all broadcasts (filterable by status, target_type)
 * @access  All backoffice roles
 */
router.get(
    '/',
    ctrl.listBroadcasts
);

/**
 * @route   GET /api/backoffice/broadcasts/:id
 * @desc    Get single broadcast detail
 * @access  All backoffice roles
 */
router.get(
    '/:id',
    ctrl.getBroadcast
);

/**
 * @route   DELETE /api/backoffice/broadcasts/:id
 * @desc    Cancel a scheduled broadcast
 * @access  super_admin, admin, manager
 */
router.delete(
    '/:id',
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    ctrl.cancelBroadcast
);

module.exports = router;