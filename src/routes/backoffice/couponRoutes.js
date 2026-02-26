const express = require('express');
const router = express.Router();
const couponController = require('../../controllers/backoffice/couponController');
const { authenticateEmployee, requireEmployeeRole } = require('../../middleware/employeeAuth.middleware');

// All routes require authentication and specific roles
const allowedRoles = ['admin', 'super_admin', 'manager'];

// Apply authentication middleware to all routes
router.use(authenticateEmployee);
router.use(requireEmployeeRole(...allowedRoles));

// GET /api/backoffice/coupons - Get all coupons with pagination and filters
router.get('/', couponController.getAllCoupons);

// GET /api/backoffice/coupons/generate-code - Generate random coupon code
router.get('/generate-code', couponController.generateCode);

// GET /api/backoffice/coupons/:id - Get single coupon by ID
router.get('/:id', couponController.getCouponById);

// GET /api/backoffice/coupons/:id/usage - Get coupon usage statistics
router.get('/:id/usage', couponController.getCouponUsage);

// POST /api/backoffice/coupons - Create new coupon
router.post('/', couponController.createCoupon);

// PUT /api/backoffice/coupons/:id - Update coupon
router.put('/:id', couponController.updateCoupon);

// PATCH /api/backoffice/coupons/:id/toggle - Toggle coupon active status
router.patch('/:id/toggle', couponController.toggleCouponStatus);

// DELETE /api/backoffice/coupons/:id - Delete coupon
router.delete('/:id', couponController.deleteCoupon);

module.exports = router;