// src/routes/backoffice/rideSurgeRoutes.js
//
// Ride-hailing surge rules — backoffice admin. Mounted at /api/backoffice/ride-surge
// (kept off /api/backoffice/pricing so it never collides with pricing's /:id route).

const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/backoffice/rideSurgeController');
const { authenticateEmployee, requireEmployeeRole } = require('../../middleware/employeeAuth.middleware');

router.use(authenticateEmployee);

// Read — any signed-in employee with pricing visibility
router.get('/active', ctrl.getActiveSurge); // before /:id (no :id here, but keep order clear)
router.get('/',       ctrl.getSurgeRules);

// Write — managers and up
router.post('/',       requireEmployeeRole('super_admin', 'admin', 'manager'), ctrl.createSurgeRule);
router.put('/:id',     requireEmployeeRole('super_admin', 'admin', 'manager'), ctrl.updateSurgeRule);
router.delete('/:id',  requireEmployeeRole('super_admin', 'admin'), ctrl.deleteSurgeRule);

module.exports = router;
