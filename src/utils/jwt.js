// src/utils/jwt.js
const jwt = require('jsonwebtoken');

/**
 * Sign access token (short-lived)
 */
function signAccessToken(account) {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        throw new Error('JWT_SECRET is not defined');
    }

    const expiresIn = process.env.JWT_ACCESS_EXPIRES_IN || '50000m'; // Short-lived

    const payload = {
        uuid: account.uuid,
        user_type: account.user_type,
        email: account.email,
        phone_e164: account.phone_e164,
        status: account.status,
        type: 'access' // ← Token type
    };

    console.log('🎫 [JWT] Signing access token for:', account.uuid);
    return jwt.sign(payload, secret, { expiresIn });
}

/**
 * Sign refresh token (long-lived)
 */
function signRefreshToken(account) {
    const secret = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET;
    if (!secret) {
        throw new Error('JWT_REFRESH_SECRET is not defined');
    }

    const expiresIn = process.env.JWT_REFRESH_EXPIRES_IN || '300d'; // Long-lived

    const payload = {
        uuid: account.uuid,
        type: 'refresh' // ← Token type
    };

    console.log('🔄 [JWT] Signing refresh token for:', account.uuid);
    return jwt.sign(payload, secret, { expiresIn });
}

/**
 * Verify access token
 */
function verifyAccessToken(token) {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        throw new Error('JWT_SECRET is not defined');
    }

    try {
        const decoded = jwt.verify(token, secret);

        if (decoded.type !== 'access') {
            throw new Error('Invalid token type');
        }

        return decoded;
    } catch (error) {
        console.error('❌ [JWT] Access token verification failed:', error.message);
        throw error;
    }
}

/**
 * Verify refresh token
 */
function verifyRefreshToken(token) {
    const secret = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET;
    if (!secret) {
        throw new Error('JWT_REFRESH_SECRET is not defined');
    }

    try {
        const decoded = jwt.verify(token, secret);

        if (decoded.type !== 'refresh') {
            throw new Error('Invalid token type');
        }

        return decoded;
    } catch (error) {
        console.error('❌ [JWT] Refresh token verification failed:', error.message);
        throw error;
    }
}

module.exports = {
    signAccessToken,
    signRefreshToken,
    verifyAccessToken,
    verifyRefreshToken
};