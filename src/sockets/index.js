// src/sockets/index.js

const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { storeUserSocket, removeUserSocket, setDriverOffline } = require('../config/redis');
const {
    handleDriverOnline,
    handleDriverOffline,
    handleDriverLocationUpdate,
    handleTripAccept,
    handleTripDecline,
    handleDriverEnRoute,
    handleDriverArrived,
    handleTripStart,
    handleTripComplete,
    handleTripCancel,
} = require('./driverHandlers');

// Import chat handlers
const ChatMessage = require('../models/ChatMessage');
const Trip = require('../models/Trip');
const Account = require('../models/Account');
const { Op } = require('sequelize');

// ═══════════════════════════════════════════════════════════════════════
// MODULE-LEVEL VARIABLE TO STORE IO INSTANCE
// ═══════════════════════════════════════════════════════════════════════

let io = null;

// ═══════════════════════════════════════════════════════════════════════
// SOCKET.IO SETUP
// ═══════════════════════════════════════════════════════════════════════

function setupSocketIO(server) {
    io = new Server(server, {
        cors: {
            origin: process.env.CORS_ORIGIN || '*',
            methods: ['GET', 'POST'],
            credentials: true,
        },
        pingTimeout: 60000,
        pingInterval: 25000,
    });

    console.log('🔌 [SOCKET] Socket.IO server initialized');

    // ═══════════════════════════════════════════════════════════════
    // AUTHENTICATION MIDDLEWARE
    // ═══════════════════════════════════════════════════════════════

    io.use(async (socket, next) => {
        try {
            const token = socket.handshake.auth.token;

            if (!token) {
                console.log('❌ [SOCKET] No token provided');
                return next(new Error('Authentication error: No token provided'));
            }

            // Verify JWT token
            const decoded = jwt.verify(token, process.env.JWT_SECRET);

            // Attach user info to socket
            socket.userId = decoded.uuid;
            socket.userType = decoded.user_type;
            socket.email = decoded.email;

            console.log(`✅ [SOCKET] Authenticated: ${socket.userType} ${socket.userId}`);

            next();
        } catch (error) {
            console.error('❌ [SOCKET] Authentication error:', error.message);
            next(new Error('Authentication error: Invalid token'));
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // CONNECTION HANDLER
    // ═══════════════════════════════════════════════════════════════

    io.on('connection', async (socket) => {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔌 [SOCKET] New connection');
        console.log('🆔 Socket ID:', socket.id);
        console.log('👤 User ID:', socket.userId);
        console.log('👤 User Type:', socket.userType);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        // Store socket ID in Redis
        await storeUserSocket(socket.userId, socket.id);

        // Join user-specific room
        socket.join(`user:${socket.userId}`);

        // Join type-specific room
        if (socket.userType === 'DRIVER') {
            socket.join(`driver:${socket.userId}`);
        } else if (socket.userType === 'PASSENGER') {
            socket.join(`passenger:${socket.userId}`);
        }

        // Send connection success
        socket.emit('connection:success', {
            socketId: socket.id,
            userId: socket.userId,
            userType: socket.userType,
            message: 'Connected successfully',
            timestamp: new Date().toISOString(),
        });

        // ───────────────────────────────────────────────────────────
        // DRIVER EVENTS
        // ───────────────────────────────────────────────────────────

        if (socket.userType === 'DRIVER') {
            // Driver goes online
            socket.on('driver:online', (data) => {
                handleDriverOnline(socket, data);
            });

            // Driver goes offline
            socket.on('driver:offline', (data) => {
                handleDriverOffline(socket, data);
            });

            // Driver location update
            socket.on('driver:location', (data) => {
                handleDriverLocationUpdate(socket, data, io);
            });

            socket.on('driver:location_update', (data) => {
                handleDriverLocationUpdate(socket, data, io);
            });

            // Trip actions
            socket.on('trip:accept', (data) => {
                handleTripAccept(socket, data, io);
            });

            socket.on('trip:decline', (data) => {
                handleTripDecline(socket, data);
            });

            socket.on('driver:en_route', (data) => {
                handleDriverEnRoute(socket, data, io);
            });

            socket.on('driver:arrived', (data) => {
                handleDriverArrived(socket, data, io);
            });

            // Alternative event name for arrived (if Flutter uses this)
            socket.on('trip:arrived', (data) => {
                handleDriverArrived(socket, data, io);
            });

            socket.on('trip:start', (data) => {
                handleTripStart(socket, data, io);
            });

            socket.on('trip:complete', (data) => {
                handleTripComplete(socket, data, io);
            });

            socket.on('trip:cancel', (data) => {
                handleTripCancel(socket, data, io);
            });
        }

        // ───────────────────────────────────────────────────────────
        // PASSENGER EVENTS
        // ───────────────────────────────────────────────────────────

        if (socket.userType === 'PASSENGER') {
            // Trip cancellation
            socket.on('trip:cancel', async (data) => {
                // TODO: Implement passenger cancel trip
                console.log('🚫 [SOCKET-PASSENGER] Cancel trip:', data.tripId);
            });
        }

        // ───────────────────────────────────────────────────────────
        // CHAT EVENTS (BOTH DRIVER & PASSENGER)
        // ───────────────────────────────────────────────────────────

        /**
         * Send a chat message
         */
        socket.on('chat:send', async (data) => {
            try {
                const { tripId, text } = data;
                const userId = socket.userId;

                console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                console.log('💬 [CHAT] Message send request');
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

                console.log('✅ [CHAT] Authorization passed');

                // Save message to database
                const message = await ChatMessage.create({
                    tripId,
                    fromUserId: userId,
                    text: text.trim(),
                });

                console.log(`✅ [CHAT] Message saved: ${message.id}`);

                // Get sender info
                const sender = await Account.findOne({
                    where: { uuid: userId },
                    attributes: ['uuid', 'first_name', 'last_name', 'avatar_url', 'user_type'],
                });

                // Determine recipient
                const recipientId = trip.driverId === userId ? trip.passengerId : trip.driverId;

                console.log(`📤 [CHAT] Recipient: ${recipientId}`);

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
                io.to(`user:${recipientId}`).emit('chat:new_message', {
                    tripId,
                    message: messageData,
                });

                // Also emit to trip room
                io.to(`trip:${tripId}`).emit('chat:new_message', {
                    tripId,
                    message: messageData,
                });

                console.log(`✅ [CHAT] Message delivered to recipient`);
                console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            } catch (error) {
                console.error('❌ [CHAT] Error sending message:', error);
                socket.emit('chat:error', {
                    message: 'Failed to send message',
                    error: error.message,
                });
            }
        });

        /**
         * Typing indicator
         */
        socket.on('chat:typing', async (data) => {
            try {
                const { tripId, isTyping } = data;
                const userId = socket.userId;

                console.log(`⌨️ [CHAT] Typing indicator: ${userId} - ${isTyping ? 'typing' : 'stopped'}`);

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
                console.error('❌ [CHAT] Typing indicator error:', error);
            }
        });

        /**
         * Mark messages as read
         */
        socket.on('chat:mark_read', async (data) => {
            try {
                const { tripId } = data;
                const userId = socket.userId;

                console.log(`✅ [CHAT] Marking messages as read - Trip: ${tripId}, User: ${userId}`);

                // Verify trip and authorization
                const trip = await Trip.findByPk(tripId);

                if (!trip) return;

                if (trip.driverId !== userId && trip.passengerId !== userId) {
                    return;
                }

                // Mark messages as read
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

                console.log(`✅ [CHAT] Messages marked as read`);

            } catch (error) {
                console.error('❌ [CHAT] Mark read error:', error);
            }
        });

        /**
         * Join trip chat room
         */
        socket.on('chat:join', async (data) => {
            try {
                const { tripId } = data;
                const userId = socket.userId;

                console.log(`🚪 [CHAT] User joining trip chat - Trip: ${tripId}, User: ${userId}`);

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

                console.log(`✅ [CHAT] User joined trip chat room: trip:${tripId}`);

                // Emit confirmation
                socket.emit('chat:joined', {
                    tripId,
                    success: true,
                });

            } catch (error) {
                console.error('❌ [CHAT] Join chat error:', error);
                socket.emit('chat:error', {
                    message: 'Failed to join chat',
                    error: error.message,
                });
            }
        });

        /**
         * Leave trip chat room
         */
        socket.on('chat:leave', (data) => {
            try {
                const { tripId } = data;

                console.log(`🚪 [CHAT] User leaving trip chat - Trip: ${tripId}`);

                socket.leave(`trip:${tripId}`);

                socket.emit('chat:left', {
                    tripId,
                    success: true,
                });

            } catch (error) {
                console.error('❌ [CHAT] Leave chat error:', error);
            }
        });

        // ───────────────────────────────────────────────────────────
        // GENERAL EVENTS
        // ───────────────────────────────────────────────────────────

        // Ping/Pong heartbeat
        socket.on('ping', () => {
            socket.emit('pong', {
                timestamp: new Date().toISOString(),
            });
        });

        // Connection test
        socket.on('connection:test', () => {
            socket.emit('connection:test:response', {
                socketId: socket.id,
                userId: socket.userId,
                userType: socket.userType,
                connected: true,
                timestamp: new Date().toISOString(),
            });
        });

        // ───────────────────────────────────────────────────────────
        // DISCONNECTION HANDLER
        // ───────────────────────────────────────────────────────────

        socket.on('disconnect', async (reason) => {
            console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('❌ [SOCKET] Disconnected');
            console.log('🆔 Socket ID:', socket.id);
            console.log('👤 User ID:', socket.userId);
            console.log('📝 Reason:', reason);
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            // Remove socket from Redis
            await removeUserSocket(socket.userId);

            // If driver, mark as offline
            if (socket.userType === 'DRIVER') {
                try {
                    await setDriverOffline(socket.userId);
                    console.log('🔴 [SOCKET] Driver marked offline:', socket.userId);
                } catch (error) {
                    console.error('❌ [SOCKET] Error marking driver offline:', error);
                }
            }
        });

        // ───────────────────────────────────────────────────────────
        // ERROR HANDLER
        // ───────────────────────────────────────────────────────────

        socket.on('error', (error) => {
            console.error('❌ [SOCKET] Socket error:', error);
        });
    });

    return io;
}

// ═══════════════════════════════════════════════════════════════════════
// GET IO INSTANCE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Get the Socket.IO instance
 * @returns {Server} Socket.IO server instance
 * @throws {Error} If Socket.IO has not been initialized
 */
function getIO() {
    if (!io) {
        throw new Error('Socket.IO has not been initialized! Call setupSocketIO first.');
    }
    return io;
}

// ═══════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════

module.exports = setupSocketIO;
module.exports.getIO = getIO;