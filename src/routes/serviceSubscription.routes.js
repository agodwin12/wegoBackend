// src/routes/serviceSubscription.routes.js
// Provider-level service subscriptions — "buy a plan, then post".

const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/serviceSubscription.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

router.use(authenticateToken);

router.get('/mine',              ctrl.getMySubscription);
router.post('/activate-free',    ctrl.activateFreeSubscription);
router.post('/initiate-payment', ctrl.initiateSubscription);

module.exports = router;
