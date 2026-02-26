// backend/routes/profileRoutes.js
// WEGO - Profile Routes

const express = require('express');
const router = express.Router();
const profileController = require('../controllers/profileController');
const { authenticate } = require('../middleware/auth.middleware');
const { upload } = require('../middleware/upload');

// ═══════════════════════════════════════════════════════════════════
// VALIDATION MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════

const validateProfileUpdate = (req, res, next) => {
    const { firstName, lastName, address, city, dateOfBirth } = req.body;
    const errors = [];

    if (firstName !== undefined) {
        if (typeof firstName !== 'string' || firstName.trim().length === 0) {
            errors.push('First name must be a non-empty string');
        } else if (firstName.trim().length < 2) {
            errors.push('First name must be at least 2 characters');
        } else if (firstName.trim().length > 50) {
            errors.push('First name must not exceed 50 characters');
        }
    }

    if (lastName !== undefined) {
        if (typeof lastName !== 'string' || lastName.trim().length === 0) {
            errors.push('Last name must be a non-empty string');
        } else if (lastName.trim().length < 2) {
            errors.push('Last name must be at least 2 characters');
        } else if (lastName.trim().length > 50) {
            errors.push('Last name must not exceed 50 characters');
        }
    }

    if (address !== undefined && address !== null) {
        if (typeof address !== 'string') {
            errors.push('Address must be a string');
        } else if (address.trim().length > 200) {
            errors.push('Address must not exceed 200 characters');
        }
    }

    if (city !== undefined) {
        if (typeof city !== 'string' || city.trim().length === 0) {
            errors.push('City must be a non-empty string');
        } else if (city.trim().length > 100) {
            errors.push('City must not exceed 100 characters');
        }
    }

    if (dateOfBirth !== undefined && dateOfBirth !== null) {
        const date = new Date(dateOfBirth);
        if (isNaN(date.getTime())) {
            errors.push('Invalid date of birth format');
        } else {
            const eighteenYearsAgo = new Date();
            eighteenYearsAgo.setFullYear(eighteenYearsAgo.getFullYear() - 18);
            if (date > eighteenYearsAgo) {
                errors.push('You must be at least 18 years old');
            }
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

const validateAvatarUpload = (req, res, next) => {
    if (!req.file) {
        return res.status(400).json({
            success: false,
            message: 'No file uploaded'
        });
    }

    const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowedMimeTypes.includes(req.file.mimetype)) {
        return res.status(400).json({
            success: false,
            message: 'Invalid file type. Only JPEG, PNG, and WebP images are allowed'
        });
    }

    const maxSize = 5 * 1024 * 1024; // 5MB
    if (req.file.size > maxSize) {
        return res.status(400).json({
            success: false,
            message: 'File size exceeds 5MB limit'
        });
    }

    next();
};

const validateChangePassword = (req, res, next) => {
    const { currentPassword, newPassword } = req.body;
    const errors = [];

    if (!currentPassword || typeof currentPassword !== 'string' || currentPassword.trim().length === 0) {
        errors.push('Current password is required');
    }

    if (!newPassword || typeof newPassword !== 'string') {
        errors.push('New password is required');
    } else {
        if (newPassword.length < 8) {
            errors.push('New password must be at least 8 characters long');
        }
        if (!/[a-z]/.test(newPassword)) {
            errors.push('New password must contain at least one lowercase letter');
        }
        if (!/[A-Z]/.test(newPassword)) {
            errors.push('New password must contain at least one uppercase letter');
        }
        if (!/[0-9]/.test(newPassword)) {
            errors.push('New password must contain at least one number');
        }
        if (!/[!@#$%^&*(),.?":{}|<>]/.test(newPassword)) {
            errors.push('New password must contain at least one special character');
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

const validateDeleteAccount = (req, res, next) => {
    const { password } = req.body;

    if (!password || typeof password !== 'string' || password.trim().length === 0) {
        return res.status(400).json({
            success: false,
            message: 'Password is required to delete account'
        });
    }

    next();
};

// ═══════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════

router.get('/profile', authenticate, profileController.getProfile);
router.put('/profile', authenticate, validateProfileUpdate, profileController.updateProfile);
router.post('/profile/avatar', authenticate, upload.single('avatar'), validateAvatarUpload, profileController.uploadAvatar);
router.delete('/profile/avatar', authenticate, profileController.deleteAvatar);
router.get('/stats', authenticate, profileController.getStats);
router.put('/change-password', authenticate, validateChangePassword, profileController.changePassword);
router.delete('/account', authenticate, validateDeleteAccount, profileController.deleteAccount);

module.exports = router;