// src/middleware/driver.middleware.js
//
// ═══════════════════════════════════════════════════════════════════════
// DRIVER MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════
//
// Three middleware tiers — choose based on what the endpoint does:
//
// ┌─────────────────────────────────────────────────────────────────────┐
// │  requireActiveDriver   — shared active endpoints                    │
// │                          online / offline / location / status       │
// │                          Accepts: DRIVER in DRIVER mode             │
// │                                   DELIVERY_AGENT in DELIVERY_AGENT  │
// │                                   mode (or mode not yet set)        │
// │                          Blocks:  Anyone in PASSENGER mode          │
// ├─────────────────────────────────────────────────────────────────────┤
// │  requireDriver         — ride-hailing ONLY active endpoints         │
// │                          acceptTrip / startTrip / completeTrip etc. │
// │                          Accepts: DRIVER in DRIVER mode only        │
// │                          Blocks:  DRIVER in PASSENGER/DELIVERY mode │
// │                          Blocks:  DELIVERY_AGENT (wrong user_type)  │
// ├─────────────────────────────────────────────────────────────────────┤
// │  requireDeliveryAgent  — delivery ONLY active endpoints             │
// │                          acceptDelivery / updateDeliveryStatus etc. │
// │                          Accepts: DELIVERY_AGENT in delivery mode   │
// │                                   DRIVER in DELIVERY_AGENT mode     │
// │                          Blocks:  Anyone in PASSENGER mode          │
// ├─────────────────────────────────────────────────────────────────────┤
// │  requireDriverAny      — read-only endpoints, no mode restriction   │
// │                          profile / history / earnings / ratings      │
// │                          Accepts: DRIVER or DELIVERY_AGENT          │
// │                                   any mode, any status              │
// └─────────────────────────────────────────────────────────────────────┘
//
// ═══════════════════════════════════════════════════════════════════════

// ─── Shared status check helper ───────────────────────────────────────
function _checkActiveStatus(req, res, label) {
    if (req.user.status === 'PENDING') {
        return res.status(403).json({
            error:     'Account pending approval',
            message:   'Your account is pending admin approval.',
            code:      'DRIVER_PENDING',
            isPending: true,
        });
    }
    if (req.user.status === 'SUSPENDED') {
        return res.status(403).json({
            error:   'Account suspended',
            message: 'Your account has been suspended. Please contact support.',
            code:    'DRIVER_SUSPENDED',
        });
    }
    if (req.user.status === 'DELETED') {
        return res.status(403).json({
            error:   'Account deleted',
            message: 'This account has been deleted.',
            code:    'DRIVER_DELETED',
        });
    }
    if (req.user.status !== 'ACTIVE') {
        return res.status(403).json({
            error:   'Account not active',
            message: 'Your account is not active',
            code:    'DRIVER_NOT_ACTIVE',
        });
    }
    return null; // no error
}

// ═══════════════════════════════════════════════════════════════════════
// requireActiveDriver
// ─────────────────────────────────────────────────────────────────────
// Used for: POST /online, POST /offline, POST /location, GET /status
// PUT /status
//
// These endpoints are shared by both ride-hailing drivers and delivery
// agents — both verticals use the same Redis geo-index for their online
// presence and GPS tracking.
//
// Accepts:
//   - user_type === 'DRIVER' with active_mode === 'DRIVER'
//   - user_type === 'DELIVERY_AGENT' with active_mode === 'DELIVERY_AGENT'
//     (or active_mode not yet set — treated as their natural mode)
//   - user_type === 'DRIVER' with active_mode === 'DELIVERY_AGENT'
//     (driver who switched to delivery mode going online for deliveries)
//
// Blocks:
//   - Anyone in PASSENGER mode (they should not be in the driver geo-index)
//   - PASSENGER user_type
// ═══════════════════════════════════════════════════════════════════════

const requireActiveDriver = async (req, res, next) => {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🚦 [ACTIVE-DRIVER-MW] Checking active driver/agent authorization');

        if (!req.user || !req.user.uuid) {
            return res.status(401).json({
                error:   'Authentication required',
                message: 'You must be logged in to access this resource',
            });
        }

        const userType   = req.user.user_type;
        const activeMode = req.auth?.active_mode;

        console.log('   UUID       :', req.user.uuid);
        console.log('   user_type  :', userType);
        console.log('   active_mode:', activeMode || '(not set)');
        console.log('   status     :', req.user.status);

        // ── Must be a driver or delivery agent ────────────────────────
        if (userType !== 'DRIVER' && userType !== 'DELIVERY_AGENT') {
            console.log('❌ [ACTIVE-DRIVER-MW] Not a driver or delivery agent:', userType);
            return res.status(403).json({
                error:   'Access denied',
                message: 'This resource is only available to drivers and delivery agents',
                code:    'NOT_A_DRIVER',
            });
        }

        // ── Block PASSENGER mode — a driver/agent in passenger mode ───
        // should not be registering in the geo-index or receiving jobs.
        if (activeMode === 'PASSENGER') {
            console.log('❌ [ACTIVE-DRIVER-MW] User is in PASSENGER mode');
            return res.status(403).json({
                error:       'Wrong mode',
                message:     'You are in Passenger mode. Switch to Driver or Delivery Agent mode to go online.',
                code:        'WRONG_MODE',
                active_mode: activeMode,
            });
        }

        // ── Account status ────────────────────────────────────────────
        const statusError = _checkActiveStatus(req, res, 'ACTIVE-DRIVER-MW');
        if (statusError) return statusError;

        console.log('✅ [ACTIVE-DRIVER-MW] Authorized — user_type:', userType, '| mode:', activeMode);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        next();

    } catch (error) {
        console.error('❌ [ACTIVE-DRIVER-MW ERROR]:', error.message);
        return res.status(500).json({
            error:   'Server error',
            message: 'An error occurred while verifying authorization',
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// requireDriver
// ─────────────────────────────────────────────────────────────────────
// Used for: acceptTrip, declineTrip, arrivedAtPickup, startTrip,
//           completeTrip, cancelTrip, no-show, current-trip
//
// Ride-hailing ONLY. A driver who switched to delivery or passenger
// mode cannot accept or manage trips.
//
// Accepts:
//   - user_type === 'DRIVER' AND active_mode === 'DRIVER'
//
// Blocks:
//   - DRIVER in PASSENGER mode
//   - DRIVER in DELIVERY_AGENT mode
//   - DELIVERY_AGENT (wrong user_type for ride-hailing)
// ═══════════════════════════════════════════════════════════════════════

const requireDriver = async (req, res, next) => {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🚗 [DRIVER-MW] Checking ride-hailing driver authorization');

        if (!req.user || !req.user.uuid) {
            return res.status(401).json({
                error:   'Authentication required',
                message: 'You must be logged in to access this resource',
            });
        }

        const userType   = req.user.user_type;
        const activeMode = req.auth?.active_mode;

        console.log('   UUID       :', req.user.uuid);
        console.log('   user_type  :', userType);
        console.log('   active_mode:', activeMode || '(not set)');
        console.log('   status     :', req.user.status);

        // ── Must be a DRIVER (not DELIVERY_AGENT) ─────────────────────
        if (userType !== 'DRIVER') {
            console.log('❌ [DRIVER-MW] user_type is not DRIVER:', userType);
            return res.status(403).json({
                error:   'Access denied',
                message: 'This resource is only available to drivers',
                code:    'NOT_A_DRIVER',
            });
        }

        // ── Must be in DRIVER mode ────────────────────────────────────
        // A driver who switched to PASSENGER or DELIVERY_AGENT mode
        // must not be able to interact with ride-hailing endpoints.
        if (activeMode && activeMode !== 'DRIVER') {
            console.log('❌ [DRIVER-MW] Driver is in', activeMode, 'mode — not DRIVER mode');
            return res.status(403).json({
                error:       'Wrong mode',
                message:     `You are in ${activeMode} mode. Switch to Driver mode to use this feature.`,
                code:        'WRONG_MODE',
                active_mode: activeMode,
            });
        }

        // ── Account status ────────────────────────────────────────────
        const statusError = _checkActiveStatus(req, res, 'DRIVER-MW');
        if (statusError) return statusError;

        console.log('✅ [DRIVER-MW] Authorized — DRIVER mode + ACTIVE status');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        next();

    } catch (error) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ [DRIVER-MW ERROR]:', error.message);
        console.error(error.stack);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        return res.status(500).json({
            error:   'Server error',
            message: 'An error occurred while verifying driver authorization',
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// requireDeliveryAgent
// ─────────────────────────────────────────────────────────────────────
// Used for: acceptDelivery, updateDeliveryStatus, delivery wallet, etc.
//
// Accepts:
//   - user_type === 'DELIVERY_AGENT' in delivery mode (or mode not set)
//   - user_type === 'DRIVER' with active_mode === 'DELIVERY_AGENT'
//
// Blocks:
//   - Anyone in PASSENGER mode
//   - DRIVER in DRIVER mode trying to reach delivery endpoints
// ═══════════════════════════════════════════════════════════════════════

const requireDeliveryAgent = async (req, res, next) => {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📦 [DELIVERY-MW] Checking delivery agent authorization');

        if (!req.user || !req.user.uuid) {
            return res.status(401).json({
                error:   'Authentication required',
                message: 'You must be logged in to access this resource',
            });
        }

        const userType   = req.user.user_type;
        const activeMode = req.auth?.active_mode;

        console.log('   user_type  :', userType);
        console.log('   active_mode:', activeMode || '(not set)');
        console.log('   status     :', req.user.status);

        // Two valid paths to delivery endpoints:
        //   1. Native DELIVERY_AGENT in delivery mode (or no mode set yet)
        //   2. DRIVER who switched to DELIVERY_AGENT mode
        const isNativeAgent    = userType === 'DELIVERY_AGENT';
        const isDriverSwitched = userType === 'DRIVER' && activeMode === 'DELIVERY_AGENT';

        if (!isNativeAgent && !isDriverSwitched) {
            console.log('❌ [DELIVERY-MW] Not authorized for delivery operations');
            return res.status(403).json({
                error:       'Access denied',
                message:     'This resource requires Delivery Agent mode.',
                code:        'NOT_A_DELIVERY_AGENT',
                active_mode: activeMode,
            });
        }

        // Native agent who switched to PASSENGER mode — blocked
        if (isNativeAgent && activeMode === 'PASSENGER') {
            console.log('❌ [DELIVERY-MW] DELIVERY_AGENT is in PASSENGER mode');
            return res.status(403).json({
                error:       'Wrong mode',
                message:     'You are in Passenger mode. Switch to Delivery Agent mode to use this feature.',
                code:        'WRONG_MODE',
                active_mode: activeMode,
            });
        }

        // ── Account status ────────────────────────────────────────────
        const statusError = _checkActiveStatus(req, res, 'DELIVERY-MW');
        if (statusError) return statusError;

        console.log('✅ [DELIVERY-MW] Authorized — delivery mode active');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        next();

    } catch (error) {
        console.error('❌ [DELIVERY-MW ERROR]:', error.message);
        return res.status(500).json({
            error:   'Server error',
            message: 'An error occurred while verifying delivery agent authorization',
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// requireDriverAny
// ─────────────────────────────────────────────────────────────────────
// Used for: profile, history, earnings, ratings, wallet balance, stats
//
// Read-only — mode and status don't matter.
// A driver in PASSENGER mode can still check their own history/balance.
// A delivery agent can still read their own profile.
// ═══════════════════════════════════════════════════════════════════════

const requireDriverAny = async (req, res, next) => {
    try {
        console.log('🚗 [DRIVER-MW-ANY] Checking driver/agent type (any mode, any status)');

        if (!req.user || !req.user.uuid) {
            return res.status(401).json({
                error:   'Authentication required',
                message: 'You must be logged in to access this resource',
            });
        }

        if (req.user.user_type !== 'DRIVER' && req.user.user_type !== 'DELIVERY_AGENT') {
            return res.status(403).json({
                error:   'Access denied',
                message: 'This resource is only available to drivers and delivery agents',
                code:    'NOT_A_DRIVER',
            });
        }

        console.log('✅ [DRIVER-MW-ANY] Authorized — type:', req.user.user_type, '| mode:', req.auth?.active_mode || 'N/A', '| status:', req.user.status);
        next();

    } catch (error) {
        console.error('❌ [DRIVER-MW-ANY ERROR]:', error.message);
        return res.status(500).json({
            error:   'Server error',
            message: 'An error occurred while verifying driver type',
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// requireOnline  (placeholder — unchanged)
// ═══════════════════════════════════════════════════════════════════════

const requireOnline = async (req, res, next) => {
    try {
        console.log('📡 [DRIVER-MW] Online check (TODO: implement from Redis)');
        next();
    } catch (error) {
        console.error('❌ [DRIVER-MW] Online check error:', error.message);
        return res.status(500).json({
            error:   'Server error',
            message: 'An error occurred while checking online status',
        });
    }
};

module.exports = {
    requireActiveDriver,   // ← NEW: shared online/offline/location/status
    requireDriver,         // ride-hailing only (DRIVER + DRIVER mode)
    requireDeliveryAgent,  // delivery only (DELIVERY_AGENT or DRIVER in delivery mode)
    requireDriverAny,      // read-only, any mode/status
    requireOnline,
};