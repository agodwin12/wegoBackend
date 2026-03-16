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
// @desc    Get all categories (grouped with subcategories)
// @access  Public
router.get('/', serviceCategoryController.getAllCategories);

// @route   GET /api/services/categories/parents
// @desc    Get parent categories only
// @access  Public
router.get('/parents', serviceCategoryController.getParentCategories);

// @route   GET /api/services/categories/:parentId/subcategories
// @desc    Get subcategories by parent ID
// @access  Public
router.get('/:parentId/subcategories', serviceCategoryController.getSubcategories);

// @route   GET /api/services/categories/:id
// @desc    Get category by ID
// @access  Public
router.get('/:id', serviceCategoryController.getCategoryById);

// ═══════════════════════════════════════════════════════════════════════
// PROTECTED ROUTES (Admin/Employee only)
// ═══════════════════════════════════════════════════════════════════════

// @route   POST /api/services/categories
// @desc    Create new category or subcategory
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

// @route   PATCH /api/services/categories/:id/toggle-status
// @desc    Toggle category active/inactive status
// @access  Employee (admin, super_admin)
router.patch(
    '/:id/toggle-status',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin'),
    serviceCategoryController.toggleStatus
);

// @route   DELETE /api/services/categories/:id
// @desc    Delete category (soft delete)
// @access  Employee (super_admin only)
router.delete(
    '/:id',
    authenticateEmployee,
    requireEmployeeRole('super_admin'),
    serviceCategoryController.deleteCategory
);

module.exports = router;