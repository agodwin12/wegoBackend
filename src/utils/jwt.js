// src/utils/jwt.js
//
// ═══════════════════════════════════════════════════════════════════════
// JWT UTILITIES
// ═══════════════════════════════════════════════════════════════════════
//
// active_mode is now a first-class JWT claim alongside user_type.
//
// user_type   = permanent base role (DRIVER, DELIVERY_AGENT, PASSENGER…)
//               never changes after registration
//
// active_mode = current operating context, set by switch-mode endpoint
//               can be PASSENGER | DRIVER | DELIVERY_AGENT
//               NULL/absent in token → treated as equal to user_type
//
// Both claims are verified in auth_middleware against the DB so a stale
// token can never grant access to a mode the DB doesn't agree with.
//
// ═══════════════════════════════════════════════════════════════════════

const jwt    = require('jsonwebtoken');
const crypto = require('crypto');

const ACCESS_TOKEN_SECRET  = process.env.JWT_SECRET || process.env.JWT_ACCESS_SECRET;
const REFRESH_TOKEN_SECRET = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET;
const ACCESS_TOKEN_EXPIRY  = process.env.JWT_ACCESS_EXPIRES_IN  || '15m';
const REFRESH_TOKEN_EXPIRY = process.env.JWT_REFRESH_EXPIRES_IN || '365d';

// ─── Private helper ───────────────────────────────────────────────────
// Maps a user_type to its natural active_mode equivalent.
// PARTNER and ADMIN don't switch modes — return null.
function _userTypeToMode(userType) {
    const map = {
        PASSENGER:      'PASSENGER',
        DRIVER:         'DRIVER',
        DELIVERY_AGENT: 'DELIVERY_AGENT',
    };
    return map[userType] || null;
}

// ═══════════════════════════════════════════════════════════════════════
// SIGN ACCESS TOKEN  (short-lived — 15 minutes)
// ═══════════════════════════════════════════════════════════════════════
//
// account must have: uuid, user_type, email, phone_e164, status
// account may have:  active_mode (null = not switched, falls back to user_type)

function signAccessToken(account) {
    if (!ACCESS_TOKEN_SECRET) {
        throw new Error('JWT_SECRET is not defined');
    }

    // Resolve effective mode — active_mode wins, fall back to user_type mapping.
    const effectiveMode = account.active_mode || _userTypeToMode(account.user_type);

    const payload = {
        uuid:        account.uuid,
        user_type:   account.user_type,   // permanent — never changes
        active_mode: effectiveMode,       // current context — changes on mode switch
        email:       account.email,
        phone_e164:  account.phone_e164,
        status:      account.status,
        type:        'access',
    };

    console.log('🎫 [JWT] Signing access token for:', account.uuid);
    console.log('   user_type  :', account.user_type);
    console.log('   active_mode:', effectiveMode);
    console.log('   Expires in :', ACCESS_TOKEN_EXPIRY);

    return jwt.sign(payload, ACCESS_TOKEN_SECRET, {
        expiresIn: ACCESS_TOKEN_EXPIRY,
        issuer:    'wego-auth',
        audience:  'wego-api',
    });
}

// ═══════════════════════════════════════════════════════════════════════
// GENERATE REFRESH TOKEN  (crypto-based — preferred)
// ═══════════════════════════════════════════════════════════════════════

function generateRefreshToken() {
    console.log('🔄 [JWT] Generating secure refresh token...');
    const token = crypto.randomBytes(64).toString('hex');
    console.log('✅ [JWT] Refresh token generated (128 chars)');
    return token;
}

// ═══════════════════════════════════════════════════════════════════════
// LEGACY: SIGN JWT REFRESH TOKEN
// ═══════════════════════════════════════════════════════════════════════

function signRefreshToken(account) {
    if (!REFRESH_TOKEN_SECRET) {
        throw new Error('JWT_REFRESH_SECRET is not defined');
    }

    const payload = {
        uuid: account.uuid,
        type: 'refresh',
    };

    console.log('🔄 [JWT] Signing JWT refresh token for:', account.uuid);
    console.log('⚠️  [JWT] Consider using generateRefreshToken() for better security');
    console.log('   Expires in:', REFRESH_TOKEN_EXPIRY);

    return jwt.sign(payload, REFRESH_TOKEN_SECRET, {
        expiresIn: REFRESH_TOKEN_EXPIRY,
        issuer:    'wego-auth',
        audience:  'wego-api',
    });
}

// ═══════════════════════════════════════════════════════════════════════
// VERIFY ACCESS TOKEN
// ═══════════════════════════════════════════════════════════════════════

function verifyAccessToken(token) {
    if (!ACCESS_TOKEN_SECRET) {
        throw new Error('JWT_SECRET is not defined');
    }

    try {
        const decoded = jwt.verify(token, ACCESS_TOKEN_SECRET, {
            issuer:   'wego-auth',
            audience: 'wego-api',
        });

        if (decoded.type !== 'access') {
            throw new Error('Invalid token type');
        }

        console.log('✅ [JWT] Access token verified for:', decoded.uuid);
        console.log('   active_mode:', decoded.active_mode || '(legacy token — no mode claim)');
        return decoded;

    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            console.log('⚠️ [JWT] Access token expired');
            const err  = new Error('TOKEN_EXPIRED');
            err.status = 401;
            err.code   = 'TOKEN_EXPIRED';
            throw err;
        } else if (error.name === 'JsonWebTokenError') {
            console.error('❌ [JWT] Invalid access token:', error.message);
            const err  = new Error('TOKEN_INVALID');
            err.status = 401;
            err.code   = 'TOKEN_INVALID';
            throw err;
        } else {
            console.error('❌ [JWT] Access token verification failed:', error.message);
            throw error;
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════
// VERIFY REFRESH TOKEN  (legacy JWT-based)
// ═══════════════════════════════════════════════════════════════════════

function verifyRefreshToken(token) {
    if (!REFRESH_TOKEN_SECRET) {
        throw new Error('JWT_REFRESH_SECRET is not defined');
    }

    try {
        const decoded = jwt.verify(token, REFRESH_TOKEN_SECRET, {
            issuer:   'wego-auth',
            audience: 'wego-api',
        });

        if (decoded.type !== 'refresh') {
            throw new Error('Invalid token type');
        }

        console.log('✅ [JWT] Refresh token verified for:', decoded.uuid);
        return decoded;

    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            console.log('⚠️ [JWT] Refresh token expired');
            const err  = new Error('REFRESH_TOKEN_EXPIRED');
            err.status = 401;
            err.code   = 'REFRESH_TOKEN_EXPIRED';
            throw err;
        } else if (error.name === 'JsonWebTokenError') {
            console.error('❌ [JWT] Invalid refresh token:', error.message);
            const err  = new Error('REFRESH_TOKEN_INVALID');
            err.status = 401;
            err.code   = 'REFRESH_TOKEN_INVALID';
            throw err;
        } else {
            console.error('❌ [JWT] Refresh token verification failed:', error.message);
            throw error;
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════
// DECODE WITHOUT VERIFICATION  (debugging only)
// ═══════════════════════════════════════════════════════════════════════

function decodeToken(token) {
    try {
        return jwt.decode(token);
    } catch (error) {
        console.error('❌ [JWT] Token decode failed:', error.message);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════
// GENERATE ACCESS TOKEN FROM PAYLOAD  (token refresh flow)
// ═══════════════════════════════════════════════════════════════════════
//
// Used in the refresh-token endpoint to issue a new access token.
// Must carry active_mode forward so the mode is not lost on refresh.

function generateAccessToken(payload) {
    if (!ACCESS_TOKEN_SECRET) {
        throw new Error('JWT_SECRET is not defined');
    }

    console.log('🎫 [JWT] Generating access token from payload');

    return jwt.sign(
        {
            uuid:        payload.uuid,
            user_type:   payload.user_type,
            // Preserve active_mode from payload; fall back to user_type mapping
            // so a refresh of a legacy token without the claim still works.
            active_mode: payload.active_mode || _userTypeToMode(payload.user_type),
            email:       payload.email,
            phone:       payload.phone,
            type:        'access',
        },
        ACCESS_TOKEN_SECRET,
        {
            expiresIn: ACCESS_TOKEN_EXPIRY,
            issuer:    'wego-auth',
            audience:  'wego-api',
        }
    );
}

module.exports = {
    // Primary methods
    signAccessToken,
    generateAccessToken,
    generateRefreshToken,
    verifyAccessToken,

    // Legacy
    signRefreshToken,
    verifyRefreshToken,

    // Utility
    decodeToken,
};