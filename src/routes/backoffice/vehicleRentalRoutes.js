// wegobackend/src/routes/backoffice/vehicleRentalRoutes.js

const express = require('express');
const router = express.Router();
const vehicleRentalController = require('../../controllers/backoffice/vehicleRentalController');
const { authenticateEmployee } = require('../../middleware/employeeAuth.middleware');

router.use(authenticateEmployee);

// Get rental statistics
router.get('/stats', vehicleRentalController.getRentalStats);

// Get all rentals (with filters)
router.get('/', vehicleRentalController.getAllRentals);

// Get single rental by ID
router.get('/:id', vehicleRentalController.getRentalById);

// Update rental status
router.patch('/:id/status', vehicleRentalController.updateRentalStatus);

// Update payment status
router.patch('/:id/payment', vehicleRentalController.updatePaymentStatus);

// ✅ NEW: Add admin notes
router.patch('/:id/notes', vehicleRentalController.addNotes);

// ✅ NEW: Delete rental
router.delete('/:id', vehicleRentalController.deleteRental);

module.exports = router;