// src/routes/fareRoutes.js

'use strict';

const express        = require('express');
const router         = express.Router();
const fareController = require('../controllers/fareController');
const { authenticateToken } = require('../middleware/auth.middleware');

/**
 * POST /trips/fare-estimates
 * Get fare estimates for all vehicle types
 * Body: { pickupLat, pickupLng, dropoffLat, dropoffLng }
 */
router.post('/fare-estimates', authenticateToken, fareController.getFareEstimates);

module.exports = router;