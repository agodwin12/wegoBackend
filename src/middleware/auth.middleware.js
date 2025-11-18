// src/middleware/auth.middleware.js
const { verifyAccessToken } = require('../utils/jwt');
const { Account } = require('../models');

/**
 * Authentication middleware
 * Verifies JWT token and attaches user to request
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

            if (tokenError.name === 'TokenExpiredError') {
                return res.status(401).json({
                    success: false,
                    message: 'Your session has expired. Please login again.',
                    code: 'TOKEN_EXPIRED'
                });
            } else if (tokenError.name === 'JsonWebTokenError') {
                return res.status(401).json({
                    success: false,
                    message: 'Invalid authentication token.',
                    code: 'INVALID_TOKEN'
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
        // STEP 3: Fetch user account from database
        // ═══════════════════════════════════════════════════════════════
        console.log('🔍 [AUTH] Fetching user account from database...');

        const account = await Account.findOne({ where: { uuid: decoded.uuid } });

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

        // ═══════════════════════════════════════════════════════════════
        // STEP 5: Attach user to request and proceed
        // ═══════════════════════════════════════════════════════════════
        console.log('✅ [AUTH] Authentication successful!');
        console.log('   User:', account.first_name, account.last_name);
        console.log('   UUID:', account.uuid);
        console.log('   Type:', account.user_type);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        req.user = account;
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
 * Optional: Middleware to check if user is a specific type
 * Usage: router.get('/admin', authenticate, requireRole('ADMIN'), ...)
 */
function requireRole(...allowedRoles) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required.',
                code: 'NOT_AUTHENTICATED'
            });
        }

        if (!allowedRoles.includes(req.user.user_type)) {
            console.log('❌ [AUTH] Insufficient permissions');
            console.log('   Required:', allowedRoles);
            console.log('   User has:', req.user.user_type);

            return res.status(403).json({
                success: false,
                message: 'You do not have permission to access this resource.',
                code: 'INSUFFICIENT_PERMISSIONS'
            });
        }

        next();
    };
}

/**
 * Optional: Middleware to check if account is verified
 */
function requireVerified(req, res, next) {
    if (!req.user) {
        return res.status(401).json({
            success: false,
            message: 'Authentication required.',
            code: 'NOT_AUTHENTICATED'
        });
    }

    const isVerified = !!(req.user.email_verified || req.user.phone_verified);

    if (!isVerified) {
        console.log('❌ [AUTH] Account not verified');

        return res.status(403).json({
            success: false,
            message: 'Please verify your email or phone number before accessing this resource.',
            code: 'ACCOUNT_NOT_VERIFIED'
        });
    }

    next();
}

module.exports = {
    authenticate,
    requireRole,
    requireVerified,
};