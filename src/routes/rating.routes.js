// src/routes/rating.routes.js

const express = require('express');
const router = express.Router();
const ratingController = require('../controllers/rating.controller');
const { authenticate } = require('../middleware/auth.middleware');

/**
 * Rating Routes
 * All routes require authentication
 */

// Submit a rating
router.post(
    '/',
    authenticate,
    ratingController.submitRating
);

// Get ratings for a specific trip
router.get(
    '/trip/:tripId',
    authenticate,
    ratingController.getTripRatings
);

// Get ratings received by a user
router.get(
    '/user/:userId',
    authenticate,
    ratingController.getUserRatings
);

// Check if user has rated a trip
router.get(
    '/check/:tripId',
    authenticate,
    ratingController.checkTripRated
);

module.exports = router;