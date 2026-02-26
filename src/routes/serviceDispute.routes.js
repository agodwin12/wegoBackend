// backend/src/routes/serviceDispute.routes.js
// Service Dispute & Resolution Routes - WITH VALIDATION

const express = require('express');
const router = express.Router();
const serviceDisputeController = require('../controllers/serviceDispute.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const { authenticateEmployee, requireEmployeeRole } = require('../middleware/employeeAuth.middleware');
const { upload } = require('../middleware/upload');
const validate = require('../middleware/validate'); // ✅ IMPORT VALIDATE MIDDLEWARE
const schemas = require('../validators/servicesMarketplace.validator'); // ✅ IMPORT SCHEMAS

// ═══════════════════════════════════════════════════════════════════════
// CUSTOMER/PROVIDER ROUTES (Authentication required)
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   POST /api/services/disputes
 * @desc    File a dispute (Customer or Provider)
 * @access  Private (Customer/Provider)
 */
router.post(
    '/',
    authenticateToken,
    upload.array('evidence_photos', 5),
    validate(schemas.fileDispute),
    serviceDisputeController.fileDispute
);

/**
 * @route   GET /api/services/disputes/my-disputes
 * @desc    Get user's disputes (filed or against them)
 * @access  Private (Customer/Provider)
 */
router.get(
    '/my-disputes',
    authenticateToken,
    validate(schemas.getDisputes),
    serviceDisputeController.getMyDisputes
);

/**
 * @route   GET /api/services/disputes/:id
 * @desc    Get dispute by ID (full details)
 * @access  Private (Customer/Provider involved in dispute)
 */
router.get('/:id', authenticateToken, serviceDisputeController.getDisputeById);

/**
 * @route   POST /api/services/disputes/:id/respond
 * @desc    Respond to dispute (Defendant only)
 * @access  Private (Defendant - Customer/Provider)
 */
router.post(
    '/:id/respond',
    authenticateToken,
    upload.array('response_evidence', 5),
    validate(schemas.respondToDispute),
    serviceDisputeController.respondToDispute
);

// ═══════════════════════════════════════════════════════════════════════
// ADMIN ROUTES (Super Admin, Admin, Manager ONLY)
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   GET /api/admin/services/disputes/stats
 * @desc    Get dispute statistics for dashboard
 * @access  Private (Super Admin, Admin, Manager)
 */
router.get(
    '/admin/stats',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    serviceDisputeController.getDisputeStats
);

/**
 * @route   GET /api/admin/services/disputes/by-type
 * @desc    Get disputes breakdown by type
 * @access  Private (Super Admin, Admin, Manager)
 */
router.get(
    '/admin/by-type',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    serviceDisputeController.getDisputesByType
);

/**
 * @route   GET /api/admin/services/disputes/my-assigned
 * @desc    Get disputes assigned to current employee
 * @access  Private (Super Admin, Admin, Manager)
 */
router.get(
    '/admin/my-assigned',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    validate(schemas.getDisputes),
    serviceDisputeController.getMyAssignedDisputes
);

/**
 * @route   GET /api/admin/services/disputes/all
 * @desc    Get all disputes with filters
 * @access  Private (Super Admin, Admin, Manager)
 */
router.get(
    '/admin/all',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    validate(schemas.getDisputes),
    serviceDisputeController.getAllDisputesAdmin
);

/**
 * @route   GET /api/admin/services/disputes/:id
 * @desc    Get dispute by ID (admin view - full details)
 * @access  Private (Super Admin, Admin, Manager)
 */
router.get(
    '/admin/:id',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    serviceDisputeController.getDisputeById
);

/**
 * @route   POST /api/admin/services/disputes/:id/assign
 * @desc    Assign dispute to employee
 * @access  Private (Super Admin, Admin, Manager)
 */
router.post(
    '/admin/:id/assign',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    validate(schemas.assignDispute),
    serviceDisputeController.assignDispute
);

/**
 * @route   POST /api/admin/services/disputes/:id/notes
 * @desc    Add investigation notes to dispute
 * @access  Private (Super Admin, Admin, Manager)
 */
router.post(
    '/admin/:id/notes',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    validate(schemas.addInvestigationNotes),
    serviceDisputeController.addInvestigationNotes
);

/**
 * @route   POST /api/admin/services/disputes/:id/resolve
 * @desc    Resolve dispute with decision
 * @access  Private (Super Admin, Admin, Manager)
 */
router.post(
    '/admin/:id/resolve',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    validate(schemas.resolveDispute),
    serviceDisputeController.resolveDispute
);

/**
 * @route   POST /api/admin/services/disputes/:id/close
 * @desc    Close resolved dispute
 * @access  Private (Super Admin, Admin, Manager)
 */
router.post(
    '/admin/:id/close',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    validate(schemas.closeDispute),
    serviceDisputeController.closeDispute
);

/**
 * @route   POST /api/admin/services/disputes/:id/escalate
 * @desc    Escalate dispute to higher authority
 * @access  Private (Super Admin, Admin, Manager)
 */
router.post(
    '/admin/:id/escalate',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    validate(schemas.escalateDispute),
    serviceDisputeController.escalateDispute
);

/**
 * @route   PATCH /api/admin/services/disputes/:id/priority
 * @desc    Update dispute priority
 * @access  Private (Super Admin, Admin, Manager)
 */
router.patch(
    '/admin/:id/priority',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    validate(schemas.updateDisputePriority),
    serviceDisputeController.updateDisputePriority
);

/**
 * @route   PATCH /api/admin/services/disputes/:id/status
 * @desc    Change dispute status manually
 * @access  Private (Super Admin, Admin, Manager)
 */
router.patch(
    '/admin/:id/status',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    validate(schemas.changeDisputeStatus),
    serviceDisputeController.changeDisputeStatus
);

module.exports = router;