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
const {
    authenticateEmployee,
    requireEmployeeRole,
    canModifyEmployee,
} = require("../../middleware/employeeAuth.middleware");

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
// Only super_admin may create employee accounts (creation includes assigning a role,
// so this must never be reachable by a lower-privileged, self-promoting caller).
router.post(
    "/",
    authenticateEmployee,
    requireEmployeeRole("super_admin"),
    uploadProfile.single("profile_photo"),
    createEmployee
);

// Update employee (with profile photo upload)
// canModifyEmployee: only super_admin/admin may update employee records through this
// admin-management endpoint, and non-super-admins cannot use it to modify themselves
// (self-service profile edits go through employeeProfile.routes.js instead).
// Role-field-specific restrictions (no self role change, only super_admin sets roles)
// are additionally enforced inside updateEmployee itself.
router.patch(
    "/:id",
    authenticateEmployee,
    canModifyEmployee,
    uploadProfile.single("profile_photo"),
    updateEmployee
);

// Update employee password
// This is an admin-side FORCE password reset: it overwrites the target's password
// without requiring knowledge of their current password (unlike the self-service
// change-password endpoint in employeeProfile.controller.js, which bcrypt-verifies
// current_password first). It must carry the same privilege bar as the other
// sensitive employee-management actions in this file, otherwise any authenticated
// employee could reset a super_admin's password and take over their account without
// ever touching the 'role' field.
router.patch(
    "/:id/password",
    authenticateEmployee,
    requireEmployeeRole("super_admin"),
    updatePassword
);

// Block employee
router.patch("/:id/block", authenticateEmployee, requireEmployeeRole("super_admin"), blockEmployee);

// Unblock employee
router.patch("/:id/unblock", authenticateEmployee, requireEmployeeRole("super_admin"), unblockEmployee);

// Delete employee (soft delete)
router.delete("/:id", authenticateEmployee, requireEmployeeRole("super_admin"), deleteEmployee);

// Restore deleted employee
router.post("/:id/restore", authenticateEmployee, requireEmployeeRole("super_admin"), restoreEmployee);

module.exports = router;