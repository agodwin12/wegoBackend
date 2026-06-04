// backend/src/routes/serviceAdPayment.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// Service Ad Payment Routes
// Listing plan activation — free and paid (via CamPay)
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const express    = require('express');
const router     = express.Router();
const ctrl       = require('../controllers/serviceAdPayment_controller');
const adminCtrl  = require('../controllers/serviceListingPlan_controller');
const { authenticateToken }                        = require('../middleware/auth.middleware');
const { authenticateEmployee, requireEmployeeRole } = require('../middleware/employeeAuth.middleware');

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — plan catalogue
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/services/plans
// Returns all active plans for the Flutter plan picker screen
router.get('/plans', ctrl.getAvailablePlans);


// ─────────────────────────────────────────────────────────────────────────────
// PROVIDER — listing plan activation
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/services/listings/:id/activate-free
// Activates the free plan immediately — no CamPay call
router.post(
    '/listings/:id/activate-free',
    authenticateToken,
    ctrl.activateFreePlan
);

// POST /api/services/listings/:id/initiate-payment
// Initiates a paid plan via CamPay USSD — body: { plan_id, phone }
router.post(
    '/listings/:id/initiate-payment',
    authenticateToken,
    ctrl.initiateAdPayment
);

// GET /api/services/listings/:id/ad-status
// Returns current plan status + days remaining for the listing
router.get(
    '/listings/:id/ad-status',
    authenticateToken,
    ctrl.getAdStatus
);

// GET /api/services/ad-payments/history
// Provider's full ad payment history (paginated)
router.get(
    '/ad-payments/history',
    authenticateToken,
    ctrl.getMyAdPaymentHistory
);


// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — hero placement approval queue
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/services/admin/hero-queue
router.get(
    '/admin/hero-queue',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    ctrl.getHeroQueue
);

// POST /api/services/admin/hero-queue/:id/approve
router.post(
    '/admin/hero-queue/:id/approve',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    ctrl.approveHeroPlacement
);

// POST /api/services/admin/hero-queue/:id/reject
router.post(
    '/admin/hero-queue/:id/reject',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    ctrl.rejectHeroPlacement
);


// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — plan management (CRUD)
// ─────────────────────────────────────────────────────────────────────────────

// GET    /api/services/admin/plans         → all plans including inactive
// POST   /api/services/admin/plans         → create plan
// GET    /api/services/admin/plans/:id     → single plan details
// PUT    /api/services/admin/plans/:id     → update plan
// PATCH  /api/services/admin/plans/:id/toggle → activate / deactivate
// DELETE /api/services/admin/plans/:id    → hard delete (only if no payments)

router.get(
    '/admin/plans',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    adminCtrl.getAllPlans
);

router.post(
    '/admin/plans',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin'),
    adminCtrl.createPlan
);

router.get(
    '/admin/plans/:id',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    adminCtrl.getPlanById
);

router.put(
    '/admin/plans/:id',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin'),
    adminCtrl.updatePlan
);

router.patch(
    '/admin/plans/:id/toggle',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin'),
    adminCtrl.togglePlanStatus
);

router.delete(
    '/admin/plans/:id',
    authenticateEmployee,
    requireEmployeeRole('super_admin'),
    adminCtrl.deletePlan
);


module.exports = router;