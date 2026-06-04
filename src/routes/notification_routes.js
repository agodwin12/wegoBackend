// src/routes/notification_routes.js
'use strict';

//
// ═══════════════════════════════════════════════════════════════════════
// NOTIFICATION ROUTES — User notification inbox
// ═══════════════════════════════════════════════════════════════════════
//
// Mount in app.js:
//   const notificationRoutes = require('./routes/notification_routes');
//   app.use('/api/notifications', notificationRoutes);
//
// ═══════════════════════════════════════════════════════════════════════

const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/notification_controller');
const { authenticate } = require('../middleware/auth.middleware');

// ═══════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   GET /api/notifications
 * @desc    Get paginated notification inbox
 * @access  Private
 * @query   page, limit, unread
 */
router.get(
    '/',
    authenticate,
    controller.getInbox
);

/**
 * @route   GET /api/notifications/unread-count
 * @desc    Get unread notification count (nav bar badge)
 * @access  Private
 */
router.get(
    '/unread-count',
    authenticate,
    controller.getUnreadCount
);

/**
 * @route   PATCH /api/notifications/read-all
 * @desc    Mark all notifications as read
 * @access  Private
 */
router.patch(
    '/read-all',
    authenticate,
    controller.markAllAsRead
);

/**
 * @route   PATCH /api/notifications/:id/read
 * @desc    Mark a single notification as read
 * @access  Private
 */
router.patch(
    '/:id/read',
    authenticate,
    controller.markAsRead
);

module.exports = router;