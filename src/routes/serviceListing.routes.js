// backend/src/routes/serviceListing.routes.js
// Service Listing Routes - Fixed route ordering

const express = require('express');
const router = express.Router();
const serviceListingController = require('../controllers/serviceListing.controller');
const serviceListingAdminController = require('../controllers/serviceListingAdmin.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const { authenticateEmployee, requireEmployeeRole } = require('../middleware/employeeAuth.middleware');
const { upload } = require('../middleware/upload');
const validate = require('../middleware/validate');
const serviceListingValidator = require('../validators/servicesMarketplace.validator');

// ═══════════════════════════════════════════════════════════════════════
// ADMIN ROUTES (Must be before /:id to avoid param conflicts)
// ═══════════════════════════════════════════════════════════════════════

// @route   GET /api/services/moderation/admin/stats
// @desc    Get moderation statistics
// @access  Employee (super_admin, admin, manager)
router.get(
    '/admin/stats',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    serviceListingAdminController.getModerationStats
);

// @route   GET /api/services/moderation/admin/pending
// @desc    Get pending listings queue
// @access  Employee (super_admin, admin, manager)
router.get(
    '/admin/pending',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    serviceListingAdminController.getPendingListings
);

// @route   GET /api/services/moderation/admin/all
// @desc    Get all listings (all statuses)
// @access  Employee (super_admin, admin, manager)
router.get(
    '/admin/all',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    serviceListingAdminController.getAllListingsAdmin
);

// @route   POST /api/services/moderation/admin/:id/approve
// @desc    Approve a pending listing
// @access  Employee (super_admin, admin, manager)
router.post(
    '/admin/:id/approve',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    serviceListingAdminController.approveListing
);

// @route   POST /api/services/moderation/admin/:id/reject
// @desc    Reject a pending listing
// @access  Employee (super_admin, admin, manager)
router.post(
    '/admin/:id/reject',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    serviceListingAdminController.rejectListing
);

// @route   POST /api/services/moderation/admin/:id/activate
// @desc    Activate an approved listing
// @access  Employee (super_admin, admin, manager)
router.post(
    '/admin/:id/activate',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    serviceListingAdminController.activateListing
);

// @route   POST /api/services/moderation/admin/:id/deactivate
// @desc    Deactivate an active listing
// @access  Employee (super_admin, admin, manager)
router.post(
    '/admin/:id/deactivate',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    serviceListingAdminController.deactivateListing
);

// @route   GET /api/services/moderation/admin/:id
// @desc    Get listing by ID (admin full details)
// @access  Employee (super_admin, admin, manager)
router.get(
    '/admin/:id',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    serviceListingAdminController.getListingByIdAdmin
);

// @route   DELETE /api/services/moderation/admin/:id
// @desc    Permanently delete a listing
// @access  Employee (super_admin, admin, manager)
router.delete(
    '/admin/:id',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    serviceListingAdminController.deleteListingPermanently
);

// ═══════════════════════════════════════════════════════════════════════
// PROVIDER ROUTES (Must be before /:id)
// ═══════════════════════════════════════════════════════════════════════

// @route   GET /api/services/moderation/my/listings
// @desc    Get provider's own listings
// @access  Private (Provider)
router.get(
    '/my/listings',
    authenticateToken,
    serviceListingController.getMyListings
);

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ═══════════════════════════════════════════════════════════════════════

// @route   GET /api/services/moderation
// @desc    Get all active listings (with filters)
// @access  Public
router.get('/', serviceListingController.getAllListings);

// @route   POST /api/services/moderation
// @desc    Create new service listing
// @access  Private (Any authenticated user)
router.post(
    '/',
    authenticateToken,
    upload.array('photos', 5),
    validate(serviceListingValidator.createListing),
    serviceListingController.createListing
);

// ═══════════════════════════════════════════════════════════════════════
// DYNAMIC ROUTES (/:id must always be last)
// ═══════════════════════════════════════════════════════════════════════

// @route   GET /api/services/moderation/:id
// @desc    Get listing by ID (increments view count)
// @access  Public
router.get('/:id', serviceListingController.getListingById);

// @route   PUT /api/services/moderation/:id
// @desc    Update listing (pending or rejected only)
// @access  Private (Provider - own listings only)
router.put(
    '/:id',
    authenticateToken,
    upload.array('photos', 5),
    validate(serviceListingValidator.updateListing),
    serviceListingController.updateListing
);

// @route   DELETE /api/services/moderation/:id
// @desc    Delete listing (soft delete)
// @access  Private (Provider - own listings only)
router.delete('/:id', authenticateToken, serviceListingController.deleteListing);

module.exports = router;