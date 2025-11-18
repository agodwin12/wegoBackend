// src/routes/chat.routes.js

const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chat.controller');
const { authenticate } = require('../middleware/auth.middleware');


router.get(
    '/:tripId',
    authenticate,
    chatController.getMessages
);

// Send a message
router.post(
    '/:tripId/send',
    authenticate,
    chatController.sendMessage
);

// Mark messages as read
router.put(
    '/:tripId/read',
    authenticate,
    chatController.markAsRead
);

// Get unread message count
router.get(
    '/:tripId/unread',
    authenticate,
    chatController.getUnreadCount
);

module.exports = router;