// wegobackend/src/routes/activity/activity.routes.js
// Activity Feed Routes

const express = require('express');
const router = express.Router();
const activityController = require('../../controllers/activity/activity.controller');
const { authenticate } = require('../../middleware/auth.middleware');

// All routes require authentication
router.use(authenticate);

// ─────────────────────────────────────────────────────────────────────
// UNIFIED FEED
// GET /api/activity?page=1&limit=15&type=all|trips|rentals|services
// ─────────────────────────────────────────────────────────────────────
router.get('/', activityController.getAllActivity);

// ─────────────────────────────────────────────────────────────────────
// TRIPS
// GET /api/activity/trips?page=1&limit=10&status=completed|cancelled|all
// ─────────────────────────────────────────────────────────────────────
router.get('/trips', activityController.getTrips);

// ─────────────────────────────────────────────────────────────────────
// RENTALS
// GET /api/activity/rentals?page=1&limit=10&status=PENDING|CONFIRMED|COMPLETED|CANCELLED
// ─────────────────────────────────────────────────────────────────────
router.get('/rentals', activityController.getRentals);

// ─────────────────────────────────────────────────────────────────────
// SERVICES
// GET /api/activity/services?page=1&limit=10&role=customer|provider|all&status=...
// ─────────────────────────────────────────────────────────────────────
router.get('/services', activityController.getServices);

module.exports = router;