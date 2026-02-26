// src/middleware/auth.middleware.js
const { verifyAccessToken } = require('../utils/jwt');
const { Account, PassengerProfile, DriverProfile } = require('../models');

/**
 * Main authentication middleware
 * Verifies JWT access token and loads user account
 */
async function authenticate(req, res, next) {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔐 [AUTH MIDDLEWARE] Checking authentication...');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        // ═══════════════════════════════════════════════════════════════
        // STEP 1: Check for Authorization header
        // ═══════════════════════════════════════════════════════════════
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            console.log('❌ [AUTH] No token provided or invalid format');
            console.log('   Authorization header:', authHeader ? 'Present but invalid format' : 'Missing');

            return res.status(401).json({
                success: false,
                message: 'Authentication required. Please provide a valid token.',
                code: 'NO_TOKEN_PROVIDED'
            });
        }

        // ═══════════════════════════════════════════════════════════════
        // STEP 2: Extract and verify token
        // ═══════════════════════════════════════════════════════════════
        const token = authHeader.substring(7); // Remove "Bearer " prefix
        console.log('🔑 [AUTH] Token extracted from header');

        let decoded;
        try {
            decoded = verifyAccessToken(token);
        } catch (tokenError) {
            console.log('❌ [AUTH] Token verification failed:', tokenError.message);

            // Handle specific JWT errors
            if (tokenError.code === 'TOKEN_EXPIRED' || tokenError.name === 'TokenExpiredError') {
                return res.status(401).json({
                    success: false,
                    message: 'Your session has expired. Please refresh your token or login again.',
                    code: 'TOKEN_EXPIRED',
                    shouldRefresh: true // Client should try refresh token
                });
            } else if (tokenError.code === 'TOKEN_INVALID' || tokenError.name === 'JsonWebTokenError') {
                return res.status(401).json({
                    success: false,
                    message: 'Invalid authentication token.',
                    code: 'INVALID_TOKEN'
                });
            } else if (tokenError.name === 'NotBeforeError') {
                return res.status(401).json({
                    success: false,
                    message: 'Token not yet valid.',
                    code: 'TOKEN_NOT_YET_VALID'
                });
            } else {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication failed.',
                    code: 'TOKEN_VERIFICATION_FAILED'
                });
            }
        }

        if (!decoded || !decoded.uuid) {
            console.log('❌ [AUTH] Token decoded but missing user UUID');
            return res.status(401).json({
                success: false,
                message: 'Invalid token payload.',
                code: 'INVALID_TOKEN_PAYLOAD'
            });
        }

        console.log('✅ [AUTH] Token verified successfully');
        console.log('   User UUID:', decoded.uuid);
        console.log('   User Type:', decoded.user_type);

        // ═══════════════════════════════════════════════════════════════
        // STEP 3: Fetch user account from database with profile data
        // ═══════════════════════════════════════════════════════════════
        console.log('🔍 [AUTH] Fetching user account from database...');

        const account = await Account.findOne({
            where: { uuid: decoded.uuid },
            include: [
                {
                    model: PassengerProfile,
                    as: 'passenger_profile',
                    required: false
                },
                {
                    model: DriverProfile,
                    as: 'driver_profile',
                    required: false
                }
            ]
        });

        if (!account) {
            console.log('❌ [AUTH] Account not found in database');
            console.log('   Attempted UUID:', decoded.uuid);

            return res.status(401).json({
                success: false,
                message: 'Account not found. Please login again.',
                code: 'ACCOUNT_NOT_FOUND'
            });
        }

        console.log('✅ [AUTH] Account found');
        console.log('   Email:', account.email || 'N/A');
        console.log('   Phone:', account.phone_e164 || 'N/A');
        console.log('   Status:', account.status);

        // ═══════════════════════════════════════════════════════════════
        // STEP 4: Check account status
        // ═══════════════════════════════════════════════════════════════
        if (account.status === 'DELETED') {
            console.log('❌ [AUTH] Account has been deleted');

            return res.status(403).json({
                success: false,
                message: 'This account has been deleted and cannot be accessed.',
                code: 'ACCOUNT_DELETED'
            });
        }

        if (account.status === 'SUSPENDED') {
            console.log('⚠️  [AUTH] Account is suspended');

            return res.status(403).json({
                success: false,
                message: 'Your account has been suspended. Please contact support for assistance.',
                code: 'ACCOUNT_SUSPENDED'
            });
        }

        if (account.status === 'INACTIVE') {
            console.log('⚠️  [AUTH] Account is inactive');

            return res.status(403).json({
                success: false,
                message: 'Your account is inactive. Please contact support.',
                code: 'ACCOUNT_INACTIVE'
            });
        }

        // ═══════════════════════════════════════════════════════════════
        // STEP 5: Verify token claims match database
        // ═══════════════════════════════════════════════════════════════
        if (decoded.user_type !== account.user_type) {
            console.log('⚠️  [AUTH] Token user_type mismatch');
            console.log('   Token:', decoded.user_type);
            console.log('   Database:', account.user_type);

            return res.status(401).json({
                success: false,
                message: 'Token data mismatch. Please login again.',
                code: 'TOKEN_DATA_MISMATCH'
            });
        }

        // ═══════════════════════════════════════════════════════════════
        // STEP 6: Attach user to request and proceed
        // ═══════════════════════════════════════════════════════════════
        console.log('✅ [AUTH] Authentication successful!');
        console.log('   User:', account.first_name, account.last_name);
        console.log('   UUID:', account.uuid);
        console.log('   Type:', account.user_type);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        // Attach full account with profile data to request
        req.user = account;
        req.auth = {
            uuid: decoded.uuid,
            user_type: decoded.user_type,
            token: token
        };

        next();

    } catch (err) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ [AUTH MIDDLEWARE ERROR]');
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('Error Message:', err.message);
        console.error('Error Stack:', err.stack);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(err.status || 500).json({
            success: false,
            message: err.message || 'Authentication failed.',
            code: err.code || 'AUTH_ERROR'
        });
    }
}

/**
 * Middleware to check if user has specific role(s)
 * Usage: router.get('/admin', authenticate, requireRole('ADMIN', 'SUPER_ADMIN'), ...)
 */
function requireRole(...allowedRoles) {
    return (req, res, next) => {
        console.log('🔒 [ROLE CHECK] Verifying user role...');

        if (!req.user) {
            console.log('❌ [ROLE CHECK] No user in request');
            return res.status(401).json({
                success: false,
                message: 'Authentication required.',
                code: 'NOT_AUTHENTICATED'
            });
        }

        if (!allowedRoles.includes(req.user.user_type)) {
            console.log('❌ [ROLE CHECK] Insufficient permissions');
            console.log('   Required roles:', allowedRoles.join(', '));
            console.log('   User has:', req.user.user_type);

            return res.status(403).json({
                success: false,
                message: 'You do not have permission to access this resource.',
                code: 'INSUFFICIENT_PERMISSIONS',
                required: allowedRoles,
                current: req.user.user_type
            });
        }

        console.log('✅ [ROLE CHECK] Permission granted');
        console.log('   User type:', req.user.user_type);
        next();
    };
}

/**
 * Middleware to check if account is verified (email or phone)
 */
function requireVerified(req, res, next) {
    console.log('🔒 [VERIFICATION CHECK] Checking account verification...');

    if (!req.user) {
        console.log('❌ [VERIFICATION CHECK] No user in request');
        return res.status(401).json({
            success: false,
            message: 'Authentication required.',
            code: 'NOT_AUTHENTICATED'
        });
    }

    const isVerified = !!(req.user.email_verified || req.user.phone_verified);

    if (!isVerified) {
        console.log('❌ [VERIFICATION CHECK] Account not verified');
        console.log('   Email verified:', req.user.email_verified);
        console.log('   Phone verified:', req.user.phone_verified);

        return res.status(403).json({
            success: false,
            message: 'Please verify your email or phone number before accessing this resource.',
            code: 'ACCOUNT_NOT_VERIFIED',
            data: {
                email_verified: req.user.email_verified,
                phone_verified: req.user.phone_verified
            }
        });
    }

    console.log('✅ [VERIFICATION CHECK] Account is verified');
    next();
}

/**
 * Middleware to check if driver is approved
 * Only for drivers - passengers skip this check
 */
function requireDriverApproval(req, res, next) {
    console.log('🔒 [DRIVER APPROVAL CHECK] Checking driver approval status...');

    if (!req.user) {
        console.log('❌ [DRIVER APPROVAL] No user in request');
        return res.status(401).json({
            success: false,
            message: 'Authentication required.',
            code: 'NOT_AUTHENTICATED'
        });
    }

    // Only check for drivers
    if (req.user.user_type !== 'DRIVER') {
        console.log('✅ [DRIVER APPROVAL] User is not a driver, skipping check');
        return next();
    }

    // Check driver profile exists
    if (!req.user.driver_profile) {
        console.log('❌ [DRIVER APPROVAL] Driver profile missing');
        return res.status(403).json({
            success: false,
            message: 'Driver profile not found. Please complete registration.',
            code: 'DRIVER_PROFILE_MISSING'
        });
    }

    // Check account status
    if (req.user.status === 'PENDING') {
        console.log('⚠️  [DRIVER APPROVAL] Driver account pending approval');
        return res.status(403).json({
            success: false,
            message: 'Your driver account is pending admin approval. You cannot access this feature yet.',
            code: 'DRIVER_PENDING_APPROVAL',
            data: {
                verification_state: req.user.driver_profile.verification_state
            }
        });
    }

    // Check verification state
    const verificationState = req.user.driver_profile.verification_state;
    if (verificationState === 'REJECTED') {
        console.log('❌ [DRIVER APPROVAL] Driver verification rejected');
        return res.status(403).json({
            success: false,
            message: 'Your driver verification was rejected. Please contact support.',
            code: 'DRIVER_VERIFICATION_REJECTED'
        });
    }

    if (verificationState !== 'APPROVED') {
        console.log('⚠️  [DRIVER APPROVAL] Driver not yet approved');
        return res.status(403).json({
            success: false,
            message: 'Your driver account is not yet approved.',
            code: 'DRIVER_NOT_APPROVED',
            data: {
                verification_state: verificationState
            }
        });
    }

    console.log('✅ [DRIVER APPROVAL] Driver is approved');
    next();
}

/**
 * Optional middleware - only authenticate if token is provided
 * Useful for endpoints that have different behavior for authenticated/unauthenticated users
 */
async function optionalAuth(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.log('ℹ️  [OPTIONAL AUTH] No token provided, continuing as unauthenticated');
        return next();
    }

    // If token is provided, verify it
    return authenticate(req, res, next);
}

module.exports = {
    authenticate,
    authenticateToken: authenticate, // Alias for backward compatibility
    requireRole,
    requireVerified,
    requireDriverApproval,
    optionalAuth,
};