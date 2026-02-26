const express = require('express');
const router = express.Router();
const tripController = require('../controllers/tripController');
const { authenticate } = require('../middleware/auth.middleware');

// Static routes FIRST (before any /:tripId)
router.get('/recent', authenticate, tripController.getRecentTrips);
router.get('/active', authenticate, tripController.getActiveTrip);
router.get('/history', authenticate, tripController.getTripHistory);

// Parameterized routes AFTER
router.get('/:tripId', authenticate, tripController.getTripDetails);
router.get('/:tripId/events', authenticate, tripController.getTripEvents);
router.put('/:tripId/cancel', authenticate, tripController.cancelTrip);
router.post('/', authenticate, tripController.createTrip);

module.exports = router;