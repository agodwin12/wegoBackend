// backend/routes/backoffice/employeeRoutes.js
// Employee Management Routes

const express = require("express");
const router = express.Router();
const {
    createEmployee,
    getAllEmployees,
    getEmployeeById,
    updateEmployee,
    updatePassword,
    blockEmployee,
    unblockEmployee,
    deleteEmployee,
    restoreEmployee,
    getEmployeeStats,
} = require("../../controllers/backoffice/employeeController");
const { uploadProfile } = require("../../middleware/upload");
const { authenticateEmployee } = require("../../middleware/employeeAuth.middleware");

/* ================================
   EMPLOYEE MANAGEMENT ROUTES
================================= */

// Get employee statistics (for dashboard)
router.get("/stats", authenticateEmployee, getEmployeeStats);

// Get all employees (with pagination, search, filter)
router.get("/", authenticateEmployee, getAllEmployees);

// Get single employee by ID
router.get("/:id", authenticateEmployee, getEmployeeById);

// Create new employee (with profile photo upload)
router.post(
    "/",
    authenticateEmployee,
    uploadProfile.single("profile_photo"),
    createEmployee
);

// Update employee (with profile photo upload)
router.patch(
    "/:id",
    authenticateEmployee,
    uploadProfile.single("profile_photo"),
    updateEmployee
);

// Update employee password
router.patch("/:id/password", authenticateEmployee, updatePassword);

// Block employee
router.patch("/:id/block", authenticateEmployee, blockEmployee);

// Unblock employee
router.patch("/:id/unblock", authenticateEmployee, unblockEmployee);

// Delete employee (soft delete)
router.delete("/:id", authenticateEmployee, deleteEmployee);

// Restore deleted employee
router.post("/:id/restore", authenticateEmployee, restoreEmployee);

module.exports = router;