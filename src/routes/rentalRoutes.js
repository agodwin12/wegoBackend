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
 * @access  Public (for testing)
 * @body    { userId, vehicleId, rentalRegion, rentalType, startDate, endDate, userNotes? }
 */
router.post('/', createRental);

/**
 * @route   GET /api/rentals/user/:userId
 * @desc    Get rental history for a specific user
 * @access  Public (for testing)
 */
router.get('/user/:userId', listUserRentals);

/**
 * @route   GET /api/rentals/:id
 * @desc    Get single rental details
 * @access  Public (for testing)
 */
router.get('/:id', getRentalById);

/**
 * @route   PATCH /api/rentals/:id/cancel-by-user
 * @desc    User cancels their rental (24-hour policy)
 * @access  Public (for testing)
 * @body    { reason: "..." }
 */
router.patch('/:id/cancel-by-user', cancelRentalByUser);

/**
 * @route   PATCH /api/rentals/:id/payment
 * @desc    Update payment details (on pickup)
 * @access  Public (for testing)
 * @body    { paymentMethod: "orange_money"|"mtn_momo"|"cash", transactionRef?: "..." }
 */
router.patch('/:id/payment', updatePayment);

/**
 * =====================================================
 * ADMIN/EMPLOYEE RENTAL MANAGEMENT ROUTES
 * =====================================================
 */

/**
 * @route   GET /api/rentals/all
 * @desc    Get all rental requests (Admin/Employee view)
 * @access  Public (for testing)
 * @query   status, paymentStatus
 */
router.get('/all', listAllRentals);

/**
 * @route   PATCH /api/rentals/:id/complete
 * @desc    Mark a rental as completed
 * @access  Public (for testing)
 */
router.patch('/:id/complete', completeRental);

/**
 * @route   DELETE /api/rentals/:id
 * @desc    Admin/Employee cancels a rental
 * @access  Public (for testing)
 */
router.delete('/:id', cancelRental);

module.exports = router;