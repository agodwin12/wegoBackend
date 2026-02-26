// backend/src/routes/serviceCategory.routes.js
// Routes for Service Categories

const express = require('express');
const router = express.Router();
const serviceCategoryController = require('../controllers/serviceCategory.controller');
const { authenticateEmployee, requireEmployeeRole } = require('../middleware/employeeAuth.middleware');
const { upload } = require('../middleware/upload');

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC ROUTES (Anyone can view categories)
// ═══════════════════════════════════════════════════════════════════════

// @route   GET /api/services/categories
// @desc    Get all categories (with optional filters)
// @access  Public
router.get('/', serviceCategoryController.getAllCategories);

// @route   GET /api/services/categories/:id
// @desc    Get category by ID
// @access  Public
router.get('/:id', serviceCategoryController.getCategoryById);

// ═══════════════════════════════════════════════════════════════════════
// PROTECTED ROUTES (Admin/Employee only)
// ═══════════════════════════════════════════════════════════════════════

// @route   POST /api/services/categories
// @desc    Create new category
// @access  Employee (admin, super_admin)
router.post(
    '/',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin'),
    upload.single('icon'),
    serviceCategoryController.createCategory
);

// @route   PUT /api/services/categories/:id
// @desc    Update category
// @access  Employee (admin, super_admin)
router.put(
    '/:id',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin'),
    upload.single('icon'),
    serviceCategoryController.updateCategory
);

// @route   DELETE /api/services/categories/:id
// @desc    Delete category
// @access  Employee (super_admin only)
router.delete(
    '/:id',
    authenticateEmployee,
    requireEmployeeRole('super_admin'),
    serviceCategoryController.deleteCategory
);

// @route   PATCH /api/services/categories/:id/toggle-status
// @desc    Toggle category active status
// @access  Employee (admin, super_admin)
router.patch(
    '/:id/toggle-status',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin'),
    serviceCategoryController.toggleStatus
);


router.post(
    '/',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin'),
    upload.none(), // Subcategories don't have icons, just parse FormData
    serviceCategoryController.createCategory
);
module.exports = router;