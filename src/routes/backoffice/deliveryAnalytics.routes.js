// src/routes/backoffice/deliveryAnalytics.routes.js

const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/backoffice/deliveryAnalytics.controller');
const { authenticateEmployee } = require('../../middleware/employeeAuth.middleware');

router.use(authenticateEmployee);

// GET /api/backoffice/delivery/analytics?period=30d
router.get('/', ctrl.getAnalytics);

module.exports = router;