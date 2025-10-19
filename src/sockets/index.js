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
    handleDriverEnRoute,      // ✅ ADDED: Import the new handler
    handleDriverArrived,
    handleTripStart,
    handleTripComplete,
    handleTripCancel,
} = require('./driverHandlers');

// ═══════════════════════════════════════════════════════════════════════
// SOCKET.IO SETUP
// ═══════════════════════════════════════════════════════════════════════

function setupSocketIO(server) {
    const io = new Server(server, {
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
                handleDriverLocationUpdate(socket, data, io);  // ✅ FIXED: Added io parameter
            });

            socket.on('driver:location_update', (data) => {
                handleDriverLocationUpdate(socket, data, io);  // ✅ FIXED: Added io parameter
            });

            // Trip actions
            socket.on('trip:accept', (data) => {
                handleTripAccept(socket, data, io);
            });

            socket.on('trip:decline', (data) => {
                handleTripDecline(socket, data);
            });

            // ✅ CORRECT: Driver en route event
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
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════

module.exports = setupSocketIO;