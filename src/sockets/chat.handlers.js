// src/socket/chat.handlers.js

const ChatMessage = require('../models/ChatMessage');
const Trip = require('../models/Trip');
const Account = require('../models/Account');

/**
 * Socket.IO Chat Event Handlers
 */

module.exports = (io, socket, socketData) => {
    console.log(`💬 [CHAT-SOCKET] Initializing chat handlers for user: ${socketData.userId}`);

    /**
     * Send a chat message
     * Event: chat:send
     */
    socket.on('chat:send', async (data) => {
        try {
            const { tripId, text } = data;
            const userId = socketData.userId;

            console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('💬 [CHAT-SOCKET] Message send request');
            console.log(`📦 Trip ID: ${tripId}`);
            console.log(`👤 From: ${userId}`);
            console.log(`💬 Text: ${text}`);
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            // Validate input
            if (!tripId || !text) {
                socket.emit('chat:error', {
                    message: 'Trip ID and message text are required',
                });
                return;
            }

            if (text.trim().length === 0) {
                socket.emit('chat:error', {
                    message: 'Message cannot be empty',
                });
                return;
            }

            if (text.length > 2000) {
                socket.emit('chat:error', {
                    message: 'Message too long (max 2000 characters)',
                });
                return;
            }

            // Verify trip and authorization
            const trip = await Trip.findByPk(tripId);

            if (!trip) {
                socket.emit('chat:error', {
                    message: 'Trip not found',
                });
                return;
            }

            // Check authorization
            if (trip.driverId !== userId && trip.passengerId !== userId) {
                socket.emit('chat:error', {
                    message: 'Unauthorized',
                });
                return;
            }

            // Check trip status
            const allowedStatuses = ['MATCHED', 'DRIVER_ARRIVED', 'IN_PROGRESS'];
            if (!allowedStatuses.includes(trip.status)) {
                socket.emit('chat:error', {
                    message: 'Chat is only available during active trips',
                });
                return;
            }

            console.log('✅ [CHAT-SOCKET] Authorization passed');

            // Save message to database
            const message = await ChatMessage.create({
                tripId,
                fromUserId: userId,
                text: text.trim(),
            });

            console.log(`✅ [CHAT-SOCKET] Message saved: ${message.id}`);

            // Get sender info
            const sender = await Account.findOne({
                where: { uuid: userId },
                attributes: ['uuid', 'first_name', 'last_name', 'avatar_url', 'user_type'],
            });

            // Determine recipient
            const recipientId = trip.driverId === userId ? trip.passengerId : trip.driverId;

            console.log(`📤 [CHAT-SOCKET] Recipient: ${recipientId}`);

            // Prepare message data
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
            };

            // Emit to sender (confirmation)
            socket.emit('chat:message_sent', {
                success: true,
                message: messageData,
            });

            // Emit to recipient (real-time delivery)
            // Use user room pattern
            io.to(`user:${recipientId}`).emit('chat:new_message', {
                tripId,
                message: messageData,
            });

            // Also emit to trip room (if you're using trip rooms)
            io.to(`trip:${tripId}`).emit('chat:new_message', {
                tripId,
                message: messageData,
            });

            console.log(`✅ [CHAT-SOCKET] Message delivered to recipient`);
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        } catch (error) {
            console.error('❌ [CHAT-SOCKET] Error sending message:', error);
            socket.emit('chat:error', {
                message: 'Failed to send message',
                error: error.message,
            });
        }
    });

    /**
     * Typing indicator
     * Event: chat:typing
     */
    socket.on('chat:typing', async (data) => {
        try {
            const { tripId, isTyping } = data;
            const userId = socketData.userId;

            console.log(`⌨️ [CHAT-SOCKET] Typing indicator: ${userId} - ${isTyping ? 'typing' : 'stopped'}`);

            // Get trip to find recipient
            const trip = await Trip.findByPk(tripId);

            if (!trip) return;

            // Check authorization
            if (trip.driverId !== userId && trip.passengerId !== userId) {
                return;
            }

            // Determine recipient
            const recipientId = trip.driverId === userId ? trip.passengerId : trip.driverId;

            // Emit to recipient
            io.to(`user:${recipientId}`).emit('chat:typing', {
                tripId,
                userId,
                isTyping,
            });

        } catch (error) {
            console.error('❌ [CHAT-SOCKET] Typing indicator error:', error);
        }
    });

    /**
     * Mark messages as read
     * Event: chat:mark_read
     */
    socket.on('chat:mark_read', async (data) => {
        try {
            const { tripId } = data;
            const userId = socketData.userId;

            console.log(`✅ [CHAT-SOCKET] Marking messages as read - Trip: ${tripId}, User: ${userId}`);

            // Verify trip and authorization
            const trip = await Trip.findByPk(tripId);

            if (!trip) return;

            if (trip.driverId !== userId && trip.passengerId !== userId) {
                return;
            }

            // Mark messages as read
            const { Op } = require('sequelize');
            await ChatMessage.update(
                { readAt: new Date() },
                {
                    where: {
                        tripId,
                        fromUserId: { [Op.ne]: userId },
                        readAt: null,
                    },
                }
            );

            // Notify sender that their messages were read
            const recipientId = trip.driverId === userId ? trip.passengerId : trip.driverId;

            io.to(`user:${recipientId}`).emit('chat:messages_read', {
                tripId,
                readBy: userId,
                readAt: new Date(),
            });

            console.log(`✅ [CHAT-SOCKET] Messages marked as read`);

        } catch (error) {
            console.error('❌ [CHAT-SOCKET] Mark read error:', error);
        }
    });

    /**
     * Join trip chat room
     * Event: chat:join
     */
    socket.on('chat:join', async (data) => {
        try {
            const { tripId } = data;
            const userId = socketData.userId;

            console.log(`🚪 [CHAT-SOCKET] User joining trip chat - Trip: ${tripId}, User: ${userId}`);

            // Verify authorization
            const trip = await Trip.findByPk(tripId);

            if (!trip) {
                socket.emit('chat:error', { message: 'Trip not found' });
                return;
            }

            if (trip.driverId !== userId && trip.passengerId !== userId) {
                socket.emit('chat:error', { message: 'Unauthorized' });
                return;
            }

            // Join trip room
            socket.join(`trip:${tripId}`);

            console.log(`✅ [CHAT-SOCKET] User joined trip chat room: trip:${tripId}`);

            // Emit confirmation
            socket.emit('chat:joined', {
                tripId,
                success: true,
            });

        } catch (error) {
            console.error('❌ [CHAT-SOCKET] Join chat error:', error);
            socket.emit('chat:error', {
                message: 'Failed to join chat',
                error: error.message,
            });
        }
    });

    /**
     * Leave trip chat room
     * Event: chat:leave
     */
    socket.on('chat:leave', (data) => {
        try {
            const { tripId } = data;

            console.log(`🚪 [CHAT-SOCKET] User leaving trip chat - Trip: ${tripId}`);

            socket.leave(`trip:${tripId}`);

            socket.emit('chat:left', {
                tripId,
                success: true,
            });

        } catch (error) {
            console.error('❌ [CHAT-SOCKET] Leave chat error:', error);
        }
    });

    console.log(`✅ [CHAT-SOCKET] Chat handlers initialized for user: ${socketData.userId}\n`);
};