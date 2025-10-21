// src/routes/rentalRoutes.js
const express = require('express');
const router = express.Router();
const {
    createVehicle,
    listAvailableVehicles,
    createRental,
    cancelRental,
    listUserRentals,
    listAllRentals,
    updateContactStatus,
    completeRental,
    updateVehicleAvailability,
    listCategories
} = require('../controllers/rental/RentalController');

// Import multer upload middleware
const { uploadVehicle } = require('../middleware/upload');

/**
 * =====================================================
 * VEHICLE MANAGEMENT ROUTES
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
 * @query   region, categoryId
 */
router.get('/vehicles/available', listAvailableVehicles);

/**
 * @route   GET /api/rentals/categories
 * @desc    Get all vehicle categories
 * @access  Public
 */
router.get('/categories', listCategories);

/**
 * =====================================================
 * RENTAL BOOKING ROUTES
 * =====================================================
 */

/**
 * @route   POST /api/rentals
 * @desc    Create a new rental booking (passenger)
 * @access  Public (for testing)
 */
router.post('/', createRental);

/**
 * @route   GET /api/rentals/user/:userId
 * @desc    Get rental history for a specific user
 * @access  Public (for testing)
 */
router.get('/user/:userId', listUserRentals);

/**
 * @route   GET /api/rentals/all
 * @desc    Get all rental requests (Admin/Employee view)
 * @access  Public (for testing)
 * @query   status, contactStatus
 */
router.get('/all', listAllRentals);

/**
 * =====================================================
 * RENTAL MANAGEMENT ROUTES
 * =====================================================
 */

/**
 * @route   PATCH /api/rentals/:id/contact-status
 * @desc    Update contact status of a rental
 * @access  Public (for testing)
 */
router.patch('/:id/contact-status', updateContactStatus);

/**
 * @route   PATCH /api/rentals/:id/complete
 * @desc    Mark a rental as completed
 * @access  Public (for testing)
 */
router.patch('/:id/complete', completeRental);

/**
 * @route   DELETE /api/rentals/:id
 * @desc    Cancel a rental
 * @access  Public (for testing)
 */
router.delete('/:id', cancelRental);

module.exports = router;