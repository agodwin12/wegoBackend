// src/routes/rentalRoutes.js
const express = require('express');
const router = express.Router();
const {
    createVehicle,
    listAvailableVehicles,
    updateVehicleAvailability,
    calculatePrice,
    createRental,
    getRentalById,
    listUserRentals,
    cancelRentalByUser,
    updatePayment,
    listAllRentals,
    cancelRental,
    completeRental,
    listCategories
} = require('../controllers/rental/RentalController');

// Import multer upload middleware
const { uploadVehicle } = require('../middleware/upload');

// Auth middleware — passenger/driver session auth and backoffice employee auth
const { authenticate } = require('../middleware/auth.middleware');
const { authenticateEmployee } = require('../middleware/employeeAuth.middleware');

/**
 * =====================================================
 * VEHICLE MANAGEMENT ROUTES (ADMIN/EMPLOYEE)
 * =====================================================
 */

/**
 * @route   POST /api/rentals/vehicles
 * @desc    Employee posts a new vehicle for rental with images
 * @access  Public (for testing)
 * @upload  Multiple images (up to 10)
 */
router.post('/vehicles', uploadVehicle.array('images', 10), createVehicle);

/**
 * @route   PATCH /api/rentals/vehicles/:id/availability
 * @desc    Update vehicle availability status
 * @access  Public (for testing)
 */
router.patch('/vehicles/:id/availability', updateVehicleAvailability);

/**
 * =====================================================
 * PUBLIC ROUTES
 * =====================================================
 */

/**
 * @route   GET /api/rentals/vehicles/available
 * @desc    Get all available vehicles for rent (with optional filters)
 * @access  Public
 * @query   region, categoryId, minPrice, maxPrice, seats
 */
router.get('/vehicles/available', listAvailableVehicles);

/**
 * @route   GET /api/rentals/categories
 * @desc    Get all vehicle categories
 * @access  Public
 */
router.get('/categories', listCategories);

/**
 * @route   GET /api/rentals/calculate-price
 * @desc    Calculate rental price before booking
 * @access  Public
 * @query   vehicleId, rentalType, startDate, endDate
 * @example /api/rentals/calculate-price?vehicleId=xxx&rentalType=DAY&startDate=2024-01-01T10:00:00Z&endDate=2024-01-05T10:00:00Z
 */
router.get('/calculate-price', calculatePrice);

/**
 * =====================================================
 * RENTAL BOOKING ROUTES (USER)
 * =====================================================
 */

/**
 * @route   POST /api/rentals
 * @desc    Create a new rental booking (passenger) - Status: PENDING
 * @access  Private (authenticated passenger) — identity taken from req.user, not body
 * @body    { vehicleId, rentalRegion, rentalType, startDate, endDate, userNotes? }
 */
router.post('/', authenticate, createRental);

/**
 * @route   GET /api/rentals/user/:userId
 * @desc    Get rental history for the authenticated user (the :userId param is
 *          ignored — identity comes from req.user, so callers cannot list
 *          another user's rentals)
 * @access  Private (authenticated user)
 */
router.get('/user/:userId', authenticate, listUserRentals);

/**
 * @route   GET /api/rentals/all
 * @desc    Get all rental requests (Admin/Employee view)
 * @access  Private (backoffice employee only)
 * @query   status, paymentStatus
 * @note    Must be registered before GET /:id — otherwise Express matches
 *          /api/rentals/all against the generic '/:id' route (id='all')
 *          first, and this route (and its authenticateEmployee gate) never runs.
 */
router.get('/all', authenticateEmployee, listAllRentals);

/**
 * @route   GET /api/rentals/:id
 * @desc    Get single rental details. Ownership-checked: only the renter may
 *          view their own rental (returns 404 — not 403 — if it belongs to
 *          someone else, so existence isn't leaked).
 * @access  Private (authenticated user, owner-only)
 */
router.get('/:id', authenticate, getRentalById);

/**
 * @route   PATCH /api/rentals/:id/cancel-by-user
 * @desc    User cancels their rental (24-hour policy). Ownership-checked.
 * @access  Private (authenticated user, owner-only)
 * @body    { reason: "..." }
 */
router.patch('/:id/cancel-by-user', authenticate, cancelRentalByUser);

/**
 * @route   PATCH /api/rentals/:id/payment
 * @desc    Update payment details (on pickup)
 * @access  Private (authenticated user)
 * @body    { paymentMethod: "orange_money"|"mtn_momo"|"cash", transactionRef?: "..." }
 */
router.patch('/:id/payment', authenticate, updatePayment);

/**
 * =====================================================
 * ADMIN/EMPLOYEE RENTAL MANAGEMENT ROUTES
 * =====================================================
 */

/**
 * @route   PATCH /api/rentals/:id/complete
 * @desc    Mark a rental as completed
 * @access  Private (backoffice employee only)
 */
router.patch('/:id/complete', authenticateEmployee, completeRental);

/**
 * @route   DELETE /api/rentals/:id
 * @desc    Admin/Employee cancels a rental
 * @access  Private (backoffice employee only)
 */
router.delete('/:id', authenticateEmployee, cancelRental);

module.exports = router;