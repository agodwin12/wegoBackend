// backend/src/routes/backoffice/serviceDisputeAdmin.routes.js

const express = require('express');
const router = express.Router();

// ═══════════════════════════════════════════════════════════════════════
// MIDDLEWARE IMPORTS
// ═══════════════════════════════════════════════════════════════════════

const {
    authenticateEmployee,
    requireEmployeeRole
} = require('../../middleware/employeeAuth.middleware');

// ═══════════════════════════════════════════════════════════════════════
// CONTROLLER IMPORTS
// ═══════════════════════════════════════════════════════════════════════

const {
    getAllDisputes,
    getDisputeDetails,
    assignDispute,
    updateDisputeStatus,
    resolveDispute,
    addAdminNote,
    getDisputeStats,
} = require('../../controllers/backoffice/serviceDisputeAdmin.controller');

// ═══════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   GET /api/services/admin/disputes/stats
 * @desc    Get dispute statistics and metrics
 * @access  Employee Only (all roles)
 */
router.get(
    '/stats',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager', 'support'),
    getDisputeStats
);

/**
 * @route   GET /api/services/admin/disputes
 * @desc    Get all disputes with filters and pagination
 * @access  Employee Only (all roles)
 * @query   status (open|investigating|resolved|closed)
 * @query   dispute_type (service_not_provided|quality_issue|payment_issue|behavior|fraud|other)
 * @query   priority (low|medium|high|urgent)
 * @query   assigned_to (employee_id or 'unassigned')
 * @query   search (search in dispute_id, issue_description)
 * @query   page (default: 1)
 * @query   limit (default: 20)
 * @query   sort_by (default: created_at)
 * @query   sort_order (ASC|DESC, default: DESC)
 */
router.get(
    '/',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager', 'support'),
    getAllDisputes
);

/**
 * @route   GET /api/services/admin/disputes/:dispute_id
 * @desc    Get single dispute details with full information
 * @access  Employee Only (all roles)
 */
router.get(
    '/:dispute_id',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager', 'support'),
    getDisputeDetails
);

/**
 * @route   PUT /api/services/admin/disputes/:dispute_id/assign
 * @desc    Assign dispute to an employee (or self)
 * @access  Employee Only (super_admin, admin, manager, support)
 * @body    employee_id (optional - if not provided, assigns to self)
 */
router.put(
    '/:dispute_id/assign',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager', 'support'),
    assignDispute
);

/**
 * @route   PUT /api/services/admin/disputes/:dispute_id/status
 * @desc    Update dispute status
 * @access  Employee Only (super_admin, admin, manager, support)
 * @body    status (open|investigating|resolved|closed)
 * @body    admin_notes (optional)
 */
router.put(
    '/:dispute_id/status',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager', 'support'),
    updateDisputeStatus
);

/**
 * @route   POST /api/services/admin/disputes/:dispute_id/resolve
 * @desc    Resolve a dispute with resolution details
 * @access  Employee Only (super_admin, admin, manager)
 * @body    resolution_type (full_refund|partial_refund|no_refund|mutual_agreement|provider_warned|customer_warned|provider_suspended|customer_suspended|other)
 * @body    resolution_notes (required, min 20 chars)
 * @body    refund_amount (required for refund types)
 * @body    action_taken (optional)
 */
router.post(
    '/:dispute_id/resolve',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    resolveDispute
);

/**
 * @route   POST /api/services/admin/disputes/:dispute_id/notes
 * @desc    Add admin note to dispute
 * @access  Employee Only (all roles)
 * @body    note (required, min 10 chars)
 */
router.post(
    '/:dispute_id/notes',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager', 'support'),
    addAdminNote
);

// ═══════════════════════════════════════════════════════════════════════
// EXPORT ROUTER
// ═══════════════════════════════════════════════════════════════════════

module.exports = router;