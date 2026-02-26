const express = require('express');
const router = express.Router();
const tripController = require('../../controllers/backoffice/tripController');
const { authenticateEmployee } = require('../../middleware/employeeAuth.middleware');

// @route   GET /api/backoffice/trips/stats
// @desc    Get trip statistics
// @access  Private (Employee)
router.get('/stats', authenticateEmployee, tripController.getTripStats);

// @route   GET /api/backoffice/trips/:id
// @desc    Get single trip details
// @access  Private (Employee)
router.get('/:id', authenticateEmployee, tripController.getTripById);

// @route   GET /api/backoffice/trips
// @desc    Get all trips with filters and pagination
// @access  Private (Employee)
router.get('/', authenticateEmployee, tripController.getAllTrips);

module.exports = router;