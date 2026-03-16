// src/routes/backoffice/deliveryCategories.routes.js

const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/backoffice/deliveryCategories.controller');
const {
    authenticateEmployee,
    requireEmployeeRole,
} = require('../../middleware/employeeAuth.middleware');

router.use(authenticateEmployee);

// All write operations restricted to admin, super_admin, manager
const canManage = requireEmployeeRole('super_admin', 'admin', 'manager');

// GET    /api/backoffice/delivery/categories          — list all (all employees)
router.get('/',           ctrl.getCategories);

// POST   /api/backoffice/delivery/categories          — create new
router.post('/',          canManage, ctrl.createCategory);

// POST   /api/backoffice/delivery/categories/reorder  — reorder (must be before /:id)
router.post('/reorder',   canManage, ctrl.reorderCategories);

// PUT    /api/backoffice/delivery/categories/:id      — update name/emoji/order
router.put('/:id',        canManage, ctrl.updateCategory);

// PATCH  /api/backoffice/delivery/categories/:id/toggle — activate/deactivate
router.patch('/:id/toggle', canManage, ctrl.toggleCategory);

// DELETE /api/backoffice/delivery/categories/:id      — delete (only if unused)
router.delete('/:id',     canManage, ctrl.deleteCategory);

module.exports = router;