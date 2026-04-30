// src/routes/driver.routes.js

const express = require('express');
const router  = express.Router();

const { authenticate }                                             = require('../middleware/auth.middleware');
const { requireActiveDriver, requireDriver, requireDriverAny }    = require('../middleware/driver.middleware');

const driverController = require('../controllers/driver.controller');

// ═══════════════════════════════════════════════════════════════════════
// DRIVER STATUS ROUTES
// ═══════════════════════════════════════════════════════════════════════
//
// online / offline / location / status are SHARED between ride-hailing
// drivers and delivery agents — both verticals use the same Redis
// geo-index and socket infrastructure.
//
// requireActiveDriver accepts:
//   - DRIVER in DRIVER mode
//   - DRIVER in DELIVERY_AGENT mode  (driver switched to delivery)
//   - DELIVERY_AGENT in DELIVERY_AGENT mode
//   Blocks anyone in PASSENGER mode.
//
// ───────────────────────────────────────────────────────────────────────

/**
 * @route   PUT /api/driver/status
 * @desc    Toggle online/offline — { status: 'online' | 'offline' }
 * @access  Private (DRIVER or DELIVERY_AGENT, not in PASSENGER mode)
 */
router.put('/status', authenticate, requireActiveDriver, driverController.setStatus);

/**
 * @route   POST /api/driver/online
 * @desc    Set status to ONLINE (available for trips or deliveries)
 * @access  Private (DRIVER or DELIVERY_AGENT, not in PASSENGER mode)
 * @body    { lat, lng, heading? }
 */
router.post('/online', authenticate, requireActiveDriver, driverController.goOnline);

/**
 * @route   POST /api/driver/offline
 * @desc    Set status to OFFLINE
 * @access  Private (DRIVER or DELIVERY_AGENT, not in PASSENGER mode)
 */
router.post('/offline', authenticate, requireActiveDriver, driverController.goOffline);

/**
 * @route   POST /api/driver/location
 * @desc    Update current GPS location
 * @access  Private (DRIVER or DELIVERY_AGENT, not in PASSENGER mode)
 * @body    { lat, lng, heading?, speed? }
 */
router.post('/location', authenticate, requireActiveDriver, driverController.updateLocation);

/**
 * @route   GET /api/driver/status
 * @desc    Get current online/offline status
 * @access  Private (Any driver or delivery agent, any mode)
 */
router.get('/status', authenticate, requireDriverAny, driverController.getStatus);

// ═══════════════════════════════════════════════════════════════════════
// WALLET ROUTE
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   GET /api/driver/wallet
 * @desc    Get wallet balance + period earnings breakdown.
 * @access  Private (Any driver or delivery agent, any mode)
 */
router.get('/wallet', authenticate, requireDriverAny, driverController.getWalletBalance);

// ═══════════════════════════════════════════════════════════════════════
// TRIP MANAGEMENT ROUTES  (ride-hailing ONLY)
// ═══════════════════════════════════════════════════════════════════════
//
// requireDriver accepts DRIVER in DRIVER mode only.
// A driver who switched to PASSENGER or DELIVERY_AGENT mode cannot
// interact with these endpoints.
//
// ───────────────────────────────────────────────────────────────────────

/**
 * @route   GET /api/driver/current-trip
 * @desc    Get driver's current active trip
 * @access  Private (DRIVER in DRIVER mode)
 */
router.get('/current-trip', authenticate, requireDriver, driverController.getCurrentTrip);

/**
 * @route   POST /api/driver/trips/:tripId/accept
 * @desc    Accept a trip offer
 * @access  Private (DRIVER in DRIVER mode)
 */
router.post('/trips/:tripId/accept', authenticate, requireDriver, driverController.acceptTrip);

/**
 * @route   POST /api/driver/trips/:tripId/decline
 * @desc    Decline a trip offer
 * @access  Private (DRIVER in DRIVER mode)
 */
router.post('/trips/:tripId/decline', authenticate, requireDriver, driverController.declineTrip);

/**
 * @route   POST /api/driver/trips/:tripId/arrived
 * @desc    Mark arrived at pickup location
 * @access  Private (DRIVER in DRIVER mode)
 */
router.post('/trips/:tripId/arrived', authenticate, requireDriver, driverController.arrivedAtPickup);

/**
 * @route   POST /api/driver/trips/:tripId/start
 * @desc    Start trip (passenger on board)
 * @access  Private (DRIVER in DRIVER mode)
 */
router.post('/trips/:tripId/start', authenticate, requireDriver, driverController.startTrip);

/**
 * @route   POST /api/driver/trips/:tripId/complete
 * @desc    Complete trip (arrived at destination)
 * @access  Private (DRIVER in DRIVER mode)
 * @body    { final_fare?, distance_traveled?, duration_seconds? }
 */
router.post('/trips/:tripId/complete', authenticate, requireDriver, driverController.completeTrip);

/**
 * @route   POST /api/driver/trips/:tripId/cancel
 * @desc    Cancel a trip
 * @access  Private (DRIVER in DRIVER mode)
 * @body    { reason }
 */
router.post('/trips/:tripId/cancel', authenticate, requireDriver, driverController.cancelTrip);

/**
 * @route   POST /api/driver/trips/:tripId/no-show
 * @desc    Report passenger no-show
 * @access  Private (DRIVER in DRIVER mode)
 * @body    { waitingTime, reason? }
 */
router.post('/trips/:tripId/no-show', authenticate, requireDriver, driverController.reportNoShow);

// ═══════════════════════════════════════════════════════════════════════
// STATS & HISTORY ROUTES  (read-only — any mode)
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   GET /api/driver/stats
 * @desc    Driver statistics (today, week, total trips & earnings)
 * @access  Private (Any driver or delivery agent, any mode)
 */
router.get('/stats', authenticate, requireDriverAny, driverController.getStats);

/**
 * @route   GET /api/driver/earnings
 * @desc    Detailed earnings breakdown
 * @access  Private (Any driver or delivery agent, any mode)
 * @query   { period?: 'today' | 'week' | 'month' | 'all' }
 */
router.get('/earnings', authenticate, requireDriverAny, driverController.getEarnings);

/**
 * @route   GET /api/driver/trips/history
 * @desc    Paginated trip history
 * @access  Private (Any driver or delivery agent, any mode)
 * @query   { page?, limit?, status? }
 */
router.get('/trips/history', authenticate, requireDriverAny, driverController.getTripHistory);

/**
 * @route   GET /api/driver/trips
 * @desc    All trips with filters
 * @access  Private (Any driver or delivery agent, any mode)
 */
router.get('/trips', authenticate, requireDriverAny, driverController.getAllTrips);

/**
 * @route   GET /api/driver/trips/:tripId
 * @desc    Details of a specific trip
 * @access  Private (Any driver or delivery agent, any mode)
 */
router.get('/trips/:tripId', authenticate, requireDriverAny, driverController.getTripDetails);

// ═══════════════════════════════════════════════════════════════════════
// PROFILE ROUTES  (read-only — any mode)
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   GET /api/driver/profile
 * @desc    Get profile information
 * @access  Private (Any driver or delivery agent, any mode)
 */
router.get('/profile', authenticate, requireDriverAny, driverController.getProfile);

/**
 * @route   PUT /api/driver/profile
 * @desc    Update profile
 * @access  Private (Any driver or delivery agent, any mode)
 */
router.put('/profile', authenticate, requireDriverAny, driverController.updateProfile);

/**
 * @route   GET /api/driver/ratings
 * @desc    Ratings and reviews
 * @access  Private (Any driver or delivery agent, any mode)
 */
router.get('/ratings', authenticate, requireDriverAny, driverController.getRatings);

// ═══════════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════════

router.get('/health', (req, res) => {
    res.status(200).json({
        status:    'ok',
        message:   'Driver API is running',
        timestamp: new Date().toISOString(),
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 404 HANDLER
// ═══════════════════════════════════════════════════════════════════════

router.use((req, res) => {
    console.log(`❌ [DRIVER-ROUTES] 404 — ${req.method} ${req.originalUrl}`);
    res.status(404).json({
        error:   'Not Found',
        message: 'The requested driver endpoint does not exist',
        path:    req.originalUrl,
    });
});

module.exports = router;