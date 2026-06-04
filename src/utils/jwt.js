// src/utils/jwt.js
'use strict';



const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// ═══════════════════════════════════════════════════════════════════════
// ENV CONFIG
// ═══════════════════════════════════════════════════════════════════════

const ACCESS_TOKEN_SECRET =
    process.env.JWT_ACCESS_SECRET ||
    process.env.JWT_SECRET;

const REFRESH_TOKEN_SECRET =
    process.env.JWT_REFRESH_SECRET ||
    process.env.JWT_SECRET;

const ACCESS_TOKEN_EXPIRY =
    process.env.JWT_ACCESS_EXPIRES_IN ||
    process.env.ACCESS_TOKEN_EXPIRES_IN ||
    '15m';

const REFRESH_TOKEN_EXPIRY =
    process.env.JWT_REFRESH_EXPIRES_IN ||
    '365d';

// ═══════════════════════════════════════════════════════════════════════
// PRIVATE HELPERS
// ═══════════════════════════════════════════════════════════════════════

function _userTypeToMode(userType) {
    const map = {
        PASSENGER: 'PASSENGER',
        DRIVER: 'DRIVER',
        DELIVERY_AGENT: 'DELIVERY_AGENT',
    };

    return map[userType] || null;
}

function _normalizeAccountPayload(accountOrPayload) {
    if (!accountOrPayload) {
        throw new Error('Missing account payload for JWT generation');
    }

    const userType = accountOrPayload.user_type;
    const activeMode =
        accountOrPayload.active_mode ||
        _userTypeToMode(userType);

    return {
        uuid: accountOrPayload.uuid,
        user_type: userType,
        active_mode: activeMode,

        email: accountOrPayload.email || null,

        // Keep both names for backward compatibility.
        phone_e164:
            accountOrPayload.phone_e164 ||
            accountOrPayload.phone ||
            null,

        phone:
            accountOrPayload.phone ||
            accountOrPayload.phone_e164 ||
            null,

        status: accountOrPayload.status || 'ACTIVE',

        type: 'access',
    };
}

function _assertAccessTokenConfig() {
    if (!ACCESS_TOKEN_SECRET) {
        throw new Error('JWT_SECRET or JWT_ACCESS_SECRET is not defined');
    }
}

function _assertRefreshTokenConfig() {
    if (!REFRESH_TOKEN_SECRET) {
        throw new Error('JWT_SECRET or JWT_REFRESH_SECRET is not defined');
    }
}

// ═══════════════════════════════════════════════════════════════════════
// ACCESS TOKEN GENERATION
// ═══════════════════════════════════════════════════════════════════════

function generateAccessToken(accountOrPayload) {
    _assertAccessTokenConfig();

    const payload = _normalizeAccountPayload(accountOrPayload);

    if (!payload.uuid) {
        throw new Error('Cannot generate access token: missing uuid');
    }

    if (!payload.user_type) {
        throw new Error('Cannot generate access token: missing user_type');
    }

    console.log('🎫 [JWT] Generating access token');
    console.log('   uuid       :', payload.uuid);
    console.log('   user_type  :', payload.user_type);
    console.log('   active_mode:', payload.active_mode || '(none)');
    console.log('   status     :', payload.status);
    console.log('   expires in :', ACCESS_TOKEN_EXPIRY);

    return jwt.sign(payload, ACCESS_TOKEN_SECRET, {
        expiresIn: ACCESS_TOKEN_EXPIRY,
        issuer: 'wego-auth',
        audience: 'wego-api',
    });
}

/**
 * Backward-compatible alias.
 *
 * Existing code may call signAccessToken(account). Internally it now uses the
 * same generation path as generateAccessToken(), so login and refresh always
 * produce the same payload shape.
 */
function signAccessToken(account) {
    return generateAccessToken(account);
}

// ═══════════════════════════════════════════════════════════════════════
// REFRESH TOKEN GENERATION — SECURE RANDOM TOKEN
// ═══════════════════════════════════════════════════════════════════════

function generateRefreshToken() {
    console.log('🔄 [JWT] Generating secure refresh token');

    const token = crypto.randomBytes(64).toString('hex');

    console.log('✅ [JWT] Refresh token generated');
    console.log('   length:', token.length);

    return token;
}

// ═══════════════════════════════════════════════════════════════════════
// ACCESS TOKEN VERIFICATION
// ═══════════════════════════════════════════════════════════════════════

function verifyAccessToken(token) {
    _assertAccessTokenConfig();

    if (!token) {
        const err = new Error('TOKEN_MISSING');
        err.status = 401;
        err.code = 'TOKEN_MISSING';
        throw err;
    }

    try {
        const decoded = jwt.verify(token, ACCESS_TOKEN_SECRET, {
            issuer: 'wego-auth',
            audience: 'wego-api',
        });

        if (decoded.type !== 'access') {
            const err = new Error('Invalid token type');
            err.status = 401;
            err.code = 'TOKEN_INVALID_TYPE';
            throw err;
        }

        console.log('✅ [JWT] Access token verified');
        console.log('   uuid       :', decoded.uuid);
        console.log('   user_type  :', decoded.user_type);
        console.log('   active_mode:', decoded.active_mode || '(legacy token — no mode claim)');

        return decoded;

    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            console.log('⚠️ [JWT] Access token expired');

            const err = new Error('TOKEN_EXPIRED');
            err.status = 401;
            err.code = 'TOKEN_EXPIRED';
            throw err;
        }

        if (error.name === 'JsonWebTokenError') {
            console.error('❌ [JWT] Invalid access token:', error.message);

            const err = new Error('TOKEN_INVALID');
            err.status = 401;
            err.code = 'TOKEN_INVALID';
            throw err;
        }

        if (error.name === 'NotBeforeError') {
            console.error('❌ [JWT] Token not yet valid:', error.message);

            const err = new Error('TOKEN_NOT_YET_VALID');
            err.status = 401;
            err.code = 'TOKEN_NOT_YET_VALID';
            throw err;
        }

        console.error('❌ [JWT] Access token verification failed:', error.message);
        throw error;
    }
}

// ═══════════════════════════════════════════════════════════════════════
// LEGACY JWT REFRESH TOKEN SUPPORT
// ═══════════════════════════════════════════════════════════════════════
//
// Your new system should NOT use this for persistent login.
// It remains here only so old code/imports do not crash.
// The real refresh token is generated by generateRefreshToken()
// and stored hashed in RefreshToken table by login.service.js.
// ═══════════════════════════════════════════════════════════════════════

function signRefreshToken(account) {
    _assertRefreshTokenConfig();

    if (!account || !account.uuid) {
        throw new Error('Cannot generate refresh token: missing account uuid');
    }

    const payload = {
        uuid: account.uuid,
        type: 'refresh',
    };

    console.log('⚠️ [JWT] Signing legacy JWT refresh token');
    console.log('   uuid      :', account.uuid);
    console.log('   expires in:', REFRESH_TOKEN_EXPIRY);

    return jwt.sign(payload, REFRESH_TOKEN_SECRET, {
        expiresIn: REFRESH_TOKEN_EXPIRY,
        issuer: 'wego-auth',
        audience: 'wego-api',
    });
}

function verifyRefreshToken(token) {
    _assertRefreshTokenConfig();

    if (!token) {
        const err = new Error('REFRESH_TOKEN_MISSING');
        err.status = 401;
        err.code = 'REFRESH_TOKEN_MISSING';
        throw err;
    }

    try {
        const decoded = jwt.verify(token, REFRESH_TOKEN_SECRET, {
            issuer: 'wego-auth',
            audience: 'wego-api',
        });

        if (decoded.type !== 'refresh') {
            const err = new Error('Invalid refresh token type');
            err.status = 401;
            err.code = 'REFRESH_TOKEN_INVALID_TYPE';
            throw err;
        }

        console.log('✅ [JWT] Legacy refresh token verified for:', decoded.uuid);

        return decoded;

    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            console.log('⚠️ [JWT] Legacy refresh token expired');

            const err = new Error('REFRESH_TOKEN_EXPIRED');
            err.status = 401;
            err.code = 'REFRESH_TOKEN_EXPIRED';
            throw err;
        }

        if (error.name === 'JsonWebTokenError') {
            console.error('❌ [JWT] Invalid legacy refresh token:', error.message);

            const err = new Error('REFRESH_TOKEN_INVALID');
            err.status = 401;
            err.code = 'REFRESH_TOKEN_INVALID';
            throw err;
        }

        console.error('❌ [JWT] Legacy refresh token verification failed:', error.message);
        throw error;
    }
}

// ═══════════════════════════════════════════════════════════════════════
// DEBUG DECODE
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
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════

module.exports = {
    signAccessToken,
    generateAccessToken,
    generateRefreshToken,
    verifyAccessToken,

    // Legacy only
    signRefreshToken,
    verifyRefreshToken,

    decodeToken,
};