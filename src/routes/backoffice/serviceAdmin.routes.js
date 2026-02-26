// backend/src/routes/backoffice/serviceAdmin.routes.js
// Routes for Service Admin Dashboard

const express = require('express');
const router = express.Router();
const serviceAdminController = require('../../controllers/backoffice/serviceAdmin.controller');
const { authenticateEmployee, requireEmployeeRole } = require('../../middleware/employeeAuth.middleware');

// ═══════════════════════════════════════════════════════════════════════
// ALL ROUTES REQUIRE EMPLOYEE AUTHENTICATION
// ═══════════════════════════════════════════════════════════════════════

router.use(authenticateEmployee);

// ═══════════════════════════════════════════════════════════════════════
// DASHBOARD STATISTICS
// ═══════════════════════════════════════════════════════════════════════

// @route   GET /api/services/admin/dashboard/stats
// @desc    Get comprehensive dashboard statistics
// @access  Employee (admin, manager, super_admin)
router.get(
    '/dashboard/stats',
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    serviceAdminController.getDashboardStats
);

// @route   GET /api/services/admin/dashboard/quick-stats
// @desc    Get quick stats for polling (lightweight)
// @access  Employee (admin, manager, super_admin)
router.get(
    '/dashboard/quick-stats',
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    serviceAdminController.getQuickStats
);

module.exports = router;