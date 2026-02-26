// backend/src/routes/backoffice/serviceRequestAdmin.routes.js
// Routes for Service Request Admin Management

const express = require('express');
const router = express.Router();
const serviceRequestAdminController = require('../../controllers/backoffice/serviceRequestAdmin');
const { authenticateEmployee, requireEmployeeRole } = require('../../middleware/employeeAuth.middleware');

// ═══════════════════════════════════════════════════════════════════════
// ALL ROUTES REQUIRE EMPLOYEE AUTHENTICATION
// ═══════════════════════════════════════════════════════════════════════

router.use(authenticateEmployee);

// ═══════════════════════════════════════════════════════════════════════
// SERVICE REQUEST MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════

// @route   GET /api/services/admin/requests/stats
// @desc    Get service request statistics
// @access  Employee (admin, manager, super_admin)
router.get(
    '/stats',
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    serviceRequestAdminController.getRequestStatsAdmin
);

// @route   GET /api/services/admin/requests/by-status
// @desc    Get requests grouped by status
// @access  Employee (admin, manager, super_admin)
router.get(
    '/by-status',
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    serviceRequestAdminController.getRequestsByStatus
);

// @route   POST /api/services/admin/requests/:id/cancel
// @desc    Cancel a service request (admin override)
// @access  Employee (admin, super_admin)
router.post(
    '/:id/cancel',
    requireEmployeeRole('super_admin', 'admin'),
    serviceRequestAdminController.cancelRequestAdmin
);

// @route   GET /api/services/admin/requests/:id
// @desc    Get request details by ID
// @access  Employee (admin, manager, super_admin)
router.get(
    '/:id',
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    serviceRequestAdminController.getRequestByIdAdmin
);

// @route   GET /api/services/admin/requests
// @desc    Get all service requests with filters
// @access  Employee (admin, manager, super_admin)
router.get(
    '/',
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    serviceRequestAdminController.getAllRequests
);

module.exports = router;