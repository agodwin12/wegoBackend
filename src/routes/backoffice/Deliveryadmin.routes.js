// src/routes/backoffice/deliveryAdmin.routes.js

const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/backoffice/deliveryAdmin.controller');

const { authenticateEmployee }  = require('../../middleware/employeeAuth.middleware');
const { requireEmployeeRole }   = require('../../middleware/employeeAuth.middleware');

// All routes require employee authentication
router.use(authenticateEmployee);

// ─── Pricing Zones ────────────────────────────────────────────────────────────
router.get('/pricing',              ctrl.getPricingZones);
router.post('/pricing',             requireEmployeeRole('super_admin', 'admin', 'manager'), ctrl.createPricingZone);
router.put('/pricing/:id',          requireEmployeeRole('super_admin', 'admin', 'manager'), ctrl.updatePricingZone);
router.delete('/pricing/:id',       requireEmployeeRole('super_admin', 'admin'), ctrl.deletePricingZone);
router.post('/pricing/preview',     ctrl.previewPrice);

// ─── Surge Rules ──────────────────────────────────────────────────────────────
router.get('/surge/active',         ctrl.getActiveSurge);  // before /:id
router.get('/surge',                ctrl.getSurgeRules);
router.post('/surge',               requireEmployeeRole('super_admin', 'admin', 'manager'), ctrl.createSurgeRule);
router.put('/surge/:id',            requireEmployeeRole('super_admin', 'admin', 'manager'), ctrl.updateSurgeRule);
router.delete('/surge/:id',         requireEmployeeRole('super_admin', 'admin'), ctrl.deleteSurgeRule);

module.exports = router;