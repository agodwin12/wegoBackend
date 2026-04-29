// src/middleware/driver.middleware.js

const { Account } = require('../models');

/**
 * Middleware to verify that the authenticated user is a DRIVER or DELIVERY_AGENT
 * Must be used AFTER auth.middleware.js (requireAuth)
 */
const requireDriver = async (req, res, next) => {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🚗 [DRIVER-MIDDLEWARE] Checking driver authorization');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        if (!req.user || !req.user.uuid) {
            console.log('❌ [DRIVER-MIDDLEWARE] No authenticated user found');
            return res.status(401).json({
                error:   'Authentication required',
                message: 'You must be logged in to access this resource',
            });
        }

        console.log('👤 [DRIVER-MIDDLEWARE] User UUID:', req.user.uuid);
        console.log('🎭 [DRIVER-MIDDLEWARE] User Type:', req.user.user_type);

        // ✅ Allow both DRIVER and DELIVERY_AGENT
        if (req.user.user_type !== 'DRIVER' && req.user.user_type !== 'DELIVERY_AGENT') {
            console.log('❌ [DRIVER-MIDDLEWARE] User is not a driver or delivery agent');
            console.log('   Expected: DRIVER or DELIVERY_AGENT');
            console.log('   Got:', req.user.user_type);

            return res.status(403).json({
                error:   'Access denied',
                message: 'This resource is only available to drivers and delivery agents',
                code:    'NOT_A_DRIVER',
            });
        }

        console.log('📊 [DRIVER-MIDDLEWARE] Account Status:', req.user.status);

        if (req.user.status === 'PENDING') {
            console.log('⏳ [DRIVER-MIDDLEWARE] Driver account pending approval');
            return res.status(403).json({
                error:     'Account pending approval',
                message:   'Your account is pending admin approval. You cannot accept trips yet.',
                code:      'DRIVER_PENDING',
                isPending: true,
            });
        }

        if (req.user.status === 'SUSPENDED') {
            console.log('🚫 [DRIVER-MIDDLEWARE] Driver account suspended');
            return res.status(403).json({
                error:   'Account suspended',
                message: 'Your account has been suspended. Please contact support.',
                code:    'DRIVER_SUSPENDED',
            });
        }

        if (req.user.status === 'DELETED') {
            console.log('🗑️ [DRIVER-MIDDLEWARE] Driver account deleted');
            return res.status(403).json({
                error:   'Account deleted',
                message: 'This account has been deleted.',
                code:    'DRIVER_DELETED',
            });
        }

        if (req.user.status !== 'ACTIVE') {
            console.log('❌ [DRIVER-MIDDLEWARE] Driver account not active');
            console.log('   Status:', req.user.status);

            return res.status(403).json({
                error:   'Account not active',
                message: 'Your account is not active',
                code:    'DRIVER_NOT_ACTIVE',
            });
        }

        console.log('✅ [DRIVER-MIDDLEWARE] Driver authorization successful');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        next();

    } catch (error) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ [DRIVER-MIDDLEWARE ERROR]');
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('Error:', error.message);
        console.error('Stack:', error.stack);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(500).json({
            error:   'Server error',
            message: 'An error occurred while verifying driver authorization',
        });
    }
};

/**
 * Middleware to allow DRIVER or DELIVERY_AGENT regardless of status
 * Use for endpoints that don't require active status (view history, profile, etc.)
 */
const requireDriverAny = async (req, res, next) => {
    try {
        console.log('🚗 [DRIVER-MIDDLEWARE-ANY] Checking driver type (any status)');

        if (!req.user || !req.user.uuid) {
            return res.status(401).json({
                error:   'Authentication required',
                message: 'You must be logged in to access this resource',
            });
        }

        // ✅ Allow both DRIVER and DELIVERY_AGENT
        if (req.user.user_type !== 'DRIVER' && req.user.user_type !== 'DELIVERY_AGENT') {
            return res.status(403).json({
                error:   'Access denied',
                message: 'This resource is only available to drivers and delivery agents',
                code:    'NOT_A_DRIVER',
            });
        }

        console.log('✅ [DRIVER-MIDDLEWARE-ANY] Driver type verified (status: ' + req.user.status + ')');
        next();

    } catch (error) {
        console.error('❌ [DRIVER-MIDDLEWARE-ANY ERROR]:', error.message);
        return res.status(500).json({
            error:   'Server error',
            message: 'An error occurred while verifying driver type',
        });
    }
};

/**
 * Middleware to check if driver is currently online
 */
const requireOnline = async (req, res, next) => {
    try {
        console.log('📡 [DRIVER-MIDDLEWARE] Checking if driver is online');
        console.log('✅ [DRIVER-MIDDLEWARE] Online check passed (TODO: implement actual check)');
        next();
    } catch (error) {
        console.error('❌ [DRIVER-MIDDLEWARE] Online check error:', error.message);
        return res.status(500).json({
            error:   'Server error',
            message: 'An error occurred while checking online status',
        });
    }
};

module.exports = {
    requireDriver,
    requireDriverAny,
    requireOnline,
};