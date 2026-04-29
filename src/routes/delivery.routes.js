
'use strict';

const express = require('express');
const multer  = require('multer');
const router  = express.Router();

const ctrl            = require('../controllers/delivery.controller');
const topUpCtrl       = require('../controllers/delivery/walletTopUp.controller');
const categoriesCtrl  = require('../controllers/deliveryCategories.public.controller');

const { authenticate }                          = require('../middleware/auth.middleware');
const { requireDriver, requireDriverAny }       = require('../middleware/driver.middleware');
const { validateDeliveryType,
    requireDeliveryWalletBalance }          = require('../middleware/delivery.middleware');

const locationService = require('../services/locationService');
const { Driver }       = require('../models');

// ─── Middleware chains ────────────────────────────────────────────────────────
const driverAuth    = [authenticate, requireDriver];
const driverAuthAny = [authenticate, requireDriverAny];

// ─── Multer for top-up proof screenshot ──────────────────────────────────────
const proofUpload = multer({
    storage: multer.memoryStorage(),
    limits:  { fileSize: 5 * 1024 * 1024 },
    fileFilter(_req, file, cb) {
        const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
        cb(allowed.includes(file.mimetype) ? null : new Error('Only JPEG/PNG/WEBP accepted'), allowed.includes(file.mimetype));
    },
});



router.get('/nearby-drivers', authenticate, async (req, res) => {
    try {
        const lat    = parseFloat(req.query.lat);
        const lng    = parseFloat(req.query.lng);
        const radius = parseFloat(req.query.radius || 5);

        if (isNaN(lat) || isNaN(lng)) {
            return res.status(400).json({
                success: false,
                message: 'lat and lng are required query parameters',
            });
        }

        // findNearbyDrivers(lng, lat, radiusKm) — note: lng first
        const nearby = await locationService.findNearbyDrivers(lng, lat, radius, 50);

        if (!nearby.length) {
            return res.json({ success: true, drivers: [] });
        }

        // Filter to delivery mode only
        const ids            = nearby.map(d => d.driverId);
        const deliveryDrivers = await Driver.findAll({
            where:      { id: ids, current_mode: 'delivery' },
            attributes: ['id'],
        });
        const deliveryIds = new Set(deliveryDrivers.map(d => d.id));

        const drivers = nearby
            .filter(d => deliveryIds.has(d.driverId))
            .map(d => ({
                id:       d.driverId,
                lat:      d.lat,
                lng:      d.lng,
                heading:  d.heading || 0,
                distance: parseFloat(d.distance.toFixed(2)), // km
            }));

        return res.json({ success: true, drivers });

    } catch (error) {
        console.error('❌ [DELIVERY] nearby-drivers error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch nearby drivers' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC — no auth required
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/deliveries/categories
 * Package category list with emoji + labels for Flutter dropdown
 */
router.get('/categories', categoriesCtrl.getActiveCategories);

// ═══════════════════════════════════════════════════════════════════════════════
// DRIVER WALLET — named routes first to avoid /:id collision
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/deliveries/driver/wallet
 * Full wallet balances including reserved_balance and available_balance
 */
router.get('/driver/wallet', authenticate, ctrl.getWallet);

/**
 * GET /api/deliveries/driver/wallet/transactions
 * Paginated transaction ledger
 * Query: page, limit
 */
router.get('/driver/wallet/transactions', authenticate, ctrl.getWalletTransactions);

/**
 * GET /api/deliveries/driver/wallet/topup
 * Driver's own top-up request history
 * Query: page, limit, status
 */
router.get('/driver/wallet/topup', authenticate, topUpCtrl.getMyTopUps);

/**
 * GET /api/deliveries/driver/wallet/topup/:id
 * Single top-up request detail (scoped to calling driver)
 */
router.get('/driver/wallet/topup/:id', authenticate, topUpCtrl.getTopUpDetail);

/**
 * POST /api/deliveries/driver/wallet/topup
 * Submit a wallet reload request
 * Body (multipart/form-data):
 *   amount            {number}  required
 *   payment_channel   {string}  required  — cash | mtn_mobile_money | orange_money
 *   proof             {file}    optional  — required for MTN/Orange
 *   payment_reference {string}  optional
 *   sender_phone      {string}  optional
 *   driver_note       {string}  optional
 */
router.post('/driver/wallet/topup', authenticate, proofUpload.single('proof'), topUpCtrl.submitTopUp);

/**
 * POST /api/deliveries/driver/cashout
 * Request withdrawal of wallet balance
 * Body: { amount, payment_method, phone_number, notes? }
 */
router.post('/driver/cashout', authenticate, ctrl.requestCashout);

/**
 * POST /api/deliveries/driver/cashout/:requestId/cancel
 * Cancel a pending cashout request
 */
router.post('/driver/cashout/:requestId/cancel', authenticate, ctrl.cancelCashout);

// ═══════════════════════════════════════════════════════════════════════════════
// DRIVER OPERATIONAL — named routes
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/deliveries/driver/mode
 * Toggle between 'ride' and 'delivery' mode
 * Body: { mode: 'ride' | 'delivery' }
 */
router.post('/driver/mode', driverAuthAny, ctrl.toggleDriverMode);

/**
 * GET /api/deliveries/driver/history
 * Driver's own delivery history
 * Query: page, limit, status
 */
router.get('/driver/history', driverAuth, ctrl.getDriverDeliveries);

// ═══════════════════════════════════════════════════════════════════════════════
// SENDER — named routes
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/deliveries/estimate
 * Price estimate before booking
 * Query: pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, package_size, delivery_type?
 */
router.get('/estimate', authenticate, ctrl.getEstimate);

/**
 * POST /api/deliveries/book
 * Book a new delivery
 * Body: pickup/dropoff coords+addresses, recipient info, package details,
 *       payment_method, delivery_type ('regular'|'express', default 'regular')
 */
router.post('/book', authenticate, validateDeliveryType, ctrl.bookDelivery);

/**
 * GET /api/deliveries/my
 * Sender's own delivery history
 * Query: page, limit, status
 */
router.get('/my', authenticate, ctrl.getMyDeliveries);

// ═══════════════════════════════════════════════════════════════════════════════
// PARAMETERISED — driver actions on a specific delivery
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/deliveries/:id/accept
 * Driver accepts a delivery offer
 * Middleware: requireDeliveryWalletBalance blocks if available balance < commission
 */
router.post('/:id/accept',
    ...driverAuth,
    requireDeliveryWalletBalance,
    ctrl.acceptDelivery
);

/**
 * POST /api/deliveries/:id/status
 * Driver moves through delivery stages
 * Body: { status, pickup_photo_url? }
 */
router.post('/:id/status', ...driverAuth, ctrl.updateStatus);

/**
 * POST /api/deliveries/:id/verify-pin
 * Driver verifies recipient PIN to complete delivery
 * Body: { pin }
 */
router.post('/:id/verify-pin', ...driverAuth, ctrl.verifyPin);

/**
 * POST /api/deliveries/:id/confirm-cash
 * Driver confirms cash received (cash payment_method only)
 */
router.post('/:id/confirm-cash', ...driverAuth, ctrl.confirmCash);

// ═══════════════════════════════════════════════════════════════════════════════
// PARAMETERISED — sender actions
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/deliveries/:id/rate
 * Sender rates a completed delivery
 * Body: { rating: 1-5, comment? }
 */
router.post('/:id/rate', authenticate, ctrl.rateDelivery);

// ═══════════════════════════════════════════════════════════════════════════════
// PARAMETERISED — shared (sender OR driver)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/deliveries/:id/cancel
 * Cancel a delivery (before pickup only)
 * Body: { reason? }
 */
router.post('/:id/cancel', authenticate, ctrl.cancelDelivery);

/**
 * GET /api/deliveries/:id
 * Full delivery detail
 * ⚠️ MUST BE LAST — catches everything as :id
 */
router.get('/:id', authenticate, ctrl.getDelivery);

module.exports = router;