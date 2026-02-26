// backend/routes/preferencesRoutes.js
// WEGO - User Preferences Routes
// Notification, privacy, and app preferences management

const express = require('express');
const router = express.Router();
const preferencesController = require('../controllers/preferencesController');
const { authenticate } = require('../middleware/auth.middleware');

// ═══════════════════════════════════════════════════════════════════
// INLINE VALIDATION MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════

/**
 * Validate notification preferences
 */
const validateNotificationPreferences = (req, res, next) => {
    const {
        pushNotifications,
        emailNotifications,
        smsNotifications,
        rideNotifications,
        serviceNotifications,
        paymentNotifications,
        marketingNotifications
    } = req.body;

    const errors = [];

    // All must be boolean if provided
    const booleanFields = {
        pushNotifications,
        emailNotifications,
        smsNotifications,
        rideNotifications,
        serviceNotifications,
        paymentNotifications,
        marketingNotifications
    };

    Object.entries(booleanFields).forEach(([key, value]) => {
        if (value !== undefined && typeof value !== 'boolean') {
            errors.push(`${key} must be a boolean value`);
        }
    });

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
 * Validate privacy preferences
 */
const validatePrivacyPreferences = (req, res, next) => {
    const {
        showPhoneToDrivers,
        showProfilePhoto,
        shareLocationHistory,
        allowRatings
    } = req.body;

    const errors = [];

    // All must be boolean if provided
    const booleanFields = {
        showPhoneToDrivers,
        showProfilePhoto,
        shareLocationHistory,
        allowRatings
    };

    Object.entries(booleanFields).forEach(([key, value]) => {
        if (value !== undefined && typeof value !== 'boolean') {
            errors.push(`${key} must be a boolean value`);
        }
    });

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
 * Validate app preferences
 */
const validateAppPreferences = (req, res, next) => {
    const { language, theme } = req.body;

    const errors = [];

    // Language validation
    if (language !== undefined) {
        const validLanguages = ['en', 'fr'];
        if (!validLanguages.includes(language.toLowerCase())) {
            errors.push(`Language must be one of: ${validLanguages.join(', ')}`);
        }
    }

    // Theme validation
    if (theme !== undefined) {
        const validThemes = ['light', 'dark', 'system'];
        if (!validThemes.includes(theme.toLowerCase())) {
            errors.push(`Theme must be one of: ${validThemes.join(', ')}`);
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

// ═══════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════

/**
 * @route   GET /api/preferences
 * @desc    Get user preferences
 * @access  Private
 */
router.get(
    '/',
    authenticate,
    preferencesController.getPreferences
);

/**
 * @route   PUT /api/preferences/notifications
 * @desc    Update notification preferences
 * @access  Private
 */
router.put(
    '/notifications',
    authenticate,
    validateNotificationPreferences,
    preferencesController.updateNotificationPreferences
);

/**
 * @route   PUT /api/preferences/privacy
 * @desc    Update privacy preferences
 * @access  Private
 */
router.put(
    '/privacy',
    authenticate,
    validatePrivacyPreferences,
    preferencesController.updatePrivacyPreferences
);

/**
 * @route   PUT /api/preferences/app
 * @desc    Update app preferences (language, theme)
 * @access  Private
 */
router.put(
    '/app',
    authenticate,
    validateAppPreferences,
    preferencesController.updateAppPreferences
);

/**
 * @route   POST /api/preferences/reset
 * @desc    Reset all preferences to default
 * @access  Private
 */
router.post(
    '/reset',
    authenticate,
    preferencesController.resetPreferences
);

module.exports = router;