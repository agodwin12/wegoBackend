// src/routes/driverPayout.routes.js
//
// ═══════════════════════════════════════════════════════════════════════
// DRIVER PAYOUT ROUTES (Mobile)
// ═══════════════════════════════════════════════════════════════════════
//
// Mounted at: /api/request/payout/driver
// Auth:       authenticateUser (mobile JWT — passengers/drivers)
//
// All routes here are for the DRIVER only.
// The authenticateUser middleware sets req.user from the JWT.
// Controllers enforce driverId = req.user.uuid on every query.
//
// ═══════════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');
const router  = express.Router();

const { authenticate } = require('../middleware/auth.middleware');
const driverPayoutController = require('../controllers/driverPayout.controller');

// All routes require a valid driver/user session
router.use(authenticate);

/**
 * POST /api/request/payout/driver
 * Driver submits a new payout request.
 * Body: amount (int, XAF), paymentMethod (CASH | MOMO | OM), note? (string)
 * - Amount must be > 0 and <= wallet balance
 * - paymentPhone auto-filled from driver's profile phone_e164
 */
router.post('/', driverPayoutController.requestPayout);

/**
 * GET /api/request/payout/driver
 * Driver lists their own payout request history.
 * Query: status? (PENDING | PROCESSING | PAID | REJECTED | CANCELLED), page?, limit?
 * Also returns current wallet balance.
 */
router.get('/', driverPayoutController.listMyPayouts);

/**
 * GET /api/request/payout/driver/:id
 * Driver fetches a single payout request by ID.
 * Ownership enforced — driver cannot fetch another driver's request.
 */
router.get('/:id', driverPayoutController.getMyPayout);

/**
 * DELETE /api/request/payout/driver/:id
 * Driver cancels a PENDING payout request.
 * Only PENDING requests can be cancelled — PROCESSING/PAID cannot.
 */
router.delete('/:id', driverPayoutController.cancelMyPayout);

module.exports = router;