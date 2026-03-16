// src/routes/backoffice/deliveryHistory.routes.js

const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/backoffice/deliveryHistory.controller');
const { authenticateEmployee } = require('../../middleware/employeeAuth.middleware');

router.use(authenticateEmployee);

// GET /api/backoffice/delivery/history/stats  — summary counts + revenue
router.get('/stats',  ctrl.getStats);

// GET /api/backoffice/delivery/history        — paginated filtered list
router.get('/',       ctrl.getHistory);

module.exports = router;