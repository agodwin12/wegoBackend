// backend/routes/passenger.routes.js

const express = require('express');
const router = express.Router();
const { authenticateUser } = require('../middleware/auth.middleware');
const {
    getPassengerTripHistory,
    getPassengerTripDetail,
} = require('../controllers/trip.controller');

// ─── Passenger Trip Routes ───────────────────────────────────────────────────

// GET /api/passenger/trips/history
// Returns paginated list of COMPLETED + CANCELED trips for the logged-in passenger
router.get('/trips/history', authenticateUser, getPassengerTripHistory);

// GET /api/passenger/trips/:tripId/detail
// Returns full trip detail + rating state for a specific trip
router.get('/trips/:tripId/detail', authenticateUser, getPassengerTripDetail);

module.exports = router;