// wegobackend/src/routes/backoffice/vehicleRoutes.js

const express = require('express');
const router = express.Router();
const vehicleController = require('../../controllers/backoffice/vehicleController');
const { authenticateEmployee } = require('../../middleware/employeeAuth.middleware');

// ═══════════════════════════════════════════════════════════════════════
// ALL ROUTES REQUIRE EMPLOYEE AUTHENTICATION
// ═══════════════════════════════════════════════════════════════════════

router.use(authenticateEmployee);

// ═══════════════════════════════════════════════════════════════════════
// CATEGORY ROUTES
// ═══════════════════════════════════════════════════════════════════════

// Get all categories
router.get('/categories', vehicleController.getCategories);

// ═══════════════════════════════════════════════════════════════════════
// VEHICLE CRUD ROUTES
// ═══════════════════════════════════════════════════════════════════════

// Create vehicle
router.post('/', vehicleController.createVehicle);

// Get all vehicles (with filters, pagination, search)
router.get('/', vehicleController.getAllVehicles);

// Get vehicle stats
router.get('/stats', vehicleController.getVehicleStats);

// Get single vehicle by ID
router.get('/:id', vehicleController.getVehicleById);

// Update vehicle
router.put('/:id', vehicleController.updateVehicle);

// Delete vehicle
router.delete('/:id', vehicleController.deleteVehicle);

// ═══════════════════════════════════════════════════════════════════════
// VEHICLE STATUS ROUTES
// ═══════════════════════════════════════════════════════════════════════

// Verify vehicle
router.post('/:id/verify', vehicleController.verifyVehicle);

// Unverify vehicle
router.post('/:id/unverify', vehicleController.unverifyVehicle);

// Block vehicle
router.post('/:id/block', vehicleController.blockVehicle);

// Unblock vehicle
router.post('/:id/unblock', vehicleController.unblockVehicle);

module.exports = router;