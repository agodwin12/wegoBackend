// src/routes/backoffice/driverRoutes.js
const express = require('express');
const router = express.Router();
const driverController = require('../../controllers/backoffice/driverController');
const {
    authenticateEmployee,
    requireEmployeeRole
} = require('../../middleware/employeeAuth.middleware');
const { uploadDocuments } = require('../../middleware/upload');

// ═══════════════════════════════════════════════════════════════════════
// MIDDLEWARE - All routes require employee authentication
// ═══════════════════════════════════════════════════════════════════════
router.use(authenticateEmployee);

// ═══════════════════════════════════════════════════════════════════════
// DRIVER ROUTES
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   GET /api/backoffice/drivers/stats
 * @desc    Get driver statistics
 * @access  Private (super_admin, admin, support, operations)
 */
router.get('/stats', driverController.getDriverStats);

/**
 * @route   GET /api/backoffice/drivers
 * @desc    Get all drivers with pagination and filters
 * @access  Private (super_admin, admin, support, operations)
 * @query   page, limit, search, status, verification_state, sortBy, sortOrder
 */
router.get('/', driverController.getAllDrivers);

/**
 * @route   POST /api/backoffice/drivers
 * @desc    Create (onboard) a ride-hailing driver
 * @access  Private (super_admin, admin, manager)
 */
router.post(
    '/',
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    uploadDocuments.fields([
        { name: 'avatar',        maxCount: 1 },   // profile picture
        { name: 'license',       maxCount: 1 },
        { name: 'insurance',     maxCount: 1 },
        { name: 'vehicle_photo', maxCount: 1 },
    ]),
    driverController.createDriver
);

/**
 * @route   GET /api/backoffice/drivers/:id
 * @desc    Get single driver by UUID with complete profile
 * @access  Private (super_admin, admin, support, operations)
 */
router.get('/:id', driverController.getDriverById);

/**
 * @route   GET /api/backoffice/drivers/:id/trips
 * @desc    Get driver trip history
 * @access  Private (super_admin, admin, support, operations)
 * @query   page, limit, status
 */
router.get('/:id/trips', driverController.getDriverTrips);

/**
 * @route   PATCH /api/backoffice/drivers/:id/approve
 * @desc    Approve/Activate a driver (PENDING → ACTIVE)
 * @access  Private (super_admin, admin)
 */
router.patch(
    '/:id/approve',
    requireEmployeeRole('super_admin', 'admin', 'support'),
    driverController.approveDriver
);

/**
 * @route   PATCH /api/backoffice/drivers/:id/reject
 * @desc    Reject driver verification
 * @access  Private (super_admin, admin)
 */
router.patch(
    '/:id/reject',
    requireEmployeeRole('super_admin', 'admin'),
    driverController.rejectDriver
);

/**
 * @route   PATCH /api/backoffice/drivers/:id/block
 * @desc    Block a driver (suspend account)
 * @access  Private (super_admin, admin)
 */
router.patch(
    '/:id/block',
    requireEmployeeRole('super_admin', 'admin'),
    driverController.blockDriver
);

/**
 * @route   PATCH /api/backoffice/drivers/:id/unblock
 * @desc    Unblock a driver
 * @access  Private (super_admin, admin)
 */
router.patch(
    '/:id/unblock',
    requireEmployeeRole('super_admin', 'admin'),
    driverController.unblockDriver
);

/**
 * @route   DELETE /api/backoffice/drivers/:id
 * @desc    Delete a driver (soft delete)
 * @access  Private (super_admin)
 */
router.delete(
    '/:id',
    requireEmployeeRole('super_admin'),
    driverController.deleteDriver
);

module.exports = router;