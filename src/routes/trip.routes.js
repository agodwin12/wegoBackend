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

module.exports = router;