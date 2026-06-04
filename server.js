// server.js (in root directory - wegobackend/server.js)

const path = require('path');
require('dotenv').config({
    path:     path.resolve(__dirname, '.env'),
    override: true,
});

const http    = require('http');
const admin   = require('firebase-admin');
const { sequelize } = require('./src/models');
const { initEmail } = require('./src/services/comm/email.service');
const app     = require('./src/app');

const PORT     = process.env.PORT     || 4000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// ═══════════════════════════════════════════════════════════════════════
// CREATE SERVER
// ═══════════════════════════════════════════════════════════════════════

const server = http.createServer(app);

// ═══════════════════════════════════════════════════════════════════════
// INITIALIZE SOCKET.IO
// ═══════════════════════════════════════════════════════════════════════

const setupSocketIO    = require('./src/sockets');
const io               = setupSocketIO(server);
const { setIO }        = require('./src/sockets/exports');
setIO(io);
app.set('io', io);

app.use((req, res, next) => {
    req.io = io;
    next();
});

// ═══════════════════════════════════════════════════════════════════════
// FIREBASE ADMIN INITIALISATION
// ═══════════════════════════════════════════════════════════════════════
//
// Uses the google-services.json / service account key in the project root.
// NotificationService.js checks admin.apps.length before using messaging()
// so if this fails it degrades gracefully — pushes are skipped, DB rows
// are still written.
//
// The service account key path can be overridden via env:
//   FIREBASE_SERVICE_ACCOUNT_PATH=./path/to/serviceAccountKey.json
//
// ═══════════════════════════════════════════════════════════════════════

function initFirebaseAdmin() {
    try {
        if (admin.apps.length > 0) {
            console.log('ℹ️  [FIREBASE] Already initialized — skipping');
            return;
        }

        const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
            || path.resolve(__dirname, 'google-services.json');

        // eslint-disable-next-line import/no-dynamic-require
        const serviceAccount = require(serviceAccountPath);

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
        });

        console.log('✅ [FIREBASE] Admin SDK initialized');
        console.log('   Project:', serviceAccount.project_id || 'unknown');

    } catch (error) {
        // Non-fatal — server continues, push notifications are skipped
        console.error('❌ [FIREBASE] Admin init failed:', error.message);
        console.warn('⚠️  [FIREBASE] Push notifications will be disabled');
    }
}

// ═══════════════════════════════════════════════════════════════════════
// STARTUP SEQUENCE
// ═══════════════════════════════════════════════════════════════════════

const startServer = async () => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🚀 WEGO API - Starting up...');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        // ── Step 1: Database Connection ───────────────────────────────
        console.log('🔄 [STARTUP] Connecting to database...');
        await sequelize.authenticate();
        console.log('✅ [STARTUP] Database connected successfully');
        console.log('   Host:    ', process.env.DB_HOST);
        console.log('   Database:', process.env.DB_NAME);
        console.log('   Port:    ', process.env.DB_PORT);

        // ── Step 2: Database Synchronization ──────────────────────────
        console.log('\n🔄 [STARTUP] Synchronizing database models...');
        await sequelize.sync({ alter: false });
        console.log('✅ [STARTUP] Database models synchronized');

        // ── Step 3: Email Service ─────────────────────────────────────
        console.log('\n🔄 [STARTUP] Initializing email service...');
        await initEmail();
        console.log('✅ [STARTUP] Email service initialized');
        console.log('   Provider:', process.env.EMAIL_PROVIDER || 'SMTP');
        console.log('   From:    ', process.env.EMAIL_FROM);

        // ── Step 4: Firebase Admin ────────────────────────────────────
        console.log('\n🔄 [STARTUP] Initializing Firebase Admin SDK...');
        initFirebaseAdmin();

        // ── Step 5: Notification Cleaner Cron ─────────────────────────
        console.log('\n🔄 [STARTUP] Starting notification cleaner jobs...');
        const { startNotificationCleaner } = require('./src/jobs/notification_cleaner');
        startNotificationCleaner();

        // ── Step 6: Start HTTP Server ─────────────────────────────────
        console.log('\n🔄 [STARTUP] Starting HTTP server...');
        server.listen(PORT, () => {
            console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('✅ WEGO API - Server Running Successfully!');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log(`🌍 Environment : ${NODE_ENV}`);
            console.log(`🚀 Server      : http://localhost:${PORT}`);
            console.log(`📡 Socket.IO   : Ready for connections`);
            console.log(`📂 Uploads     : http://localhost:${PORT}/uploads`);
            console.log(`🗄️  Database    : ${process.env.DB_NAME}`);
            console.log(`📧 Email       : ${process.env.EMAIL_PROVIDER || 'SMTP'}`);
            console.log(`🔔 Firebase    : ${admin.apps.length > 0 ? 'Ready' : 'Disabled'}`);
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('\n📋 Available Routes:');
            console.log('   POST   /api/auth/register');
            console.log('   POST   /api/auth/login');
            console.log('   POST   /api/auth/verify-otp');
            console.log('   POST   /api/driver/online');
            console.log('   POST   /api/driver/offline');
            console.log('   GET    /api/driver/stats');
            console.log('   POST   /api/trips/request');
            console.log('   POST   /api/device-tokens');
            console.log('   DELETE /api/device-tokens');
            console.log('   GET    /api/notifications');
            console.log('   GET    /api/notifications/unread-count');
            console.log('   PATCH  /api/notifications/:id/read');
            console.log('   PATCH  /api/notifications/read-all');
            console.log('   POST   /api/backoffice/broadcasts');
            console.log('   GET    /api/backoffice/broadcasts');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        });

    } catch (error) {
        console.error('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ [STARTUP] Server startup failed!');
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('Error:', error.message);
        console.error('Stack:', error.stack);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        try {
            await sequelize.close();
            console.log('🔌 Database connection closed');
        } catch (closeError) {
            console.error('❌ Error closing database:', closeError.message);
        }

        process.exit(1);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════════════

const gracefulShutdown = async (signal) => {
    console.log(`\n\n📴 [SHUTDOWN] ${signal} received, starting shutdown...`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
        console.log('🔄 [SHUTDOWN] Closing server...');
        server.close(() => console.log('✅ [SHUTDOWN] Server closed'));

        console.log('🔄 [SHUTDOWN] Closing Socket.IO connections...');
        io.close(() => console.log('✅ [SHUTDOWN] Socket.IO closed'));

        console.log('🔄 [SHUTDOWN] Closing database connection...');
        await sequelize.close();
        console.log('✅ [SHUTDOWN] Database connection closed');

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ [SHUTDOWN] Graceful shutdown complete');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        process.exit(0);

    } catch (error) {
        console.error('❌ [SHUTDOWN] Error during shutdown:', error.message);
        process.exit(1);
    }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
    console.error('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('❌ [FATAL] Uncaught Exception!');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('❌ [FATAL] Unhandled Promise Rejection!');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('Reason:  ', reason);
    console.error('Promise: ', promise);
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    process.exit(1);
});

// ═══════════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════════

startServer();

module.exports = { server, io, app };