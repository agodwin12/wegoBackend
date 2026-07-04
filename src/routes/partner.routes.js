// src/routes/partner.routes.js
// Partner fleet API — PARTNER accounts only (created by the company).

const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth.middleware');
const partnerController = require('../controllers/partner/partner.controller');

// Only PARTNER accounts may use this namespace.
function requirePartner(req, res, next) {
    if (req.user?.user_type !== 'PARTNER') {
        return res.status(403).json({
            success: false,
            message: 'This area is reserved for WeGo partners.',
            code:    'PARTNER_ONLY',
        });
    }
    next();
}

router.use(authenticate, requirePartner);

// Fleet dashboard (KPIs)
router.get('/dashboard', partnerController.dashboard);

// Drivers CRUD + lifecycle
router.get('/drivers',                    partnerController.listDrivers);
router.post('/drivers',                   partnerController.createDriver);
router.get('/drivers/:uuid',              partnerController.getDriver);
router.patch('/drivers/:uuid/suspend',    partnerController.suspendDriver);
router.patch('/drivers/:uuid/reactivate', partnerController.reactivateDriver);
router.delete('/drivers/:uuid',           partnerController.deleteDriver);

// Wallet
router.post('/drivers/:uuid/topup',       partnerController.topupDriver);

module.exports = router;
