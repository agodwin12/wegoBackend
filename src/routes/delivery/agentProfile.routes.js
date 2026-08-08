// src/routes/delivery/agentProfile.routes.js

'use strict';

const express = require('express');
const router  = express.Router();

const ctrl = require('../../controllers/delivery/agentProfile.controller');
const { authenticate }                    = require('../../middleware/auth.middleware');
const { requireDriverAny } = require('../../middleware/driver.middleware');

// GET  /api/deliveries/agent/profile
router.get('/profile',  authenticate, requireDriverAny, ctrl.getProfile);

// PUT  /api/deliveries/agent/profile
router.put('/profile',  authenticate, requireDriverAny, ctrl.updateProfile);

module.exports = router;