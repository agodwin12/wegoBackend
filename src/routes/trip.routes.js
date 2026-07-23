const express = require('express');
const router = express.Router();
const tripController = require('../controllers/tripController');
const { authenticate } = require('../middleware/auth.middleware');

// Static routes FIRST (before any /:tipId)
router.get('/recent', authenticate, tripController.getRecentTrips);
router.get('/active', authenticate, tripController.getActiveTrip);
router.get('/history', authenticate, tripController.getTripHistory);
// Trip payment route removed — ride fares are paid directly to the driver (P2P),
// never through WeGo/CamPay. CamPay is only used for driver wallet top-ups.
// Parameterized routes AFTER
router.get('/:tripId', authenticate, tripController.getTripDetails);
router.get('/:tripId/events', authenticate, tripController.getTripEvents);
router.put('/:tripId/cancel', authenticate, tripController.cancelTrip);
router.post('/:tripId/sos', authenticate, tripController.raiseSos);
router.post('/:tripId/share', authenticate, tripController.shareTrip);
router.post('/', authenticate, tripController.createTrip);


module.exports = router;