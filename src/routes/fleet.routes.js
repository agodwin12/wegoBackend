// src/routes/fleet.routes.js
// Ride-hailing FLEET-OWNER API — FLEET_OWNER accounts only (created by WeGo
// staff in the backoffice). Distinct from the vehicle-rental partner routes.

const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth.middleware');
const fleetController = require('../controllers/fleet/fleetOwner.controller');

// Only FLEET_OWNER accounts may use this namespace.
function requireFleetOwner(req, res, next) {
    if (req.user?.user_type !== 'FLEET_OWNER') {
        return res.status(403).json({
            success: false,
            message: 'This area is reserved for WeGo fleet owners.',
            code:    'FLEET_OWNER_ONLY',
        });
    }
    next();
}

router.use(authenticate, requireFleetOwner);

// Fleet dashboard (KPIs)
router.get('/dashboard', fleetController.dashboard);

// Drivers CRUD + lifecycle
router.get('/drivers',                    fleetController.listDrivers);
router.post('/drivers',                   fleetController.createDriver);
router.get('/drivers/:uuid',              fleetController.getDriver);
router.patch('/drivers/:uuid/suspend',    fleetController.suspendDriver);
router.patch('/drivers/:uuid/reactivate', fleetController.reactivateDriver);
router.delete('/drivers/:uuid',           fleetController.deleteDriver);

// Wallet
router.post('/drivers/:uuid/topup',       fleetController.topupDriver);

module.exports = router;
