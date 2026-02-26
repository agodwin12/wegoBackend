// src/routes/backoffice/passengerRoutes.js
const express = require('express');
const router = express.Router();
const passengerController = require('../../controllers/backoffice/passengerController');
const {
    authenticateEmployee,
    requireEmployeeRole
} = require('../../middleware/employeeAuth.middleware');

// ═══════════════════════════════════════════════════════════════════════
// MIDDLEWARE - All routes require employee authentication
// ═══════════════════════════════════════════════════════════════════════
router.use(authenticateEmployee);

// ═══════════════════════════════════════════════════════════════════════
// PASSENGER ROUTES
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   GET /api/backoffice/passengers/stats
 * @desc    Get passenger statistics
 * @access  Private (super_admin, admin, support, operations)
 */
router.get('/stats', passengerController.getPassengerStats);

/**
 * @route   GET /api/backoffice/passengers
 * @desc    Get all passengers with pagination and filters
 * @access  Private (super_admin, admin, support, operations)
 * @query   page, limit, search, status, sortBy, sortOrder
 */
router.get('/', passengerController.getAllPassengers);

/**
 * @route   GET /api/backoffice/passengers/:id
 * @desc    Get single passenger by UUID
 * @access  Private (super_admin, admin, support, operations)
 */
router.get('/:id', passengerController.getPassengerById);

/**
 * @route   GET /api/backoffice/passengers/:id/trips
 * @desc    Get passenger trip history
 * @access  Private (super_admin, admin, support, operations)
 * @query   page, limit, status
 */
router.get('/:id/trips', passengerController.getPassengerTrips);

/**
 * @route   PATCH /api/backoffice/passengers/:id/block
 * @desc    Block a passenger
 * @access  Private (super_admin, admin)
 */
router.patch(
    '/:id/block',
    requireEmployeeRole('super_admin', 'admin'),
    passengerController.blockPassenger
);

/**
 * @route   PATCH /api/backoffice/passengers/:id/unblock
 * @desc    Unblock a passenger
 * @access  Private (super_admin, admin)
 */
router.patch(
    '/:id/unblock',
    requireEmployeeRole('super_admin', 'admin'),
    passengerController.unblockPassenger
);

/**
 * @route   DELETE /api/backoffice/passengers/:id
 * @desc    Delete a passenger (soft delete)
 * @access  Private (super_admin)
 */
router.delete(
    '/:id',
    requireEmployeeRole('super_admin'),
    passengerController.deletePassenger
);

module.exports = router;