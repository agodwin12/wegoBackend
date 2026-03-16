// src/routes/backoffice/deliveryDisputes.routes.js

const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/backoffice/deliveryDisputes.controller');

const { authenticateEmployee } = require('../../middleware/employeeAuth.middleware');
const { requireEmployeeRole }  = require('../../middleware/employeeAuth.middleware');

router.use(authenticateEmployee);

// GET  /api/backoffice/delivery/disputes        — paginated list
router.get('/',                ctrl.getDisputes);

// GET  /api/backoffice/delivery/disputes/:id    — single dispute full detail
router.get('/:id',             ctrl.getDispute);

// PATCH /api/backoffice/delivery/disputes/:id/assign   — assign to self
router.patch('/:id/assign',    ctrl.assignDispute);

// PATCH /api/backoffice/delivery/disputes/:id/note     — add admin note
router.patch('/:id/note',      ctrl.addNote);

// PATCH /api/backoffice/delivery/disputes/:id/priority — change priority
router.patch('/:id/priority',  ctrl.updatePriority);

// POST  /api/backoffice/delivery/disputes/:id/resolve  — resolve with decision
router.post('/:id/resolve',    requireEmployeeRole('super_admin', 'admin', 'manager'), ctrl.resolveDispute);

// POST  /api/backoffice/delivery/disputes/:id/close    — close after resolution
router.post('/:id/close',      requireEmployeeRole('super_admin', 'admin', 'manager'), ctrl.closeDispute);

module.exports = router;