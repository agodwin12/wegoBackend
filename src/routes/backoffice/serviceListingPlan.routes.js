// routes/backoffice/serviceListingPlan.routes.js
// Backoffice routes for managing listing plan tiers (pricing table)

'use strict';

const express = require('express');
const router  = express.Router();

const ctrl = require('../../controllers/serviceListingPlan_controller');

const { authenticateEmployee,
    requireEmployeeRole } = require('../../middleware/employeeAuth.middleware');

// All routes in this file are backoffice-only.
// Apply employee authentication globally to this router.
router.use(authenticateEmployee);

// ═══════════════════════════════════════════════════════════════════════════════
// READ — available to all authenticated employees (for viewing plan config)
// ═══════════════════════════════════════════════════════════════════════════════

// @route   GET /api/services/admin/plans
// @desc    Get all plans including inactive — with usage counts
// @access  Employee (any role)
router.get('/', ctrl.getAllPlans);

// @route   GET /api/services/admin/plans/:id
// @desc    Get single plan with activation stats (total activations, active now)
// @access  Employee (any role)
router.get('/:id', ctrl.getPlanById);

// ═══════════════════════════════════════════════════════════════════════════════
// WRITE — admin and super_admin only
// ═══════════════════════════════════════════════════════════════════════════════

// @route   POST /api/services/admin/plans
// @desc    Create a new listing plan tier
//          Body: { plan_key, label_en, label_fr, price_xaf, duration_days,
//                  max_photos, is_hero_placement, requires_admin_approval,
//                  boost_priority, is_highlighted, highlight_label_en,
//                  highlight_label_fr, display_order, description_en, description_fr }
// @access  Employee (admin, super_admin)
router.post(
    '/',
    requireEmployeeRole('super_admin', 'admin'),
    ctrl.createPlan
);

// @route   PUT /api/services/admin/plans/:id
// @desc    Update a plan (plan_key is immutable)
// @access  Employee (admin, super_admin)
router.put(
    '/:id',
    requireEmployeeRole('super_admin', 'admin'),
    ctrl.updatePlan
);

// @route   PATCH /api/services/admin/plans/:id/toggle
// @desc    Activate or deactivate a plan
//          Body: { is_active: true | false }
//          Deactivated plans hidden from Flutter but existing subscriptions honored
// @access  Employee (admin, super_admin)
router.patch(
    '/:id/toggle',
    requireEmployeeRole('super_admin', 'admin'),
    ctrl.togglePlanStatus
);

// @route   DELETE /api/services/admin/plans/:id
// @desc    Hard delete a plan (blocked if any payments reference it)
//          Use PATCH toggle to deactivate instead
// @access  Employee (super_admin only)
router.delete(
    '/:id',
    requireEmployeeRole('super_admin'),
    ctrl.deletePlan
);

module.exports = router;