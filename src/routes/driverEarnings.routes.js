
'use strict';

const express = require('express');
const router  = express.Router();

const { authenticate }  = require('../middleware/auth.middleware');
const earningsController    = require('../controllers/driverEarnings.controller');

// All earnings routes require a valid driver JWT
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

module.exports = router;