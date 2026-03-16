// src/routes/backoffice/deliveryLiveMonitor.routes.js

const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/backoffice/deliveryLiveMonitor.controller');

const { authenticateEmployee } = require('../../middleware/employeeAuth.middleware');

router.use(authenticateEmployee);

// GET /api/backoffice/delivery/live       — all active deliveries for map
router.get('/',    ctrl.getLiveDeliveries);

// GET /api/backoffice/delivery/live/:id   — single delivery full detail + route
router.get('/:id', ctrl.getLiveDetail);

module.exports = router;