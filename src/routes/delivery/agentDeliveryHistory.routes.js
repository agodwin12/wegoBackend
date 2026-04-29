// src/routes/delivery/agentDeliveryHistory.routes.js

'use strict';

const express = require('express');
const router  = express.Router();

const ctrl = require('../../controllers/delivery/agentDeliveryHistory.controller');
const { authenticate }                    = require('../../middleware/auth.middleware');
const { requireDriver, requireDriverAny } = require('../../middleware/driver.middleware');

const driverAuth = [authenticate, requireDriver];

// ═══════════════════════════════════════════════════════════════════════════════
// AGENT DELIVERY HISTORY ROUTES
// All mounted under /api/deliveries/agent
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/deliveries/agent/history/earnings
 * Aggregated earnings breakdown: today / week / month / all-time
 * ⚠️ Must be before /:id route
 */
router.get('/history/earnings', ...driverAuth, ctrl.getEarningsSummary);

/**
 * GET /api/deliveries/agent/history
 * Paginated delivery history for the authenticated agent
 * Query: page, limit, status, delivery_type, payment_method, from, to
 */
router.get('/history', ...driverAuth, ctrl.getHistory);

/**
 * GET /api/deliveries/agent/history/:id
 * Full detail for a single delivery including wallet transactions
 */
router.get('/history/:id', ...driverAuth, ctrl.getDetail);

module.exports = router;