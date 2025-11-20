// src/routes/trip.routes.js
const express = require('express');
const router = express.Router();
const tripController = require('../controllers/tripController');
const { authenticate } = require('../middleware/auth.middleware');

router.post('/', authenticate, tripController.createTrip);
router.get('/active', authenticate, tripController.getActiveTrip);
router.get('/history', authenticate, tripController.getTripHistory);
router.get('/:tripId', authenticate, tripController.getTripDetails);
router.get('/:tripId/events', authenticate, tripController.getTripEvents);
router.put('/:tripId/cancel', authenticate, tripController.cancelTrip);

// Get recent trips (MUST BE BEFORE /:tripId)
router.get(
    '/recent',
    authenticate,
    tripController.getRecentTrips
);

// Get active trip
router.get(
    '/active',
    authenticate,
    tripController.getActiveTrip
);



// Get trip details (MUST BE AFTER /recent and /active)
router.get(
    '/:tripId',
    authenticate,
    tripController.getTripDetails
);

// Cancel trip
router.put(
    '/:tripId/cancel',
    authenticate,
    tripController.cancelTrip
);

module.exports = router;