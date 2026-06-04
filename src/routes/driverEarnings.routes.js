// src/routes/driverEarnings.routes.js
//
// ═══════════════════════════════════════════════════════════════════════
// DRIVER EARNINGS ROUTES
// ═══════════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');
const router  = express.Router();

const { authenticate }   = require('../middleware/auth.middleware');
const earningsController = require('../controllers/driverEarnings.controller');

// ─────────────────────────────────────────────────────────────────────
// WEBHOOK — Must be declared BEFORE router.use(authenticate)
// ─────────────────────────────────────────────────────────────────────
// CamPay calls this endpoint directly from their servers.
// It must NOT be behind auth middleware (CamPay has no driver JWT).
//
// IMPORTANT: In app.js, mount this path with express.raw() BEFORE the
// global express.json() so the raw body is available for signature
// validation:
//
//   app.use(
//     '/api/driver/earnings/campay/webhook',
//     express.raw({ type: 'application/json' }),
//     (req, res, next) => { req.rawBody = req.body; next(); }
//   );
//   app.use(express.json());
//
// In dev/sandbox where you haven't set CAMPAY_WEBHOOK_SECRET you can
// skip the raw body setup — the controller will pass validation anyway.
// ─────────────────────────────────────────────────────────────────────
router.post('/campay/webhook', earningsController.campayWebhook);

// ─────────────────────────────────────────────────────────────────────
// AUTHENTICATED ROUTES — All require a valid driver JWT
// ─────────────────────────────────────────────────────────────────────
router.use(authenticate);

// ── GET /api/driver/earnings/summary ──────────────────────────────────
// Wallet balance + today / week / month breakdowns
router.get('/summary', earningsController.getSummary);

// ── GET /api/driver/earnings/trips ────────────────────────────────────
// Paginated trip receipts
// Query: page, limit, period (today | week | month | all)
router.get('/trips', earningsController.getTripReceipts);

// ── GET /api/driver/earnings/activity ─────────────────────────────────
// Full wallet transaction ledger
// Query: page, limit, period (today | week | month | all), type
router.get('/activity', earningsController.getActivity);

// ── GET /api/driver/earnings/quests ───────────────────────────────────
// Active bonus programs + driver's live progress toward each
router.get('/quests', earningsController.getQuests);

// ── POST /api/driver/earnings/topup ───────────────────────────────────
// Initiate a CamPay mobile money collection (wallet top-up)
// Body:    { amount: number, phone: string }
// Returns: { pending: true, txId, paymentId, campayRef, ussdCode, message }
// Balance credited asynchronously when /campay/webhook fires SUCCESSFUL.
router.post('/topup', earningsController.initiateTopUp);

// ── POST /api/driver/earnings/withdraw ────────────────────────────────
// Initiate a CamPay disbursement (withdraw earnings to mobile money)
// Body:    { amount: number, phone: string }
// Returns: { txId, paymentId, campayRef, newBalance, message }
// Result is SYNCHRONOUS — CamPay confirms or rejects immediately.
// No webhook needed. Failed transfers are auto-reversed.
router.post('/withdraw', earningsController.initiateWithdraw);

module.exports = router;