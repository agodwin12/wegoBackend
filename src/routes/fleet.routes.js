// src/routes/fleet.routes.js
// Ride-hailing FLEET-OWNER API — FLEET_OWNER accounts only (created by WeGo
// staff in the backoffice). Distinct from the vehicle-rental partner routes.

const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth.middleware');
const { uploadProfile } = require('../middleware/upload');
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

// Fleet dashboard (KPIs + 14-day trend series)
router.get('/dashboard', fleetController.dashboard);

// Fleet-wide trips + top-up history (with filters)
router.get('/trips',   fleetController.getFleetTrips);
router.get('/topups',  fleetController.getFleetTopups);

// Drivers CRUD + lifecycle
router.get('/drivers',                    fleetController.listDrivers);
router.post('/drivers',                   fleetController.createDriver);
router.get('/drivers/:uuid',              fleetController.getDriver);
router.get('/drivers/:uuid/trips',        fleetController.getDriverTrips);
router.patch('/drivers/:uuid/suspend',    fleetController.suspendDriver);
router.patch('/drivers/:uuid/reactivate', fleetController.reactivateDriver);
router.delete('/drivers/:uuid',           fleetController.deleteDriver);

// Driver photo (multipart, field "avatar")
router.post('/drivers/:uuid/avatar',      uploadProfile.single('avatar'), fleetController.uploadDriverAvatar);

// Wallet
router.post('/drivers/:uuid/topup',       fleetController.topupDriver);

module.exports = router;
