// src/routes/partnerPortalRoutes.js
// Self-service routes for rental partners (user_type PARTNER) — the partner
// web portal calls these with the partner's own Bearer token. Everything here
// is scoped to the caller and exposes no pricing.

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/partnerPortal.controller');

/**
 * @route   GET /api/partner/vehicles
 * @desc    Own vehicles + rented-out / back status (no prices)
 * @access  Private (PARTNER)
 */
router.get('/vehicles', authenticate, ctrl.getMyVehicles);

module.exports = router;
