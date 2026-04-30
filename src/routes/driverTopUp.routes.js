// src/routes/driverTopUp.routes.js
//
// ═══════════════════════════════════════════════════════════════════════
// DRIVER WALLET TOP-UP ROUTES
// ═══════════════════════════════════════════════════════════════════════
//
// Driver-facing routes mounted at /api/driver/wallet
// Admin route is mounted separately in backoffice — see adminEarnings_routes.js
//
// ═══════════════════════════════════════════════════════════════════════

'use strict';

const express    = require('express');
const router     = express.Router();

const { authenticate }               = require('../middleware/auth.middleware');
const { requireDriver, requireDriverAny } = require('../middleware/driver.middleware');
const topUpController                = require('../controllers/driverTopUp.controller');

// ── POST /api/driver/wallet/topup ─────────────────────────────────────
//
// Driver self-service top-up. Credits their own wallet.
// Requires active driver status (requireDriver — not just any).
//
// Body: { amount, method, phone?, reference? }

router.post(
    '/topup',
    authenticate,
    requireDriver,
    topUpController.driverTopUp
);

// ── GET /api/driver/wallet/topup/history ──────────────────────────────
//
// Driver's paginated top-up history.
// requireDriverAny — suspended drivers can still view their history.
//
// Query: { page?, limit?, period? }

router.get(
    '/topup/history',
    authenticate,
    requireDriverAny,
    topUpController.getTopUpHistory
);

module.exports = router;