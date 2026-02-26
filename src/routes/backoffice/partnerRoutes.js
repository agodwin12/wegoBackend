// wegobackend/src/routes/backoffice/partnerRoutes.js

const express = require('express');
const router = express.Router();
const partnerController = require('../../controllers/backoffice/partnerController');
const { authenticateEmployee } = require('../../middleware/employeeAuth.middleware');

/**
 * 🔐 ALL ROUTES REQUIRE EMPLOYEE AUTHENTICATION
 */
router.use(authenticateEmployee);

/**
 * ═══════════════════════════════════════════════════════════════════════
 * PARTNER CRUD ROUTES
 * ═══════════════════════════════════════════════════════════════════════
 */

/**
 * @route   POST /api/backoffice/partners
 * @desc    Create a new partner
 * @access  Employee only
 * @body    { partnerName, address, phoneNumber, email, password, profilePhoto }
 */
router.post('/', partnerController.createPartner);

/**
 * @route   GET /api/backoffice/partners
 * @desc    Get all partners with pagination and filtering
 * @access  Employee only
 * @query   page, limit, search, isBlocked, sortBy, sortOrder
 */
router.get('/', partnerController.getAllPartners);

/**
 * @route   GET /api/backoffice/partners/stats
 * @desc    Get partner statistics
 * @access  Employee only
 */
router.get('/stats', partnerController.getPartnerStats);

/**
 * @route   GET /api/backoffice/partners/:id
 * @desc    Get single partner by ID
 * @access  Employee only
 */
router.get('/:id', partnerController.getPartnerById);

/**
 * @route   PUT /api/backoffice/partners/:id
 * @desc    Update partner information
 * @access  Employee only
 * @body    { partnerName, address, phoneNumber, email, profilePhoto }
 */
router.put('/:id', partnerController.updatePartner);

/**
 * @route   DELETE /api/backoffice/partners/:id
 * @desc    Delete a partner (only if no vehicles exist)
 * @access  Employee only
 */
router.delete('/:id', partnerController.deletePartner);

/**
 * ═══════════════════════════════════════════════════════════════════════
 * PARTNER MANAGEMENT ROUTES
 * ═══════════════════════════════════════════════════════════════════════
 */

/**
 * @route   POST /api/backoffice/partners/:id/block
 * @desc    Block a partner account
 * @access  Employee only
 * @body    { reason }
 */
router.post('/:id/block', partnerController.blockPartner);

/**
 * @route   POST /api/backoffice/partners/:id/unblock
 * @desc    Unblock a partner account
 * @access  Employee only
 */
router.post('/:id/unblock', partnerController.unblockPartner);

router.get('/:id/rentals', partnerController.getPartnerRentals);

module.exports = router;