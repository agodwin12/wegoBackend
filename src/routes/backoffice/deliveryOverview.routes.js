// src/routes/backoffice/deliveryOverview.routes.js

const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/backoffice/deliveryOverview.controller');
const { authenticateEmployee } = require('../../middleware/employeeAuth.middleware');

router.use(authenticateEmployee);

// GET /api/backoffice/delivery/overview
router.get('/', ctrl.getOverview);

module.exports = router;