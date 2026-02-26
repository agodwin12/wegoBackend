// backend/src/routes/backoffice/servicePaymentAdmin.routes.js
// Routes for Service Payment Admin Management

const express = require('express');
const router = express.Router();
const servicePaymentAdminController = require('../../controllers/backoffice/servicePaymentAdmin.controller');
const { authenticateEmployee, requireEmployeeRole } = require('../../middleware/employeeAuth.middleware');

// ═══════════════════════════════════════════════════════════════════════
// ALL ROUTES REQUIRE EMPLOYEE AUTHENTICATION
// ═══════════════════════════════════════════════════════════════════════

router.use(authenticateEmployee);

// ═══════════════════════════════════════════════════════════════════════
// PAYMENT MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════

// @route   GET /api/services/admin/payments/stats
// @desc    Get payment statistics
// @access  Employee (admin, manager, super_admin)
router.get(
    '/stats',
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    servicePaymentAdminController.getPaymentStats
);

// @route   POST /api/services/admin/payments/:id/confirm
// @desc    Manually confirm payment (admin override)
// @access  Employee (admin, super_admin)
router.post(
    '/:id/confirm',
    requireEmployeeRole('super_admin', 'admin'),
    servicePaymentAdminController.confirmPaymentManually
);

// @route   POST /api/services/admin/payments/:id/dispute
// @desc    Mark payment as disputed
// @access  Employee (admin, super_admin)
router.post(
    '/:id/dispute',
    requireEmployeeRole('super_admin', 'admin'),
    servicePaymentAdminController.markPaymentAsDisputed
);

// @route   GET /api/services/admin/payments/:id
// @desc    Get payment details by ID
// @access  Employee (admin, manager, super_admin)
router.get(
    '/:id',
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    servicePaymentAdminController.getPaymentById
);

// @route   GET /api/services/admin/payments
// @desc    Get all payments with filters
// @access  Employee (admin, manager, super_admin)
router.get(
    '/',
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    servicePaymentAdminController.getAllPayments
);

module.exports = router;