// backend/src/routes/backoffice/serviceAdmin.routes.js
// Routes for Service Admin Dashboard

const express = require('express');
const router = express.Router();
const serviceAdminController = require('../../controllers/backoffice/serviceAdmin.controller');
const topupTraceController = require('../../controllers/backoffice/topupTrace.controller');
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

// @route   GET /api/services/admin/ad-payments
// @desc    List all ad (plan) payments — Plan Sales backoffice page
// @access  Employee (admin, manager, super_admin, accountant)
router.get(
    '/ad-payments',
    requireEmployeeRole('super_admin', 'admin', 'manager', 'accountant'),
    serviceAdminController.getAdminAdPayments
);

// ═══════════════════════════════════════════════════════════════════════
// PROVIDER SUBSCRIPTIONS
// ═══════════════════════════════════════════════════════════════════════

// @route   GET /api/services/admin/subscriptions
// @desc    List provider subscriptions + KPIs + combined ad revenue
router.get(
    '/subscriptions',
    requireEmployeeRole('super_admin', 'admin', 'manager', 'accountant'),
    serviceAdminController.getSubscriptions
);

// @route   POST /api/services/admin/subscriptions/:id/cancel
router.post(
    '/subscriptions/:id/cancel',
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    serviceAdminController.cancelSubscription
);

// @route   POST /api/services/admin/subscriptions/:id/extend
router.post(
    '/subscriptions/:id/extend',
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    serviceAdminController.extendSubscription
);

// ═══════════════════════════════════════════════════════════════════════
// PLATFORM TOP-UP TRACE (drivers + delivery agents)
// ═══════════════════════════════════════════════════════════════════════

// @route   GET /api/services/admin/topups
// @desc    Unified trace of every wallet top-up (ride drivers + delivery agents):
//          who, role, amount, method, charged number, CamPay reference, operator,
//          status, date. Filters: source, status, search, page, limit.
// @access  Employee (super_admin, admin, manager, accountant)
router.get(
    '/topups',
    requireEmployeeRole('super_admin', 'admin', 'manager', 'accountant'),
    topupTraceController.getAllTopups
);

module.exports = router;