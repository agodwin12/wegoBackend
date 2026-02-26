// backend/routes/supportRoutes.js
// WEGO - Support & Help Routes
// FAQ, support tickets, problem reports, and feedback

const express = require('express');
const router = express.Router();
const supportController = require('../controllers/supportController');
const { authenticate } = require('../middleware/auth.middleware');

// ═══════════════════════════════════════════════════════════════════
// INLINE VALIDATION MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════

/**
 * Validate support ticket creation
 */
const validateSupportTicket = (req, res, next) => {
    const { subject, message, category, priority } = req.body;

    const errors = [];

    // Subject validation
    if (!subject || typeof subject !== 'string' || subject.trim().length === 0) {
        errors.push('Subject is required');
    } else if (subject.trim().length < 5) {
        errors.push('Subject must be at least 5 characters');
    } else if (subject.trim().length > 200) {
        errors.push('Subject must not exceed 200 characters');
    }

    // Message validation
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
        errors.push('Message is required');
    } else if (message.trim().length < 20) {
        errors.push('Message must be at least 20 characters');
    } else if (message.trim().length > 2000) {
        errors.push('Message must not exceed 2000 characters');
    }

    // Category validation (optional)
    if (category) {
        const validCategories = ['general', 'account', 'payment', 'rides', 'services', 'technical', 'other'];
        if (!validCategories.includes(category.toLowerCase())) {
            errors.push(`Category must be one of: ${validCategories.join(', ')}`);
        }
    }

    // Priority validation (optional)
    if (priority) {
        const validPriorities = ['low', 'medium', 'high', 'urgent'];
        if (!validPriorities.includes(priority.toLowerCase())) {
            errors.push(`Priority must be one of: ${validPriorities.join(', ')}`);
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
 * Validate problem report
 */
const validateProblemReport = (req, res, next) => {
    const { problemType, description } = req.body;

    const errors = [];

    // Problem type validation
    if (!problemType || typeof problemType !== 'string' || problemType.trim().length === 0) {
        errors.push('Problem type is required');
    } else {
        const validTypes = ['app_crash', 'payment_issue', 'login_problem', 'feature_not_working', 'other'];
        if (!validTypes.includes(problemType.toLowerCase())) {
            errors.push(`Problem type must be one of: ${validTypes.join(', ')}`);
        }
    }

    // Description validation
    if (!description || typeof description !== 'string' || description.trim().length === 0) {
        errors.push('Description is required');
    } else if (description.trim().length < 20) {
        errors.push('Description must be at least 20 characters');
    } else if (description.trim().length > 2000) {
        errors.push('Description must not exceed 2000 characters');
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
 * Validate feedback submission
 */
const validateFeedback = (req, res, next) => {
    const { feedbackType, message, rating } = req.body;

    const errors = [];

    // Feedback type validation
    if (!feedbackType || typeof feedbackType !== 'string' || feedbackType.trim().length === 0) {
        errors.push('Feedback type is required');
    } else {
        const validTypes = ['suggestion', 'complaint', 'praise', 'feature_request', 'other'];
        if (!validTypes.includes(feedbackType.toLowerCase())) {
            errors.push(`Feedback type must be one of: ${validTypes.join(', ')}`);
        }
    }

    // Message validation
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
        errors.push('Message is required');
    } else if (message.trim().length < 10) {
        errors.push('Message must be at least 10 characters');
    } else if (message.trim().length > 1000) {
        errors.push('Message must not exceed 1000 characters');
    }

    // Rating validation (optional)
    if (rating !== undefined) {
        const ratingNum = parseInt(rating);
        if (isNaN(ratingNum) || ratingNum < 1 || ratingNum > 5) {
            errors.push('Rating must be between 1 and 5');
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

// FAQ Routes (Public)

/**
 * @route   GET /api/support/faq
 * @desc    Get all FAQs (categorized)
 * @access  Public
 */
router.get(
    '/faq',
    supportController.getFAQs
);

/**
 * @route   GET /api/support/faq/categories
 * @desc    Get all FAQ categories
 * @access  Public
 */
router.get(
    '/faq/categories',
    supportController.getFAQCategories
);

// Support Ticket Routes (Private)

/**
 * @route   POST /api/support/contact
 * @desc    Create support ticket (contact support)
 * @access  Private
 */
router.post(
    '/contact',
    authenticate,
    validateSupportTicket,
    supportController.createSupportTicket
);

/**
 * @route   GET /api/support/tickets
 * @desc    Get user's support tickets
 * @access  Private
 */
router.get(
    '/tickets',
    authenticate,
    supportController.getUserTickets
);

/**
 * @route   GET /api/support/tickets/:ticketNumber
 * @desc    Get specific ticket details
 * @access  Private
 */
router.get(
    '/tickets/:ticketNumber',
    authenticate,
    supportController.getTicketDetails
);

// Problem Report Routes (Private)

/**
 * @route   POST /api/support/report
 * @desc    Report a problem
 * @access  Private
 */
router.post(
    '/report',
    authenticate,
    validateProblemReport,
    supportController.reportProblem
);

// Feedback Routes (Private)

/**
 * @route   POST /api/support/feedback
 * @desc    Submit general feedback
 * @access  Private
 */
router.post(
    '/feedback',
    authenticate,
    validateFeedback,
    supportController.submitFeedback
);

module.exports = router;