// backend/src/routes/serviceRating.routes.js
// Service Rating & Review Routes - WITH VALIDATION

const express = require('express');
const router = express.Router();
const serviceRatingController = require('../controllers/serviceRating.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const { upload } = require('../middleware/upload');
const validate = require('../middleware/validate'); // ✅ IMPORT VALIDATE MIDDLEWARE
const schemas = require('../validators/servicesMarketplace.validator'); // ✅ IMPORT SCHEMAS

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC ROUTES (No authentication required)
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   GET /api/services/ratings/listing/:listing_id
 * @desc    Get all ratings for a specific listing
 * @access  Public
 */
router.get(
    '/listing/:listing_id',
    validate(schemas.getRatings),
    serviceRatingController.getRatingsForListing
);

/**
 * @route   GET /api/services/ratings/:id
 * @desc    Get single rating by ID
 * @access  Public
 */
router.get('/:id', serviceRatingController.getRatingById);

// ═══════════════════════════════════════════════════════════════════════
// PROTECTED ROUTES (Authentication required)
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   POST /api/services/ratings
 * @desc    Create rating/review for completed service (Customer only)
 * @access  Private (Customer)
 */
router.post(
    '/',
    authenticateToken,
    upload.array('review_photos', 3),
    validate(schemas.createRating),
    serviceRatingController.createRating
);

/**
 * @route   GET /api/services/ratings/my/ratings
 * @desc    Get customer's submitted ratings
 * @access  Private (Customer)
 */
router.get(
    '/my/ratings',
    authenticateToken,
    validate(schemas.getRatings),
    serviceRatingController.getMyRatings
);

/**
 * @route   GET /api/services/ratings/provider/my-ratings
 * @desc    Get all ratings for the provider (across all their moderation)
 * @access  Private (Provider)
 */
router.get(
    '/provider/my-ratings',
    authenticateToken,
    validate(schemas.getRatings),
    serviceRatingController.getRatingsForProvider
);

/**
 * @route   POST /api/services/ratings/:id/provider-response
 * @desc    Add provider response to a rating (Provider only)
 * @access  Private (Provider)
 */
router.post(
    '/:id/provider-response',
    authenticateToken,
    validate(schemas.addProviderResponse),
    serviceRatingController.addProviderResponse
);

/**
 * @route   POST /api/services/ratings/:id/flag
 * @desc    Flag/report inappropriate review
 * @access  Private (Any authenticated user)
 */
router.post(
    '/:id/flag',
    authenticateToken,
    validate(schemas.flagRating),
    serviceRatingController.flagRating
);

/**
 * @route   POST /api/services/ratings/:id/helpful
 * @desc    Mark rating as helpful
 * @access  Private (Any authenticated user)
 */
router.post('/:id/helpful', authenticateToken, serviceRatingController.markAsHelpful);

module.exports = router;