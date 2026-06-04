// src/middleware/auth.middleware.js
'use strict';



const { verifyAccessToken } = require('../utils/jwt');

const {
    Account,
    PassengerProfile,
    DriverProfile,
} = require('../models');

// ─── Private helpers ──────────────────────────────────────────────────

function _userTypeToMode(userType) {
    const map = {
        PASSENGER: 'PASSENGER',
        DRIVER: 'DRIVER',
        DELIVERY_AGENT: 'DELIVERY_AGENT',
    };

    return map[userType] || null;
}

function _resolveMode(dbMode, userType) {
    return dbMode || _userTypeToMode(userType);
}

function _safeTokenLog(token) {
    if (!token || token.length < 20) return '(invalid token)';
    return `${token.substring(0, 12)}...${token.substring(token.length - 8)}`;
}

function _buildSafeUser(account) {
    if (!account) return null;

    const accountData = account.toJSON ? account.toJSON() : account;

    const {
        password_hash,
        password_algo,
        ...safeAccount
    } = accountData;

    return safeAccount;
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN AUTHENTICATE MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════

async function authenticate(req, res, next) {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔐 [AUTH MIDDLEWARE] Checking authentication...');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        // ── STEP 1: Authorization header ──────────────────────────────
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            console.log('❌ [AUTH] No token provided or invalid format');
            console.log('   Authorization header:', authHeader ? 'Present but invalid format' : 'Missing');

            return res.status(401).json({
                success: false,
                message: 'Authentication required. Please provide a valid token.',
                code: 'NO_TOKEN_PROVIDED',
                shouldRefresh: false,
                shouldRelogin: true,
            });
        }

        // ── STEP 2: Extract and verify access token ───────────────────
        const token = authHeader.substring(7);

        console.log('🔑 [AUTH] Token extracted from header');
        console.log('   Token:', _safeTokenLog(token));

        let decoded;

        try {
            decoded = verifyAccessToken(token);

        } catch (tokenError) {
            console.log('❌ [AUTH] Token verification failed:', tokenError.message);
            console.log('   Code:', tokenError.code || tokenError.name);

            if (tokenError.code === 'TOKEN_EXPIRED' || tokenError.name === 'TokenExpiredError') {
                return res.status(401).json({
                    success: false,
                    message: 'Your session has expired. Please refresh your token.',
                    code: 'TOKEN_EXPIRED',
                    shouldRefresh: true,
                    shouldRelogin: false,
                });
            }

            if (
                tokenError.code === 'TOKEN_INVALID' ||
                tokenError.code === 'TOKEN_INVALID_TYPE' ||
                tokenError.name === 'JsonWebTokenError'
            ) {
                return res.status(401).json({
                    success: false,
                    message: 'Invalid authentication token.',
                    code: 'INVALID_TOKEN',
                    shouldRefresh: false,
                    shouldRelogin: true,
                });
            }

            if (tokenError.code === 'TOKEN_NOT_YET_VALID' || tokenError.name === 'NotBeforeError') {
                return res.status(401).json({
                    success: false,
                    message: 'Token not yet valid.',
                    code: 'TOKEN_NOT_YET_VALID',
                    shouldRefresh: false,
                    shouldRelogin: true,
                });
            }

            return res.status(401).json({
                success: false,
                message: 'Authentication failed.',
                code: 'TOKEN_VERIFICATION_FAILED',
                shouldRefresh: false,
                shouldRelogin: true,
            });
        }

        if (!decoded || !decoded.uuid) {
            console.log('❌ [AUTH] Token decoded but missing user UUID');

            return res.status(401).json({
                success: false,
                message: 'Invalid token payload.',
                code: 'INVALID_TOKEN_PAYLOAD',
                shouldRefresh: false,
                shouldRelogin: true,
            });
        }

        console.log('✅ [AUTH] Token verified successfully');
        console.log('   User UUID  :', decoded.uuid);
        console.log('   User Type  :', decoded.user_type);
        console.log('   Active Mode:', decoded.active_mode || '(legacy token — no mode claim)');
        console.log('   Status     :', decoded.status || '(not in token)');

        // ── STEP 3: Fetch account from database ───────────────────────
        console.log('🔍 [AUTH] Fetching user account from database...');

        const account = await Account.findOne({
            where: {
                uuid: decoded.uuid,
            },
            include: [
                {
                    model: PassengerProfile,
                    as: 'passenger_profile',
                    required: false,
                },
                {
                    model: DriverProfile,
                    as: 'driver_profile',
                    required: false,
                },
            ],
        });

        if (!account) {
            console.log('❌ [AUTH] Account not found in database');
            console.log('   Attempted UUID:', decoded.uuid);

            return res.status(401).json({
                success: false,
                message: 'Account not found. Please login again.',
                code: 'ACCOUNT_NOT_FOUND',
                shouldRefresh: false,
                shouldRelogin: true,
            });
        }

        console.log('✅ [AUTH] Account found');
        console.log('   Email      :', account.email || 'N/A');
        console.log('   Phone      :', account.phone_e164 || 'N/A');
        console.log('   Status     :', account.status);
        console.log('   User Type  :', account.user_type);
        console.log('   Active Mode:', account.active_mode || '(not set — uses user_type fallback)');

        // ── STEP 4: Check account status ──────────────────────────────
        if (account.status === 'DELETED') {
            console.log('❌ [AUTH] Account has been deleted');

            return res.status(403).json({
                success: false,
                message: 'This account has been deleted and cannot be accessed.',
                code: 'ACCOUNT_DELETED',
                shouldRefresh: false,
                shouldRelogin: true,
            });
        }

        if (account.status === 'SUSPENDED') {
            console.log('⚠️ [AUTH] Account is suspended');

            return res.status(403).json({
                success: false,
                message: 'Your account has been suspended. Please contact support for assistance.',
                code: 'ACCOUNT_SUSPENDED',
                shouldRefresh: false,
                shouldRelogin: true,
            });
        }

        if (account.status === 'INACTIVE') {
            console.log('⚠️ [AUTH] Account is inactive');

            return res.status(403).json({
                success: false,
                message: 'Your account is inactive. Please contact support.',
                code: 'ACCOUNT_INACTIVE',
                shouldRefresh: false,
                shouldRelogin: true,
            });
        }

        // ── STEP 5: Verify token claims match database ────────────────

        if (decoded.user_type !== account.user_type) {
            console.log('⚠️ [AUTH] Token user_type mismatch');
            console.log('   Token   :', decoded.user_type);
            console.log('   Database:', account.user_type);

            return res.status(401).json({
                success: false,
                message: 'Token data mismatch. Please login again.',
                code: 'TOKEN_DATA_MISMATCH',
                shouldRefresh: false,
                shouldRelogin: true,
            });
        }

        const tokenResolvedMode =
            decoded.active_mode ||
            _userTypeToMode(decoded.user_type);

        const dbResolvedMode =
            _resolveMode(account.active_mode, account.user_type);

        if (tokenResolvedMode !== dbResolvedMode) {
            console.log('⚠️ [AUTH] active_mode mismatch — token is stale after mode switch');
            console.log('   Token resolved mode:', tokenResolvedMode);
            console.log('   DB resolved mode   :', dbResolvedMode);

            return res.status(401).json({
                success: false,
                message: 'Your session mode has changed. Please refresh your token.',
                code: 'MODE_TOKEN_STALE',

                // This is the important change:
                // Flutter should call /refresh-token, replace the access token,
                // then retry the original request.
                shouldRefresh: true,
                shouldRelogin: false,

                current_mode: dbResolvedMode,
                token_mode: tokenResolvedMode,
            });
        }

        // Optional status mismatch protection.
        // Do not block if old tokens do not have status.
        if (decoded.status && decoded.status !== account.status) {
            console.log('⚠️ [AUTH] token status mismatch — token is stale');
            console.log('   Token status:', decoded.status);
            console.log('   DB status   :', account.status);

            return res.status(401).json({
                success: false,
                message: 'Your account status has changed. Please refresh your token.',
                code: 'STATUS_TOKEN_STALE',
                shouldRefresh: true,
                shouldRelogin: false,
                current_status: account.status,
                token_status: decoded.status,
            });
        }

        // ── STEP 6: Attach user to request and proceed ────────────────
        console.log('✅ [AUTH] Authentication successful!');
        console.log('   User       :', account.first_name, account.last_name);
        console.log('   UUID       :', account.uuid);
        console.log('   Type       :', account.user_type);
        console.log('   Active Mode:', dbResolvedMode);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        req.user = account;

        req.auth = {
            uuid: decoded.uuid,
            user_type: decoded.user_type,
            active_mode: dbResolvedMode,
            token,
            token_payload: decoded,
            safe_user: _buildSafeUser(account),
        };

        return next();

    } catch (err) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ [AUTH MIDDLEWARE ERROR]');
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('Error Message:', err.message);
        console.error('Error Code   :', err.code || 'AUTH_ERROR');
        console.error('Error Stack  :', err.stack);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(err.status || 500).json({
            success: false,
            message: err.message || 'Authentication failed.',
            code: err.code || 'AUTH_ERROR',
            shouldRefresh: false,
            shouldRelogin: err.status === 401,
        });
    }
}

// ═══════════════════════════════════════════════════════════════════════
// REQUIRE ROLE
// Gates on user_type, not active_mode.
// ═══════════════════════════════════════════════════════════════════════

function requireRole(...allowedRoles) {
    return (req, res, next) => {
        console.log('🔒 [ROLE CHECK] Verifying user role...');

        if (!req.user) {
            console.log('❌ [ROLE CHECK] No user in request');

            return res.status(401).json({
                success: false,
                message: 'Authentication required.',
                code: 'NOT_AUTHENTICATED',
            });
        }

        if (!allowedRoles.includes(req.user.user_type)) {
            console.log('❌ [ROLE CHECK] Insufficient permissions');
            console.log('   Required:', allowedRoles.join(', '));
            console.log('   Has     :', req.user.user_type);

            return res.status(403).json({
                success: false,
                message: 'You do not have permission to access this resource.',
                code: 'INSUFFICIENT_PERMISSIONS',
                required: allowedRoles,
                current: req.user.user_type,
            });
        }

        console.log('✅ [ROLE CHECK] Permission granted — user_type:', req.user.user_type);

        return next();
    };
}

// ═══════════════════════════════════════════════════════════════════════
// REQUIRE MODE
// Gates on active_mode, not permanent user_type.
// ═══════════════════════════════════════════════════════════════════════

function requireMode(...allowedModes) {
    return (req, res, next) => {
        console.log('🔒 [MODE CHECK] Verifying active mode...');

        if (!req.auth) {
            console.log('❌ [MODE CHECK] No auth context in request');

            return res.status(401).json({
                success: false,
                message: 'Authentication required.',
                code: 'NOT_AUTHENTICATED',
            });
        }

        const activeMode = req.auth.active_mode;

        if (!allowedModes.includes(activeMode)) {
            console.log('❌ [MODE CHECK] Wrong active mode');
            console.log('   Required:', allowedModes.join(', '));
            console.log('   Has     :', activeMode);

            return res.status(403).json({
                success: false,
                message: `This action requires ${allowedModes.join(' or ')} mode. You are currently in ${activeMode} mode.`,
                code: 'WRONG_MODE',
                required: allowedModes,
                active_mode: activeMode,
            });
        }

        console.log('✅ [MODE CHECK] Mode OK —', activeMode);

        return next();
    };
}

// ═══════════════════════════════════════════════════════════════════════
// REQUIRE VERIFIED
// ═══════════════════════════════════════════════════════════════════════

function requireVerified(req, res, next) {
    console.log('🔒 [VERIFICATION CHECK] Checking account verification...');

    if (!req.user) {
        console.log('❌ [VERIFICATION CHECK] No user in request');

        return res.status(401).json({
            success: false,
            message: 'Authentication required.',
            code: 'NOT_AUTHENTICATED',
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
                phone_verified: req.user.phone_verified,
            },
        });
    }

    console.log('✅ [VERIFICATION CHECK] Account is verified');

    return next();
}

// ═══════════════════════════════════════════════════════════════════════
// REQUIRE DRIVER APPROVAL
// ═══════════════════════════════════════════════════════════════════════

function requireDriverApproval(req, res, next) {
    console.log('🔒 [DRIVER APPROVAL CHECK] Checking driver approval status...');

    if (!req.user) {
        console.log('❌ [DRIVER APPROVAL] No user in request');

        return res.status(401).json({
            success: false,
            message: 'Authentication required.',
            code: 'NOT_AUTHENTICATED',
        });
    }

    if (req.user.user_type !== 'DRIVER') {
        console.log('✅ [DRIVER APPROVAL] User is not a driver, skipping check');
        return next();
    }

    if (!req.user.driver_profile) {
        console.log('❌ [DRIVER APPROVAL] Driver profile missing');

        return res.status(403).json({
            success: false,
            message: 'Driver profile not found. Please complete registration.',
            code: 'DRIVER_PROFILE_MISSING',
        });
    }

    if (req.user.status === 'PENDING') {
        console.log('⚠️ [DRIVER APPROVAL] Driver account pending approval');

        return res.status(403).json({
            success: false,
            message: 'Your driver account is pending admin approval. You cannot access this feature yet.',
            code: 'DRIVER_PENDING_APPROVAL',
            data: {
                verification_state: req.user.driver_profile.verification_state,
            },
        });
    }

    const verificationState = req.user.driver_profile.verification_state;

    if (verificationState === 'REJECTED') {
        console.log('❌ [DRIVER APPROVAL] Driver verification rejected');

        return res.status(403).json({
            success: false,
            message: 'Your driver verification was rejected. Please contact support.',
            code: 'DRIVER_VERIFICATION_REJECTED',
        });
    }

    if (verificationState !== 'APPROVED') {
        console.log('⚠️ [DRIVER APPROVAL] Driver not yet approved');

        return res.status(403).json({
            success: false,
            message: 'Your driver account is not yet approved.',
            code: 'DRIVER_NOT_APPROVED',
            data: {
                verification_state: verificationState,
            },
        });
    }

    console.log('✅ [DRIVER APPROVAL] Driver is approved');

    return next();
}

// ═══════════════════════════════════════════════════════════════════════
// OPTIONAL AUTH
// ═══════════════════════════════════════════════════════════════════════

async function optionalAuth(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.log('ℹ️ [OPTIONAL AUTH] No token provided, continuing as unauthenticated');
        return next();
    }

    return authenticate(req, res, next);
}

// ═══════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════

module.exports = {
    authenticate,
    authenticateToken: authenticate,
    requireRole,
    requireMode,
    requireVerified,
    requireDriverApproval,
    optionalAuth,
};