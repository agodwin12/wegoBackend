// backend/src/routes/public/promotions.routes.js

const express = require('express');
const router = express.Router();
const promotionsController = require('../../controllers/public/promotionsController');
const { authenticate, optionalAuth } = require('../../middleware/auth.middleware');

// ═══════════════════════════════════════════════════════════════════════
// PROMOTIONS/COUPONS ROUTES FOR MOBILE USERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   POST /api/promotions/validate
 * @desc    Validate a coupon code against a fare estimate
 * @access  Private (requires authentication)
 * @body    { code: string, fare_estimate: number }
 */
router.post('/validate', authenticate, promotionsController.validateCoupon);

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

module.exports = router;