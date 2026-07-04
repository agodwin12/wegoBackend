// src/routes/backoffice/fleetOwnerRoutes.js
// Ride-hailing FLEET OWNERS — backoffice admin (employee-authenticated).

const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/backoffice/fleetOwnerAdmin.controller');
const { authenticateEmployee } = require('../../middleware/employeeAuth.middleware');

router.use(authenticateEmployee);

router.post('/',                  ctrl.createFleetOwner);
router.get('/',                   ctrl.listFleetOwners);
router.get('/:id',                ctrl.getFleetOwner);
router.patch('/:id/suspend',      ctrl.suspendFleetOwner);
router.patch('/:id/reactivate',   ctrl.reactivateFleetOwner);
router.delete('/:id',             ctrl.deleteFleetOwner);

module.exports = router;
