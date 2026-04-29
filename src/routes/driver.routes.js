// src/routes/driver.routes.js

const express = require('express');
const router = express.Router();

// ═══════════════════════════════════════════════════════════════════════
// MIDDLEWARE IMPORTS
// ═══════════════════════════════════════════════════════════════════════

const { authenticate } = require('../middleware/auth.middleware');
const { requireDriver, requireDriverAny } = require('../middleware/driver.middleware');

// ═══════════════════════════════════════════════════════════════════════
// CONTROLLER IMPORT
// ═══════════════════════════════════════════════════════════════════════

const driverController = require('../controllers/driver.controller');

// ═══════════════════════════════════════════════════════════════════════
// DRIVER STATUS ROUTES
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   PUT /api/driver/status
 * @desc    Toggle online/offline — accepts { status: 'online' | 'offline' }
 *          Used by DeliveryAgentDashboard and DriverDashboard Flutter screens.
 *          Works for both DRIVER and DELIVERY_AGENT user types.
 * @access  Private (DRIVER or DELIVERY_AGENT)
 * @body    { status: 'online' | 'offline', lat?: number, lng?: number }
 */
router.put('/status', authenticate, requireDriver, driverController.setStatus);

/**
 * @route   POST /api/driver/online
 * @desc    Set driver status to ONLINE (available for trips)
 * @access  Private (Active Drivers only)
 * @body    { lat: number, lng: number, heading?: number }
 */
router.post('/online', authenticate, requireDriver, driverController.goOnline);

/**
 * @route   POST /api/driver/offline
 * @desc    Set driver status to OFFLINE (unavailable for trips)
 * @access  Private (Active Drivers only)
 */
router.post('/offline', authenticate, requireDriver, driverController.goOffline);

/**
 * @route   POST /api/driver/location
 * @desc    Update driver's current location
 * @access  Private (Active Drivers only)
 * @body    { lat: number, lng: number, heading?: number, speed?: number }
 */
router.post('/location', authenticate, requireDriver, driverController.updateLocation);

/**
 * @route   GET /api/driver/status
 * @desc    Get driver's current online/offline status
 * @access  Private (Any Driver)
 */
router.get('/status', authenticate, requireDriverAny, driverController.getStatus);

// ═══════════════════════════════════════════════════════════════════════
// TRIP MANAGEMENT ROUTES
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   GET /api/driver/current-trip
 * @desc    Get driver's current active trip
 * @access  Private (Active Drivers only)
 */
router.get('/current-trip', authenticate, requireDriver, driverController.getCurrentTrip);

/**
 * @route   POST /api/driver/trips/:tripId/accept
 * @desc    Accept a trip offer
 * @access  Private (Active Drivers only)
 */
router.post('/trips/:tripId/accept', authenticate, requireDriver, driverController.acceptTrip);

/**
 * @route   POST /api/driver/trips/:tripId/decline
 * @desc    Decline a trip offer
 * @access  Private (Active Drivers only)
 */
router.post('/trips/:tripId/decline', authenticate, requireDriver, driverController.declineTrip);

/**
 * @route   POST /api/driver/trips/:tripId/arrived
 * @desc    Mark driver as arrived at pickup location
 * @access  Private (Active Drivers only)
 */
router.post('/trips/:tripId/arrived', authenticate, requireDriver, driverController.arrivedAtPickup);

/**
 * @route   POST /api/driver/trips/:tripId/start
 * @desc    Start trip (passenger on board)
 * @access  Private (Active Drivers only)
 */
router.post('/trips/:tripId/start', authenticate, requireDriver, driverController.startTrip);

/**
 * @route   POST /api/driver/trips/:tripId/complete
 * @desc    Complete trip (arrived at destination)
 * @access  Private (Active Drivers only)
 * @body    { final_fare?: number, distance_traveled?: number, duration_seconds?: number }
 */
router.post('/trips/:tripId/complete', authenticate, requireDriver, driverController.completeTrip);

/**
 * @route   POST /api/driver/trips/:tripId/cancel
 * @desc    Cancel a trip
 * @access  Private (Active Drivers only)
 * @body    { reason: string, waitingTime?: number }
 */
router.post('/trips/:tripId/cancel', authenticate, requireDriver, driverController.cancelTrip);

/**
 * @route   POST /api/driver/trips/:tripId/no-show
 * @desc    Report passenger no-show (passenger didn't arrive after waiting)
 * @access  Private (Active Drivers only)
 * @body    { waitingTime: number, reason?: string }
 */
router.post('/trips/:tripId/no-show', authenticate, requireDriver, driverController.reportNoShow);

// ═══════════════════════════════════════════════════════════════════════
// STATS & HISTORY ROUTES
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   GET /api/driver/stats
 * @desc    Get driver statistics (today, week, total trips & earnings)
 * @access  Private (Any Driver)
 */
router.get('/stats', authenticate, requireDriverAny, driverController.getStats);

/**
 * @route   GET /api/driver/earnings
 * @desc    Get detailed earnings breakdown
 * @access  Private (Any Driver)
 * @query   { period?: 'today' | 'week' | 'month' | 'all' }
 */
router.get('/earnings', authenticate, requireDriverAny, driverController.getEarnings);

/**
 * @route   GET /api/driver/trips/history
 * @desc    Get paginated trip history
 * @access  Private (Any Driver)
 * @query   { page?: number, limit?: number, status?: string }
 */
router.get('/trips/history', authenticate, requireDriverAny, driverController.getTripHistory);


router.get('/trips', authenticate, requireDriverAny, driverController.getAllTrips);
/**
 * @route   GET /api/driver/trips/:tripId
 * @desc    Get details of a specific trip
 * @access  Private (Any Driver)
 */
router.get('/trips/:tripId', authenticate, requireDriverAny, driverController.getTripDetails);

// ═══════════════════════════════════════════════════════════════════════
// DRIVER PROFILE ROUTES
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   GET /api/driver/profile
 * @desc    Get driver profile information
 * @access  Private (Any Driver)
 */
router.get('/profile', authenticate, requireDriverAny, driverController.getProfile);

/**
 * @route   PUT /api/driver/profile
 * @desc    Update driver profile
 * @access  Private (Any Driver)
 * @body    { phone?: string, emergency_contact?: string, etc. }
 */
router.put('/profile', authenticate, requireDriverAny, driverController.updateProfile);

/**
 * @route   GET /api/driver/ratings
 * @desc    Get driver ratings and reviews
 * @access  Private (Any Driver)
 */
router.get('/ratings', authenticate, requireDriverAny, driverController.getRatings);

// ═══════════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   GET /api/driver/health
 * @desc    Health check endpoint
 * @access  Public
 */
router.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        message: 'Driver API is running',
        timestamp: new Date().toISOString(),
    });
});

// ═══════════════════════════════════════════════════════════════════════
// ERROR HANDLING
// ═══════════════════════════════════════════════════════════════════════

// 404 handler for undefined driver routes
// 🩵 Using no path argument avoids path-to-regexp crash
router.use((req, res) => {
    console.log(`❌ [DRIVER-ROUTES] 404 - Route not found: ${req.method} ${req.originalUrl}`);
    res.status(404).json({
        error: 'Not Found',
        message: 'The requested driver endpoint does not exist',
        path: req.originalUrl,
    });
});

// ═══════════════════════════════════════════════════════════════════════
// EXPORT ROUTER
// ═══════════════════════════════════════════════════════════════════════

module.exports = router;