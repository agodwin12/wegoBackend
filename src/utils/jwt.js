// src/utils/jwt.js
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// ═══════════════════════════════════════════════════════════════
// TOKEN CONFIGURATION
// ═══════════════════════════════════════════════════════════════
const ACCESS_TOKEN_SECRET = process.env.JWT_SECRET || process.env.JWT_ACCESS_SECRET;
const REFRESH_TOKEN_SECRET = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET;
const ACCESS_TOKEN_EXPIRY = process.env.JWT_ACCESS_EXPIRES_IN || '15m'; // 15 minutes
const REFRESH_TOKEN_EXPIRY = process.env.JWT_REFRESH_EXPIRES_IN || '365d'; // 1 year

/**
 * Sign access token (short-lived - 15 minutes)
 */
function signAccessToken(account) {
    if (!ACCESS_TOKEN_SECRET) {
        throw new Error('JWT_SECRET is not defined');
    }

    const payload = {
        uuid: account.uuid,
        user_type: account.user_type,
        email: account.email,
        phone_e164: account.phone_e164,
        status: account.status,
        type: 'access'
    };

    console.log('🎫 [JWT] Signing access token for:', account.uuid);
    console.log('   Expires in:', ACCESS_TOKEN_EXPIRY);

    return jwt.sign(payload, ACCESS_TOKEN_SECRET, {
        expiresIn: ACCESS_TOKEN_EXPIRY,
        issuer: 'wego-auth',
        audience: 'wego-api'
    });
}

/**
 * Generate refresh token (cryptographically secure random string)
 * This is MORE secure than JWT refresh tokens because:
 * 1. Can be easily revoked from database
 * 2. No information leakage
 * 3. Harder to forge
 */
function generateRefreshToken() {
    console.log('🔄 [JWT] Generating secure refresh token...');

    // Generate 64 random bytes (128 hex characters)
    const token = crypto.randomBytes(64).toString('hex');

    console.log('✅ [JWT] Refresh token generated (128 chars)');
    return token;
}

/**
 * LEGACY: Sign JWT refresh token (for backward compatibility)
 * NOTE: Use generateRefreshToken() instead for better security
 */
function signRefreshToken(account) {
    if (!REFRESH_TOKEN_SECRET) {
        throw new Error('JWT_REFRESH_SECRET is not defined');
    }

    const payload = {
        uuid: account.uuid,
        type: 'refresh'
    };

    console.log('🔄 [JWT] Signing JWT refresh token for:', account.uuid);
    console.log('⚠️  [JWT] Consider using generateRefreshToken() for better security');
    console.log('   Expires in:', REFRESH_TOKEN_EXPIRY);

    return jwt.sign(payload, REFRESH_TOKEN_SECRET, {
        expiresIn: REFRESH_TOKEN_EXPIRY,
        issuer: 'wego-auth',
        audience: 'wego-api'
    });
}

/**
 * Verify access token
 */
function verifyAccessToken(token) {
    if (!ACCESS_TOKEN_SECRET) {
        throw new Error('JWT_SECRET is not defined');
    }

    try {
        const decoded = jwt.verify(token, ACCESS_TOKEN_SECRET, {
            issuer: 'wego-auth',
            audience: 'wego-api'
        });

        if (decoded.type !== 'access') {
            throw new Error('Invalid token type');
        }

        console.log('✅ [JWT] Access token verified for:', decoded.uuid);
        return decoded;
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            console.log('⚠️ [JWT] Access token expired');
            const err = new Error('TOKEN_EXPIRED');
            err.status = 401;
            err.code = 'TOKEN_EXPIRED';
            throw err;
        } else if (error.name === 'JsonWebTokenError') {
            console.error('❌ [JWT] Invalid access token:', error.message);
            const err = new Error('TOKEN_INVALID');
            err.status = 401;
            err.code = 'TOKEN_INVALID';
            throw err;
        } else {
            console.error('❌ [JWT] Access token verification failed:', error.message);
            throw error;
        }
    }
}

/**
 * Verify JWT refresh token (for backward compatibility)
 * NOTE: This is only used if you're using JWT-based refresh tokens
 */
function verifyRefreshToken(token) {
    if (!REFRESH_TOKEN_SECRET) {
        throw new Error('JWT_REFRESH_SECRET is not defined');
    }

    try {
        const decoded = jwt.verify(token, REFRESH_TOKEN_SECRET, {
            issuer: 'wego-auth',
            audience: 'wego-api'
        });

        if (decoded.type !== 'refresh') {
            throw new Error('Invalid token type');
        }

        console.log('✅ [JWT] Refresh token verified for:', decoded.uuid);
        return decoded;
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            console.log('⚠️ [JWT] Refresh token expired');
            const err = new Error('REFRESH_TOKEN_EXPIRED');
            err.status = 401;
            err.code = 'REFRESH_TOKEN_EXPIRED';
            throw err;
        } else if (error.name === 'JsonWebTokenError') {
            console.error('❌ [JWT] Invalid refresh token:', error.message);
            const err = new Error('REFRESH_TOKEN_INVALID');
            err.status = 401;
            err.code = 'REFRESH_TOKEN_INVALID';
            throw err;
        } else {
            console.error('❌ [JWT] Refresh token verification failed:', error.message);
            throw error;
        }
    }
}

/**
 * Decode token without verification (for debugging)
 */
function decodeToken(token) {
    try {
        return jwt.decode(token);
    } catch (error) {
        console.error('❌ [JWT] Token decode failed:', error.message);
        return null;
    }
}

/**
 * Generate access token from payload (for token refresh)
 */
function generateAccessToken(payload) {
    if (!ACCESS_TOKEN_SECRET) {
        throw new Error('JWT_SECRET is not defined');
    }

    console.log('🎫 [JWT] Generating access token from payload');

    return jwt.sign(
        {
            uuid: payload.uuid,
            user_type: payload.user_type,
            email: payload.email,
            phone: payload.phone,
            type: 'access'
        },
        ACCESS_TOKEN_SECRET,
        {
            expiresIn: ACCESS_TOKEN_EXPIRY,
            issuer: 'wego-auth',
            audience: 'wego-api'
        }
    );
}

module.exports = {
    // Primary methods (use these)
    signAccessToken,
    generateAccessToken,
    generateRefreshToken, // ← NEW: Crypto-based (recommended)
    verifyAccessToken,

    // Legacy methods (for backward compatibility)
    signRefreshToken, // ← LEGACY: JWT-based
    verifyRefreshToken,

    // Utility
    decodeToken,
};