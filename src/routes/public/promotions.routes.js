// backend/src/routes/public/promotions.routes.js

const express = require('express');
const router = express.Router();
const promotionsController = require('../../controllers/public/promotionsController');  // ← ADD THIS LINE
const { authenticate, optionalAuth } = require('../../middleware/auth.middleware');

// ═══════════════════════════════════════════════════════════════════════
// PROMOTIONS/COUPONS ROUTES FOR MOBILE USERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   GET /api/promotions/active
 * @desc    Get all active promotions/coupons
 * @access  Public (optionalAuth - personalization if logged in)
 */
router.get('/active', optionalAuth, promotionsController.getActivePromotions);

/**
 * @route   GET /api/promotions/:code
 * @desc    Get specific coupon details by code
 * @access  Public
 */
router.get('/:code', promotionsController.getCouponByCode);

/**
 * @route   POST /api/promotions/validate
 * @desc    Validate a coupon code for a trip
 * @access  Private (requires authentication)
 */
router.post('/validate', authenticate, promotionsController.validateCoupon);

// ═══════════════════════════════════════════════════════════════════════
// EXPORT ROUTER
// ═══════════════════════════════════════════════════════════════════════

module.exports = router;