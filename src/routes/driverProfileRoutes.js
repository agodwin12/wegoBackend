// backend/routes/driverProfileRoutes.js
// WEGO - Driver Profile Routes
// Vehicle info, documents, and driver profile management for Profile section
// NOTE: Driver online/offline is in driverRoutes.js

const express = require('express');
const router = express.Router();
const driverProfileController = require('../controllers/driverProfileController');
const { authenticate } = require('../middleware/auth.middleware');
const { upload } = require('../middleware/upload');

// ═══════════════════════════════════════════════════════════════════
// INLINE VALIDATION MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════

/**
 * Validate vehicle data
 */
const validateVehicle = (req, res, next) => {
    const { brand, model, year, color, licensePlate, vehicleType, capacity } = req.body;

    const errors = [];

    // Brand
    if (brand && (typeof brand !== 'string' || brand.trim().length === 0)) {
        errors.push('Brand must be a non-empty string');
    }

    // Model
    if (model && (typeof model !== 'string' || model.trim().length === 0)) {
        errors.push('Model must be a non-empty string');
    }

    // Year
    if (year) {
        const yearNum = parseInt(year);
        const currentYear = new Date().getFullYear();
        if (isNaN(yearNum) || yearNum < 1990 || yearNum > currentYear + 1) {
            errors.push(`Year must be between 1990 and ${currentYear + 1}`);
        }
    }

    // Color
    if (color && (typeof color !== 'string' || color.trim().length === 0)) {
        errors.push('Color must be a non-empty string');
    }

    // License plate
    if (licensePlate && (typeof licensePlate !== 'string' || licensePlate.trim().length === 0)) {
        errors.push('License plate must be a non-empty string');
    }

    // Vehicle type
    if (vehicleType) {
        const validTypes = ['sedan', 'suv', 'van', 'hatchback', 'pickup', 'other'];
        if (!validTypes.includes(vehicleType.toLowerCase())) {
            errors.push(`Vehicle type must be one of: ${validTypes.join(', ')}`);
        }
    }

    // Capacity
    if (capacity) {
        const capacityNum = parseInt(capacity);
        if (isNaN(capacityNum) || capacityNum < 1 || capacityNum > 50) {
            errors.push('Capacity must be between 1 and 50');
        }
    }

    if (errors.length > 0) {
        return res.status(400).json({
            success: false,
            message: 'Validation failed',
            errors
        });
    }

    next();
};

/**
 * Validate document upload
 */
const validateDocumentUpload = (req, res, next) => {
    const { documentType } = req.body;

    if (!req.file) {
        return res.status(400).json({
            success: false,
            message: 'No document file uploaded'
        });
    }

    // Document type validation
    const validTypes = ['license', 'insurance', 'registration', 'id', 'other'];
    if (!documentType || !validTypes.includes(documentType.toLowerCase())) {
        return res.status(400).json({
            success: false,
            message: `Document type must be one of: ${validTypes.join(', ')}`
        });
    }

    // Check file type (images and PDFs)
    const allowedMimeTypes = [
        'image/jpeg',
        'image/jpg',
        'image/png',
        'image/webp',
        'application/pdf'
    ];
    if (!allowedMimeTypes.includes(req.file.mimetype)) {
        return res.status(400).json({
            success: false,
            message: 'File must be an image (JPEG, PNG, WebP) or PDF'
        });
    }

    // Check file size (max 10MB)
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (req.file.size > maxSize) {
        return res.status(400).json({
            success: false,
            message: 'File size exceeds 10MB limit'
        });
    }

    next();
};

// ═══════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════

/**
 * @route   GET /api/profile/driver
 * @desc    Get driver profile information
 * @access  Private (Driver only)
 */
router.get(
    '/',
    authenticate,
    driverProfileController.getDriverProfile
);

/**
 * @route   GET /api/profile/driver/vehicle
 * @desc    Get vehicle information
 * @access  Private (Driver only)
 */
router.get(
    '/vehicle',
    authenticate,
    driverProfileController.getVehicle
);

/**
 * @route   POST /api/profile/driver/vehicle
 * @desc    Create or update vehicle information
 * @access  Private (Driver only)
 */
router.post(
    '/vehicle',
    authenticate,
    validateVehicle,
    driverProfileController.upsertVehicle
);

/**
 * @route   DELETE /api/profile/driver/vehicle
 * @desc    Delete vehicle information
 * @access  Private (Driver only)
 */
router.delete(
    '/vehicle',
    authenticate,
    driverProfileController.deleteVehicle
);

/**
 * @route   GET /api/profile/driver/documents
 * @desc    Get all driver documents
 * @access  Private (Driver only)
 */
router.get(
    '/documents',
    authenticate,
    driverProfileController.getDocuments
);

/**
 * @route   POST /api/profile/driver/documents
 * @desc    Upload driver document
 * @access  Private (Driver only)
 */
router.post(
    '/documents',
    authenticate,
    upload.single('document'),
    validateDocumentUpload,
    driverProfileController.uploadDocument
);

/**
 * @route   DELETE /api/profile/driver/documents/:id
 * @desc    Delete driver document
 * @access  Private (Driver only)
 */
router.delete(
    '/documents/:id',
    authenticate,
    driverProfileController.deleteDocument
);

module.exports = router;