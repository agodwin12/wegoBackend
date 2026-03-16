// src/routes/delivery.routes.js

const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/delivery.controller');
const categoriesCtrl = require('../controllers/deliveryCategories.public.controller');


const { authenticate }                   = require('../middleware/auth.middleware');
const { requireDriver, requireDriverAny } = require('../middleware/driver.middleware');


const driverAuth = [authenticate, requireDriver];

// Any driver status — used for mode toggle and history (PENDING drivers can still view)
const driverAuthAny = [authenticate, requireDriverAny];

// ═══════════════════════════════════════════════════════════════════════════════
// IMPORTANT: Named routes MUST come before /:id parameterised routes
// Otherwise Express matches 'estimate', 'my', 'driver' etc. as :id values
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// DRIVER NAMED ROUTES — defined first to avoid :id collision
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/deliveries/driver/mode
 * Toggle between 'ride' and 'delivery' mode
 * Body: { mode: 'ride' | 'delivery' }
 * Any status driver — switching mode doesn't require ACTIVE
 */
router.post('/driver/mode', driverAuthAny, ctrl.toggleDriverMode);

/**
 * GET /api/deliveries/driver/history
 * Driver's own delivery history
 * Query: page, limit, status
 */
router.get('/driver/history', driverAuth, ctrl.getDriverDeliveries);

// ═══════════════════════════════════════════════════════════════════════════════
// PASSENGER (SENDER) NAMED ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/deliveries/estimate
 * Price estimate before booking — no delivery created yet
 * Query: pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, package_size
 * Any authenticated user (passenger or driver can check estimates)
 */
router.get('/estimate', authenticate, ctrl.getEstimate);

/**
 * POST /api/deliveries/book
 * Book a new delivery
 * Body: pickup/dropoff coords + addresses, recipient_name, recipient_phone,
 *       recipient_note, package_size, package_description, is_fragile, payment_method
 */
router.post('/book', authenticate, ctrl.bookDelivery);

/**
 * GET /api/deliveries/my
 * Sender's own delivery history
 * Query: page, limit, status
 */
router.get('/my', authenticate, ctrl.getMyDeliveries);

// ═══════════════════════════════════════════════════════════════════════════════
// PARAMETERISED ROUTES — driver-only actions on a specific delivery
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/deliveries/:id/accept
 * Driver accepts a delivery offer
 * No body required — delivery ID is sufficient
 * ACTIVE drivers only
 */
router.post('/:id/accept', driverAuth, ctrl.acceptDelivery);

/**
 * POST /api/deliveries/:id/status
 * Driver updates delivery status
 * Body: { status: 'en_route_pickup' | 'arrived_pickup' | 'picked_up' | 'en_route_dropoff' | 'arrived_dropoff',
 *         pickup_photo_url?: string }
 * ACTIVE drivers only
 */
router.post('/:id/status', driverAuth, ctrl.updateStatus);

/**
 * POST /api/deliveries/:id/verify-pin
 * Driver enters recipient's PIN to complete delivery
 * Body: { pin: '1234' }
 * ACTIVE drivers only
 */
router.post('/:id/verify-pin', driverAuth, ctrl.verifyPin);

/**
 * POST /api/deliveries/:id/confirm-cash
 * Driver confirms cash received from recipient
 * No body required
 * ACTIVE drivers only — only relevant when payment_method = 'cash'
 */
router.post('/:id/confirm-cash', driverAuth, ctrl.confirmCash);

// ═══════════════════════════════════════════════════════════════════════════════
// PARAMETERISED ROUTES — sender actions on a specific delivery
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/deliveries/:id/rate
 * Sender rates a completed delivery
 * Body: { rating: 1-5, comment?: string }
 * Any authenticated user (controller verifies they are the sender)
 */
router.post('/:id/rate', authenticate, ctrl.rateDelivery);

// ═══════════════════════════════════════════════════════════════════════════════
// PARAMETERISED ROUTES — shared (sender OR driver)
// Controller determines who is calling via req.user.user_type
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/deliveries/:id/cancel
 * Cancel a delivery
 * Body: { reason?: string }
 * Both sender and driver can cancel
 * Controller checks req.user.user_type to set cancelled_by field
 * Can only cancel before package is picked up
 */
router.post('/:id/cancel', authenticate, ctrl.cancelDelivery);

/**
 * GET /api/deliveries/:id
 * Get full delivery details
 * Accessible by the sender OR the assigned driver
 * Controller checks ownership — returns 403 if neither
 *
 * ⚠️  MUST BE LAST in this file
 * Any named route below this line would be swallowed by :id
 */
router.get('/:id', authenticate, ctrl.getDelivery);

router.get('/driver/wallet',                          authenticate, ctrl.getWallet);
router.get('/driver/wallet/transactions',             authenticate, ctrl.getWalletTransactions);
router.post('/driver/cashout',                        authenticate, ctrl.requestCashout);
router.post('/driver/cashout/:requestId/cancel',      authenticate, ctrl.cancelCashout);
router.get('/categories', categoriesCtrl.getActiveCategories); // no auth

module.exports = router;