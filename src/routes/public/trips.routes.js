// backend/src/routes/public/trips.routes.js

const express = require('express');
const router = express.Router();
const tripsController = require('../../controllers/public/tripsController');
const mainTripController = require('../../controllers/tripController');
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
// STATIC ROUTES THAT WOULD OTHERWISE BE SHADOWED BY /:tripId
// ═══════════════════════════════════════════════════════════════════════
// This router is mounted on /api/trips BEFORE the main trip router, so an
// unqualified `/:tripId` below captures sibling static paths — notably
// GET /trips/active (trip RESUME after phone-off) and GET /trips/history,
// which were resolving to getTripDetails and 404-ing as "Trip not found".
// Declaring them here (before /:tripId) routes them to the real handlers.
// (Express 5 dropped inline param-regex, so we list the routes explicitly.)
router.get('/active',  mainTripController.getActiveTrip);
router.get('/history', mainTripController.getTripHistory);

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