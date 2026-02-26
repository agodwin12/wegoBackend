// backend/src/routes/public/trips.routes.js

const express = require('express');
const router = express.Router();
const tripsController = require('../../controllers/public/tripsController');
const { authenticate } = require('../../middleware/auth.middleware');

// ═══════════════════════════════════════════════════════════════════════
// TRIPS PUBLIC VIEWING ROUTES
// ═══════════════════════════════════════════════════════════════════════
// This router is mounted at: /api/trips
// Routes defined here:
//   GET /recent      → becomes GET /api/trips/recent
//   GET /:tripId     → becomes GET /api/trips/:tripId
// ═══════════════════════════════════════════════════════════════════════

// All routes require authentication
router.use(authenticate);

// ═══════════════════════════════════════════════════════════════════════
// GET RECENT TRIPS
// ═══════════════════════════════════════════════════════════════════════
// IMPORTANT: /recent MUST be defined BEFORE /:tripId to avoid "recent"
// being treated as a trip ID parameter
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   GET /api/trips/recent
 * @desc    Get recent trips for authenticated user
 * @access  Private
 * @query   limit - Number of trips (default: 10)
 * @query   status - Filter by status (optional)
 */
router.get('/recent', tripsController.getRecentTrips);

// ═══════════════════════════════════════════════════════════════════════
// GET TRIP DETAILS
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   GET /api/trips/:tripId
 * @desc    Get single trip details
 * @access  Private (user must be passenger or driver)
 * @params  tripId - UUID of the trip
 */
router.get('/:tripId', tripsController.getTripDetails);

// ═══════════════════════════════════════════════════════════════════════
// EXPORT ROUTER
// ═══════════════════════════════════════════════════════════════════════

module.exports = router;