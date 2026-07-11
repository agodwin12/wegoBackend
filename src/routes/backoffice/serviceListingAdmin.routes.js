// backend/src/routes/backoffice/serviceListingAdmin.routes.js
// Routes for Service Listing Admin Management (Moderation)

const express = require('express');
const router = express.Router();
const serviceListingAdminController = require('../../controllers/backoffice/serviceListingAdmin.controller');
const { authenticateEmployee, requireEmployeeRole } = require('../../middleware/employeeAuth.middleware');

// ═══════════════════════════════════════════════════════════════════════
// ALL ROUTES REQUIRE EMPLOYEE AUTHENTICATION
// ═══════════════════════════════════════════════════════════════════════

router.use(authenticateEmployee);

// ═══════════════════════════════════════════════════════════════════════
// SERVICE LISTING MODERATION
// ═══════════════════════════════════════════════════════════════════════

// @route   GET /api/services/admin/listings
// @desc    Get all listings with pagination and filters
// @access  Employee (admin, manager, super_admin)
// @query   ?page=1&limit=50&status=pending&category=all&sort=oldest&search=
router.get(
    '/',
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    serviceListingAdminController.getAllListings
);

// @route   POST /api/services/admin/listings/:id/approve
// @desc    Approve a pending listing
// @access  Employee (admin, super_admin)
router.post(
    '/:id/approve',
    requireEmployeeRole('super_admin', 'admin'),
    serviceListingAdminController.approveListing
);

// @route   POST /api/services/admin/listings/:id/reject
// @desc    Reject a pending listing
// @access  Employee (admin, super_admin)
// @body    { reason: string }
router.post(
    '/:id/reject',
    requireEmployeeRole('super_admin', 'admin'),
    serviceListingAdminController.rejectListing
);

// @route   PATCH /api/services/admin/listings/:id
// @desc    Edit a listing: hero toggle, boost, status, expiry, content fields
// @access  Employee (admin, super_admin)
// @body    { is_hero?, hero_expires_at?, boost_priority?, status?, plan_expires_at?,
//            title?, description?, city?, pricing_type?, hourly_rate?,
//            minimum_charge?, fixed_price?, emergency_service?, years_experience? }
router.patch(
    '/:id',
    requireEmployeeRole('super_admin', 'admin'),
    serviceListingAdminController.updateListing
);

module.exports = router;