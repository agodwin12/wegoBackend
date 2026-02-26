// src/sockets/index.js

const { Server } = require('socket.io');
const jwt        = require('jsonwebtoken');
const { redisClient, storeUserSocket, removeUserSocket, setDriverOffline, REDIS_KEYS, redisHelpers } = require('../config/redis');
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

// ✅ FIX: Use models/index.js (same as every other file) — no individual requires
const { ChatMessage, Trip, Account } = require('../models');
const { Op } = require('sequelize');

// ═══════════════════════════════════════════════════════════════════════
// MODULE-LEVEL IO INSTANCE
// ═══════════════════════════════════════════════════════════════════════

let io = null;

// ═══════════════════════════════════════════════════════════════════════
// SETUP
// ═══════════════════════════════════════════════════════════════════════

function setupSocketIO(server) {
    io = new Server(server, {
        cors: {
            origin:      process.env.CORS_ORIGIN || '*',
            methods:     ['GET', 'POST'],
            credentials: true,
        },
        pingTimeout:  60000,
        pingInterval: 25000,
        // Allow up to 3s for client to reconnect before cleaning up
        connectTimeout: 45000,
    });

    console.log('🔌 [SOCKET] Socket.IO server initialised');

    // ═══════════════════════════════════════════════════════════
    // AUTH MIDDLEWARE
    // Runs BEFORE connection — socket.userId/userType set here
    // ═══════════════════════════════════════════════════════════

    io.use(async (socket, next) => {
        try {
            const token = socket.handshake.auth.token || socket.handshake.query.token;

            if (!token) {
                console.log('❌ [SOCKET] Connection rejected: no token');
                return next(new Error('Authentication error: No token provided'));
            }

            const decoded = jwt.verify(token, process.env.JWT_SECRET);

            socket.userId   = decoded.uuid;
            socket.userType = decoded.user_type;
            socket.email    = decoded.email;

            console.log(`✅ [SOCKET] Auth OK — ${socket.userType} ${socket.userId}`);
            next();

        } catch (error) {
            console.error('❌ [SOCKET] Auth error:', error.message);
            next(new Error('Authentication error: Invalid token'));
        }
    });

    // ═══════════════════════════════════════════════════════════
    // CONNECTION HANDLER
    // ═══════════════════════════════════════════════════════════

    io.on('connection', async (socket) => {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔌 [SOCKET] Connected');
        console.log('   Socket:', socket.id);
        console.log('   User:  ', socket.userId);
        console.log('   Type:  ', socket.userType);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        // ── ✅ FIX STEP 17: Join rooms BEFORE storing socket in Redis ──
        // Rationale: if we stored in Redis first and a broadcast arrived
        // in the ~1ms gap before join(), the message would be lost.
        // Room membership is synchronous; Redis is async.
        socket.join(`user:${socket.userId}`);
        if (socket.userType === 'DRIVER')    socket.join(`driver:${socket.userId}`);
        if (socket.userType === 'PASSENGER') socket.join(`passenger:${socket.userId}`);

        console.log(`✅ [SOCKET] Rooms joined for ${socket.userId}: user, ${socket.userType.toLowerCase()}`);

        // NOW store socket ID in Redis (rooms already joined, no gap)
        try {
            await storeUserSocket(socket.userId, socket.id);
            console.log(`✅ [SOCKET] Redis socket stored: ${socket.userId} → ${socket.id}`);
        } catch (redisErr) {
            // Non-fatal — direct socket delivery still works
            console.error('⚠️  [SOCKET] Redis socket store failed:', redisErr.message);
        }

        // Confirm to client
        socket.emit('connection:success', {
            socketId:  socket.id,
            userId:    socket.userId,
            userType:  socket.userType,
            message:   'Connected successfully',
            timestamp: new Date().toISOString(),
        });

        // ── ✅ FIX: Replay any missed events on reconnect ──────────────
        // If the driver was backgrounded (Android killed the process) they
        // may have missed trip:new_request, trip:matched, etc.
        // On reconnect we check Redis for an active trip offer or active trip
        // and re-send the relevant event so the UI recovers automatically.
        if (socket.userType === 'DRIVER') {
            await _replayMissedDriverEvents(socket).catch(e =>
                console.warn('⚠️  [SOCKET] replayMissedDriverEvents failed (non-fatal):', e.message)
            );
        }
        if (socket.userType === 'PASSENGER') {
            await _replayMissedPassengerEvents(socket).catch(e =>
                console.warn('⚠️  [SOCKET] replayMissedPassengerEvents failed (non-fatal):', e.message)
            );
        }

        // ───────────────────────────────────────────────────────────
        // DRIVER EVENTS
        // ───────────────────────────────────────────────────────────

        if (socket.userType === 'DRIVER') {

            socket.on('driver:online',  (data) => handleDriverOnline(socket, data));
            socket.on('driver:offline', (data) => handleDriverOffline(socket, data));

            socket.on('driver:location',        (data) => handleDriverLocationUpdate(socket, data, io));
            socket.on('driver:location_update', (data) => handleDriverLocationUpdate(socket, data, io));

            socket.on('trip:accept',   (data) => handleTripAccept(socket, data, io));
            socket.on('trip:decline',  (data) => handleTripDecline(socket, data));

            socket.on('driver:en_route', (data) => handleDriverEnRoute(socket, data, io));
            socket.on('driver:arrived',  (data) => handleDriverArrived(socket, data, io));
            socket.on('trip:arrived',    (data) => handleDriverArrived(socket, data, io)); // alias

            socket.on('trip:start',    (data) => handleTripStart(socket, data, io));
            socket.on('trip:complete', (data) => handleTripComplete(socket, data, io));
            socket.on('trip:cancel',   (data) => handleTripCancel(socket, data, io));
        }

        // ───────────────────────────────────────────────────────────
        // PASSENGER EVENTS
        // ───────────────────────────────────────────────────────────

        if (socket.userType === 'PASSENGER') {

            // ✅ FIX: Passenger trip cancel — was a TODO stub
            socket.on('trip:cancel', async (data) => {
                try {
                    const { tripId, reason } = data || {};
                    const userId = socket.userId;

                    console.log(`🚫 [SOCKET-PASSENGER] trip:cancel — tripId: ${tripId}`);

                    if (!tripId) {
                        return socket.emit('trip:cancel:error', { message: 'tripId is required' });
                    }

                    // Delegate to the shared cancel logic via HTTP-style call
                    // (reuse the same Redis + DB logic without duplicating it here)
                    const { redisHelpers: rh, REDIS_KEYS: RK } = require('../config/redis');
                    const { redisClient: rc } = require('../config/redis');
                    const tripData = await rh.getJson(RK.ACTIVE_TRIP(tripId));

                    if (!tripData) {
                        return socket.emit('trip:cancel:error', { message: 'Trip not found or already expired' });
                    }
                    if (tripData.passengerId !== userId) {
                        return socket.emit('trip:cancel:error', { message: 'Unauthorized' });
                    }

                    const cancelable = ['SEARCHING', 'MATCHED', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED'];
                    if (!cancelable.includes(tripData.status)) {
                        return socket.emit('trip:cancel:error', {
                            message: `Cannot cancel a trip that is already ${tripData.status}`
                        });
                    }

                    const cancelPayload = { tripId, canceledBy: 'PASSENGER', reason: reason || 'Passenger canceled' };

                    if (tripData.status === 'SEARCHING') {
                        // Not in DB yet — Redis only cleanup
                        await rc.del(RK.ACTIVE_TRIP(tripId));
                        await rc.del(`passenger:active_trip:${userId}`);
                        await rc.del(`trip:timeout:${tripId}`);
                    } else {
                        // In DB — update status
                        const { Trip: TripModel, TripEvent } = require('../models');
                        const dbTrip = await TripModel.findByPk(tripId);
                        if (dbTrip) {
                            dbTrip.status      = 'CANCELED';
                            dbTrip.canceledBy  = 'PASSENGER';
                            dbTrip.cancelReason = reason || null;
                            dbTrip.canceledAt  = new Date();
                            await dbTrip.save();

                            await rc.del(RK.ACTIVE_TRIP(tripId));
                            await rc.del(`passenger:active_trip:${userId}`);
                            if (dbTrip.driverId) {
                                await rc.del(`driver:active_trip:${dbTrip.driverId}`);
                                io.to(`driver:${dbTrip.driverId}`).emit('trip:canceled', cancelPayload);
                                io.to(`user:${dbTrip.driverId}`).emit('trip:canceled', cancelPayload);
                            }
                        }
                    }

                    socket.emit('trip:canceled', cancelPayload);
                    io.to(`passenger:${userId}`).emit('trip:canceled', cancelPayload);

                    console.log(`✅ [SOCKET-PASSENGER] Trip ${tripId} canceled`);

                } catch (err) {
                    console.error('❌ [SOCKET-PASSENGER] trip:cancel error:', err.message);
                    socket.emit('trip:cancel:error', { message: 'Failed to cancel trip', error: err.message });
                }
            });
        }

        // ───────────────────────────────────────────────────────────
        // CHAT EVENTS (DRIVER + PASSENGER)
        // ───────────────────────────────────────────────────────────

        socket.on('chat:send', async (data) => {
            try {
                const { tripId, text } = data || {};
                const userId = socket.userId;

                console.log(`\n💬 [CHAT] chat:send — trip: ${tripId} from: ${userId}`);

                if (!tripId || !text) {
                    return socket.emit('chat:error', { message: 'tripId and text are required' });
                }
                if (!text.trim()) {
                    return socket.emit('chat:error', { message: 'Message cannot be empty' });
                }
                if (text.length > 2000) {
                    return socket.emit('chat:error', { message: 'Message too long (max 2000 characters)' });
                }

                const trip = await Trip.findByPk(tripId);
                if (!trip) return socket.emit('chat:error', { message: 'Trip not found' });

                if (trip.driverId !== userId && trip.passengerId !== userId) {
                    return socket.emit('chat:error', { message: 'Unauthorized' });
                }

                const allowedStatuses = ['MATCHED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS'];
                if (!allowedStatuses.includes(trip.status)) {
                    return socket.emit('chat:error', { message: 'Chat is only available during active trips' });
                }

                const message = await ChatMessage.create({
                    tripId,
                    fromUserId: userId,
                    text: text.trim(),
                });

                const sender = await Account.findOne({
                    where:      { uuid: userId },
                    attributes: ['uuid', 'first_name', 'last_name', 'avatar_url', 'user_type'],
                });

                const recipientId = trip.driverId === userId ? trip.passengerId : trip.driverId;

                const messageData = {
                    id:         message.id,
                    tripId:     message.tripId,
                    text:       message.text,
                    fromUserId: message.fromUserId,
                    sender: sender ? {
                        uuid:     sender.uuid,
                        name:     `${sender.first_name} ${sender.last_name}`.trim(),
                        avatar:   sender.avatar_url,
                        userType: sender.user_type,
                    } : null,
                    readAt:    message.readAt,
                    createdAt: message.createdAt,
                };

                // Confirm to sender
                socket.emit('chat:message_sent', { success: true, message: messageData });

                // Deliver to recipient (user room + trip room)
                io.to(`user:${recipientId}`).emit('chat:new_message', { tripId, message: messageData });
                io.to(`trip:${tripId}`).emit('chat:new_message', { tripId, message: messageData });

                console.log(`✅ [CHAT] Message ${message.id} delivered to ${recipientId}`);

            } catch (error) {
                console.error('❌ [CHAT] chat:send error:', error.message);
                socket.emit('chat:error', { message: 'Failed to send message', error: error.message });
            }
        });

        // ── Typing indicator ──────────────────────────────────────
        socket.on('chat:typing', async (data) => {
            try {
                const { tripId, isTyping } = data || {};
                const userId = socket.userId;
                if (!tripId) return;

                const trip = await Trip.findByPk(tripId);
                if (!trip) return;
                if (trip.driverId !== userId && trip.passengerId !== userId) return;

                const recipientId = trip.driverId === userId ? trip.passengerId : trip.driverId;
                io.to(`user:${recipientId}`).emit('chat:typing', { tripId, userId, isTyping });

            } catch (error) {
                console.error('❌ [CHAT] chat:typing error:', error.message);
            }
        });

        // ── Mark messages read ────────────────────────────────────
        socket.on('chat:mark_read', async (data) => {
            try {
                const { tripId } = data || {};
                const userId = socket.userId;
                if (!tripId) return;

                const trip = await Trip.findByPk(tripId);
                if (!trip) return;
                if (trip.driverId !== userId && trip.passengerId !== userId) return;

                await ChatMessage.update(
                    { readAt: new Date() },
                    { where: { tripId, fromUserId: { [Op.ne]: userId }, readAt: null } }
                );

                const recipientId = trip.driverId === userId ? trip.passengerId : trip.driverId;
                io.to(`user:${recipientId}`).emit('chat:messages_read', {
                    tripId,
                    readBy:  userId,
                    readAt:  new Date(),
                });

                console.log(`✅ [CHAT] Messages marked read — trip: ${tripId}`);

            } catch (error) {
                console.error('❌ [CHAT] chat:mark_read error:', error.message);
            }
        });

        // ── Join / leave trip chat room ───────────────────────────
        socket.on('chat:join', async (data) => {
            try {
                const { tripId } = data || {};
                const userId = socket.userId;
                if (!tripId) return socket.emit('chat:error', { message: 'tripId required' });

                const trip = await Trip.findByPk(tripId);
                if (!trip) return socket.emit('chat:error', { message: 'Trip not found' });
                if (trip.driverId !== userId && trip.passengerId !== userId) {
                    return socket.emit('chat:error', { message: 'Unauthorized' });
                }

                socket.join(`trip:${tripId}`);
                socket.emit('chat:joined', { tripId, success: true });
                console.log(`✅ [CHAT] ${userId} joined trip:${tripId}`);

            } catch (error) {
                console.error('❌ [CHAT] chat:join error:', error.message);
                socket.emit('chat:error', { message: 'Failed to join chat', error: error.message });
            }
        });

        socket.on('chat:leave', (data) => {
            const { tripId } = data || {};
            if (!tripId) return;
            socket.leave(`trip:${tripId}`);
            socket.emit('chat:left', { tripId, success: true });
        });

        // ───────────────────────────────────────────────────────────
        // UTILITY EVENTS
        // ───────────────────────────────────────────────────────────

        socket.on('ping', () => {
            socket.emit('pong', { timestamp: new Date().toISOString() });
        });

        socket.on('connection:test', () => {
            socket.emit('connection:test:response', {
                socketId:  socket.id,
                userId:    socket.userId,
                userType:  socket.userType,
                connected: true,
                timestamp: new Date().toISOString(),
            });
        });

        // ───────────────────────────────────────────────────────────
        // DISCONNECT
        // ───────────────────────────────────────────────────────────

        socket.on('disconnect', async (reason) => {
            console.log(`\n❌ [SOCKET] Disconnected — ${socket.userId} (${reason})`);

            try {
                await removeUserSocket(socket.userId);
            } catch (e) {
                console.warn('⚠️  [SOCKET] removeUserSocket failed:', e.message);
            }

            if (socket.userType === 'DRIVER') {
                try {
                    await setDriverOffline(socket.userId);
                    console.log(`🔴 [SOCKET] Driver ${socket.userId} marked offline`);
                } catch (error) {
                    console.error('❌ [SOCKET] setDriverOffline error:', error.message);
                }
            }
        });

        socket.on('error', (error) => {
            console.error('❌ [SOCKET] Socket error:', error);
        });
    });

    return io;
}

// ═══════════════════════════════════════════════════════════════════════
// RECONNECT REPLAY — DRIVER
// ✅ FIX: Re-emits any pending offer or active trip so a reconnecting
//         driver's UI recovers without restarting the app.
// ═══════════════════════════════════════════════════════════════════════

async function _replayMissedDriverEvents(socket) {
    const driverId = socket.userId;
    console.log(`🔄 [SOCKET] Replaying missed events for driver ${driverId}`);

    try {
        // Check if driver has a pending offer in their queue
        const pendingOffers = await redisHelpers.getJson(`driver:pending_offers:${driverId}`) || [];
        if (Array.isArray(pendingOffers) && pendingOffers.length > 0) {
            for (const offer of pendingOffers) {
                // Make sure the trip still exists and is still SEARCHING
                const tripData = await redisHelpers.getJson(REDIS_KEYS.ACTIVE_TRIP(offer.tripId));
                if (tripData && tripData.status === 'SEARCHING') {
                    socket.emit('trip:new_request', offer);
                    console.log(`✅ [SOCKET] Re-sent pending offer ${offer.tripId} to driver ${driverId}`);
                }
            }
        }

        // Check if driver has an active trip in progress
        const activeTrip = await redisHelpers.getJson(`driver:active_trip:${driverId}`);
        if (activeTrip && activeTrip.tripId) {
            const tripData = await redisHelpers.getJson(REDIS_KEYS.ACTIVE_TRIP(activeTrip.tripId));
            if (tripData && tripData.status !== 'COMPLETED' && tripData.status !== 'CANCELED') {
                socket.emit('trip:state_sync', {
                    tripId:    activeTrip.tripId,
                    status:    tripData.status,
                    trip:      tripData,
                    timestamp: new Date().toISOString(),
                });
                console.log(`✅ [SOCKET] Re-synced active trip ${activeTrip.tripId} to driver ${driverId}`);
            }
        }

    } catch (error) {
        console.warn(`⚠️  [SOCKET] Driver replay failed for ${driverId}:`, error.message);
    }
}

// ═══════════════════════════════════════════════════════════════════════
// RECONNECT REPLAY — PASSENGER
// ✅ FIX: Re-emits current trip status on reconnect so passenger
//         doesn't stay stuck on "Searching..." after background/kill.
// ═══════════════════════════════════════════════════════════════════════

async function _replayMissedPassengerEvents(socket) {
    const passengerId = socket.userId;
    console.log(`🔄 [SOCKET] Replaying missed events for passenger ${passengerId}`);

    try {
        const activeTripRef = await redisHelpers.getJson(`passenger:active_trip:${passengerId}`);
        if (!activeTripRef || !activeTripRef.tripId) return;

        const tripData = await redisHelpers.getJson(REDIS_KEYS.ACTIVE_TRIP(activeTripRef.tripId));
        if (!tripData) return;

        if (tripData.status === 'SEARCHING') {
            // Still searching — remind them
            socket.emit('trip:state_sync', {
                tripId:    activeTripRef.tripId,
                status:    'SEARCHING',
                trip:      tripData,
                timestamp: new Date().toISOString(),
            });
        } else if (['MATCHED', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS'].includes(tripData.status)) {
            // Driver already assigned — re-send assignment event
            socket.emit('trip:driver_assigned', {
                tripId:    activeTripRef.tripId,
                driverId:  tripData.driverId,
                trip:      tripData,
                timestamp: new Date().toISOString(),
            });
        }

        console.log(`✅ [SOCKET] Re-synced trip ${activeTripRef.tripId} to passenger ${passengerId}`);

    } catch (error) {
        console.warn(`⚠️  [SOCKET] Passenger replay failed for ${passengerId}:`, error.message);
    }
}

// ═══════════════════════════════════════════════════════════════════════
// GET IO INSTANCE
// ═══════════════════════════════════════════════════════════════════════

function getIO() {
    if (!io) throw new Error('Socket.IO not initiadlised — call setupSocketIO first');
    return io;
}

// ═══════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════

module.exports        = setupSocketIO;
module.exports.getIO  = getIO;