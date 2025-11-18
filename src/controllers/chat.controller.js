// src/controllers/chat.controller.js

const ChatMessage = require('../models/ChatMessage');
const Trip = require('../models/Trip');
const Account = require('../models/Account');
const { Op } = require('sequelize');

/**
 * Get all messages for a trip
 * GET /api/chat/:tripId
 */
exports.getMessages = async (req, res) => {
    try {
        const { tripId } = req.params;
        const userId = req.user.uuid;

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('💬 [CHAT] Fetching messages');
        console.log(`📦 Trip ID: ${tripId}`);
        console.log(`👤 User ID: ${userId}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        // Verify user is part of this trip
        const trip = await Trip.findByPk(tripId);

        if (!trip) {
            return res.status(404).json({
                success: false,
                message: 'Trip not found',
            });
        }

        // Check authorization
        if (trip.driverId !== userId && trip.passengerId !== userId) {
            return res.status(403).json({
                success: false,
                message: 'You are not authorized to view this conversation',
            });
        }

        console.log('✅ [CHAT] User authorized');

        // Get all messages for this trip
        const messages = await ChatMessage.findAll({
            where: { tripId },
            include: [
                {
                    model: Account,
                    as: 'sender',
                    attributes: ['uuid', 'first_name', 'last_name', 'avatar_url', 'user_type'],
                },
            ],
            order: [['createdAt', 'ASC']], // Chronological order
        });

        console.log(`✅ [CHAT] Found ${messages.length} messages\n`);

        res.status(200).json({
            success: true,
            data: {
                tripId,
                messages: messages.map(msg => ({
                    id: msg.id,
                    text: msg.text,
                    fromUserId: msg.fromUserId,
                    sender: msg.sender ? {
                        uuid: msg.sender.uuid,
                        name: `${msg.sender.first_name} ${msg.sender.last_name}`.trim(),
                        avatar: msg.sender.avatar_url,
                        userType: msg.sender.user_type,
                    } : null,
                    readAt: msg.readAt,
                    createdAt: msg.createdAt,
                })),
                unreadCount: messages.filter(
                    m => m.fromUserId !== userId && !m.readAt
                ).length,
            },
        });

    } catch (error) {
        console.error('❌ [CHAT] Error fetching messages:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch messages',
            error: error.message,
        });
    }
};

/**
 * Send a message
 * POST /api/chat/:tripId/send
 */
exports.sendMessage = async (req, res) => {
    try {
        const { tripId } = req.params;
        const { text } = req.body;
        const userId = req.user.uuid;

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('💬 [CHAT] Sending message');
        console.log(`📦 Trip ID: ${tripId}`);
        console.log(`👤 From: ${userId}`);
        console.log(`💬 Text: ${text}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        // Validate input
        if (!text || text.trim().length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Message text is required',
            });
        }

        if (text.length > 2000) {
            return res.status(400).json({
                success: false,
                message: 'Message text too long (max 2000 characters)',
            });
        }

        // Verify trip exists and user is authorized
        const trip = await Trip.findByPk(tripId);

        if (!trip) {
            return res.status(404).json({
                success: false,
                message: 'Trip not found',
            });
        }

        // Check authorization
        if (trip.driverId !== userId && trip.passengerId !== userId) {
            return res.status(403).json({
                success: false,
                message: 'You are not authorized to send messages in this trip',
            });
        }

        // Check trip status (only allow chat during active trip)
        const allowedStatuses = ['MATCHED', 'DRIVER_ARRIVED', 'IN_PROGRESS'];
        if (!allowedStatuses.includes(trip.status)) {
            return res.status(400).json({
                success: false,
                message: 'Chat is only available during active trips',
            });
        }

        console.log('✅ [CHAT] User authorized, trip status valid');

        // Create message
        const message = await ChatMessage.create({
            tripId,
            fromUserId: userId,
            text: text.trim(),
        });

        console.log(`✅ [CHAT] Message created: ${message.id}`);

        // Get sender info
        const sender = await Account.findOne({
            where: { uuid: userId },
            attributes: ['uuid', 'first_name', 'last_name', 'avatar_url', 'user_type'],
        });

        // Determine recipient
        const recipientId = trip.driverId === userId ? trip.passengerId : trip.driverId;

        console.log(`📤 [CHAT] Recipient: ${recipientId}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        // Prepare response
        const messageData = {
            id: message.id,
            tripId: message.tripId,
            text: message.text,
            fromUserId: message.fromUserId,
            sender: sender ? {
                uuid: sender.uuid,
                name: `${sender.first_name} ${sender.last_name}`.trim(),
                avatar: sender.avatar_url,
                userType: sender.user_type,
            } : null,
            readAt: message.readAt,
            createdAt: message.createdAt,
            recipientId,
        };

        res.status(201).json({
            success: true,
            message: 'Message sent successfully',
            data: {
                message: messageData,
            },
        });

    } catch (error) {
        console.error('❌ [CHAT] Error sending message:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send message',
            error: error.message,
        });
    }
};

/**
 * Mark messages as read
 * PUT /api/chat/:tripId/read
 */
exports.markAsRead = async (req, res) => {
    try {
        const { tripId } = req.params;
        const userId = req.user.uuid;

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ [CHAT] Marking messages as read');
        console.log(`📦 Trip ID: ${tripId}`);
        console.log(`👤 User ID: ${userId}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        // Verify trip exists
        const trip = await Trip.findByPk(tripId);

        if (!trip) {
            return res.status(404).json({
                success: false,
                message: 'Trip not found',
            });
        }

        // Check authorization
        if (trip.driverId !== userId && trip.passengerId !== userId) {
            return res.status(403).json({
                success: false,
                message: 'Unauthorized',
            });
        }

        // Mark all unread messages from other user as read
        const [updatedCount] = await ChatMessage.update(
            { readAt: new Date() },
            {
                where: {
                    tripId,
                    fromUserId: { [Op.ne]: userId }, // Not from current user
                    readAt: null, // Not already read
                },
            }
        );

        console.log(`✅ [CHAT] Marked ${updatedCount} messages as read\n`);

        res.status(200).json({
            success: true,
            message: 'Messages marked as read',
            data: {
                updatedCount,
            },
        });

    } catch (error) {
        console.error('❌ [CHAT] Error marking messages as read:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to mark messages as read',
            error: error.message,
        });
    }
};

/**
 * Get unread message count
 * GET /api/chat/:tripId/unread
 */
exports.getUnreadCount = async (req, res) => {
    try {
        const { tripId } = req.params;
        const userId = req.user.uuid;

        // Verify authorization
        const trip = await Trip.findByPk(tripId);
        if (!trip) {
            return res.status(404).json({
                success: false,
                message: 'Trip not found',
            });
        }

        if (trip.driverId !== userId && trip.passengerId !== userId) {
            return res.status(403).json({
                success: false,
                message: 'Unauthorized',
            });
        }

        // Count unread messages
        const unreadCount = await ChatMessage.count({
            where: {
                tripId,
                fromUserId: { [Op.ne]: userId },
                readAt: null,
            },
        });

        res.status(200).json({
            success: true,
            data: {
                unreadCount,
            },
        });

    } catch (error) {
        console.error('❌ [CHAT] Error getting unread count:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get unread count',
            error: error.message,
        });
    }
};

module.exports = exports;