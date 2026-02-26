// src/services/login.service.js
const { Op } = require('sequelize');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { Account, PassengerProfile, DriverProfile, RefreshToken } = require('../models');
const { redis } = require('../config/redis'); // Using YOUR existing Redis
const { generateAccessToken, generateRefreshToken } = require('../utils/jwt');

// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION = 15 * 60; // 15 minutes in seconds
const FAILED_ATTEMPTS_TTL = 15 * 60; // 15 minutes
const REFRESH_TOKEN_EXPIRY_DAYS = 365; // 1 year - for "never log out" experience

/**
 * Find account by email or phone number
 * Also includes associated profile data (driver or passenger)
 */
async function findAccountByIdentifier(identifier) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔍 [FIND ACCOUNT] Looking up account...');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📧 Identifier:', identifier);

    // Determine if identifier is email or phone
    const isEmail = identifier.includes('@');
    const whereClause = isEmail
        ? { email: identifier }
        : { phone_e164: identifier };

    console.log('🔍 [SEARCH] Searching by:', isEmail ? 'EMAIL' : 'PHONE');

    try {
        const account = await Account.findOne({
            where: whereClause,
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
                }
            ]
        });

        if (!account) {
            console.log('❌ [FIND ACCOUNT] Account not found');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
            return null;
        }

        console.log('✅ [FIND ACCOUNT] Account found!');
        console.log('   UUID:', account.uuid);
        console.log('   User Type:', account.user_type);
        console.log('   Email:', account.email || 'N/A');
        console.log('   Phone:', account.phone_e164 || 'N/A');
        console.log('   Status:', account.status);
        console.log('   Email Verified:', account.email_verified);
        console.log('   Phone Verified:', account.phone_verified);

        if (account.user_type === 'PASSENGER' && account.passenger_profile) {
            console.log('👤 [PASSENGER PROFILE] Loaded');
        }

        if (account.user_type === 'DRIVER' && account.driver_profile) {
            console.log('🚗 [DRIVER PROFILE] Loaded');
            console.log('   License:', account.driver_profile.license_number);
            console.log('   Verification:', account.driver_profile.verification_state);
        }

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return account;
    } catch (error) {
        console.error('❌ [FIND ACCOUNT ERROR]:', error.message);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        throw new Error('Database error while finding account');
    }
}

/**
 * Verify password against hash
 */
async function verifyPassword(plainPassword, hash) {
    console.log('🔐 [PASSWORD] Verifying password...');

    if (!plainPassword || !hash) {
        console.log('❌ [PASSWORD] Missing password or hash');
        return false;
    }

    try {
        const isValid = await bcrypt.compare(plainPassword, hash);
        console.log(isValid ? '✅ [PASSWORD] Valid' : '❌ [PASSWORD] Invalid');
        return isValid;
    } catch (error) {
        console.error('❌ [PASSWORD VERIFY ERROR]:', error.message);
        return false;
    }
}

/**
 * Check if account is locked due to failed login attempts
 */
async function isAccountLocked(accountUuid) {
    try {
        const lockKey = `account_lock:${accountUuid}`;
        const isLocked = await redis.get(lockKey);

        if (isLocked) {
            const ttl = await redis.ttl(lockKey);
            console.log(`🔒 [SECURITY] Account locked for ${ttl} more seconds`);
            return { locked: true, remainingTime: ttl };
        }

        return { locked: false, remainingTime: 0 };
    } catch (error) {
        console.error('❌ [LOCK CHECK ERROR]:', error.message);
        // If Redis fails, don't block login
        return { locked: false, remainingTime: 0 };
    }
}

/**
 * Track failed login attempt
 * Implement rate limiting to prevent brute force attacks
 */
async function trackFailedLoginAttempt(accountUuid) {
    console.log('⚠️ [SECURITY] Tracking failed login attempt for account:', accountUuid);

    try {
        const attemptsKey = `login_attempts:${accountUuid}`;
        const lockKey = `account_lock:${accountUuid}`;

        // Increment failed attempts
        const attempts = await redis.incr(attemptsKey);

        // Set TTL on first attempt
        if (attempts === 1) {
            await redis.expire(attemptsKey, FAILED_ATTEMPTS_TTL);
        }

        console.log(`   Failed attempts: ${attempts}/${MAX_FAILED_ATTEMPTS}`);

        // Lock account if max attempts reached
        if (attempts >= MAX_FAILED_ATTEMPTS) {
            await redis.setex(lockKey, LOCKOUT_DURATION, 'locked');
            console.log(`🔒 [SECURITY] Account LOCKED for ${LOCKOUT_DURATION/60} minutes`);

            return {
                locked: true,
                attempts: attempts,
                lockoutDuration: LOCKOUT_DURATION
            };
        }

        return {
            locked: false,
            attempts: attempts,
            remainingAttempts: MAX_FAILED_ATTEMPTS - attempts
        };
    } catch (error) {
        console.error('❌ [TRACK ATTEMPT ERROR]:', error.message);
        return { locked: false, attempts: 0 };
    }
}

/**
 * Reset failed login attempts after successful login
 */
async function resetFailedLoginAttempts(accountUuid) {
    console.log('✅ [SECURITY] Resetting failed login attempts for account:', accountUuid);

    try {
        const attemptsKey = `login_attempts:${accountUuid}`;
        const lockKey = `account_lock:${accountUuid}`;

        await redis.del(attemptsKey);
        await redis.del(lockKey);

        console.log('✅ [SECURITY] Failed attempts cleared');
    } catch (error) {
        console.error('❌ [RESET ATTEMPTS ERROR]:', error.message);
    }
}

/**
 * Check if account can login (status and verification checks)
 */
function canAccountLogin(account) {
    console.log('🔒 [LOGIN CHECK] Validating account eligibility...');

    // Check if account is suspended or inactive
    if (account.status === 'SUSPENDED') {
        console.log('❌ [LOGIN CHECK] Account is SUSPENDED');
        return {
            allowed: false,
            reason: 'ACCOUNT_SUSPENDED',
            message: 'Your account has been suspended. Please contact support.'
        };
    }

    if (account.status === 'INACTIVE') {
        console.log('❌ [LOGIN CHECK] Account is INACTIVE');
        return {
            allowed: false,
            reason: 'ACCOUNT_INACTIVE',
            message: 'Your account is inactive. Please contact support.'
        };
    }

    // Check phone verification (CRITICAL for OTP-based system)
    if (!account.phone_verified) {
        console.log('⚠️ [LOGIN CHECK] Phone not verified');
        return {
            allowed: false,
            reason: 'PHONE_NOT_VERIFIED',
            message: 'Please verify your phone number first.',
            requiresOtp: true
        };
    }

    // For drivers, check profile and verification
    if (account.user_type === 'DRIVER') {
        if (!account.driver_profile) {
            console.log('❌ [LOGIN CHECK] Driver profile missing');
            return {
                allowed: false,
                reason: 'PROFILE_INCOMPLETE',
                message: 'Driver profile is incomplete. Please complete registration.'
            };
        }

        const driverVerification = account.driver_profile.verification_state;
        if (driverVerification === 'REJECTED') {
            console.log('❌ [LOGIN CHECK] Driver verification REJECTED');
            return {
                allowed: false,
                reason: 'VERIFICATION_REJECTED',
                message: 'Your driver verification was rejected. Please contact support.'
            };
        }

        if (driverVerification === 'PENDING') {
            console.log('⚠️ [LOGIN CHECK] Driver verification PENDING');
        }
    }

    console.log('✅ [LOGIN CHECK] Account can login');
    return {
        allowed: true,
        reason: null,
        message: null
    };
}

/**
 * Generate both access and refresh tokens
 */
async function generateTokens(account) {
    console.log('🎫 [TOKENS] Generating access and refresh tokens...');

    try {
        // Generate access token (short-lived: 15 minutes)
        const accessToken = generateAccessToken({
            uuid: account.uuid,
            user_type: account.user_type,
            email: account.email,
            phone: account.phone_e164
        });

        // Generate refresh token (long-lived: 1 year)
        const refreshTokenString = generateRefreshToken();
        const refreshTokenHash = crypto
            .createHash('sha256')
            .update(refreshTokenString)
            .digest('hex');

        // Calculate expiry date (1 year from now)
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_EXPIRY_DAYS);

        // Save refresh token to database
        await RefreshToken.create({
            account_uuid: account.uuid,
            token_hash: refreshTokenHash,
            expires_at: expiresAt,
            is_valid: true
        });

        console.log('✅ [TOKENS] Tokens generated successfully');
        console.log('   Access token expires: 15 minutes');
        console.log('   Refresh token expires:', expiresAt.toISOString());

        return {
            accessToken,
            refreshToken: refreshTokenString,
            expiresIn: 900, // 15 minutes in seconds
            refreshExpiresIn: REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 // in seconds
        };
    } catch (error) {
        console.error('❌ [TOKENS ERROR]:', error.message);
        throw new Error('Failed to generate tokens');
    }
}

/**
 * Verify and refresh tokens
 */
async function refreshAccessToken(refreshToken) {
    console.log('🔄 [REFRESH] Verifying refresh token...');

    try {
        // Hash the provided token
        const tokenHash = crypto
            .createHash('sha256')
            .update(refreshToken)
            .digest('hex');

        // Find token in database
        const storedToken = await RefreshToken.findOne({
            where: {
                token_hash: tokenHash,
                is_valid: true,
                expires_at: {
                    [Op.gt]: new Date()
                }
            },
            include: [{
                model: Account,
                as: 'account',
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
            }]
        });

        if (!storedToken) {
            console.log('❌ [REFRESH] Invalid or expired refresh token');
            return { success: false, error: 'INVALID_REFRESH_TOKEN' };
        }

        // Check if account is still active
        const account = storedToken.account;
        if (!account || account.status !== 'ACTIVE') {
            console.log('❌ [REFRESH] Account is not active');
            return { success: false, error: 'ACCOUNT_INACTIVE' };
        }

        // Update last_used_at
        await storedToken.update({ last_used_at: new Date() });

        // Generate new access token
        const accessToken = generateAccessToken({
            uuid: account.uuid,
            user_type: account.user_type,
            email: account.email,
            phone: account.phone_e164
        });

        console.log('✅ [REFRESH] New access token generated');

        return {
            success: true,
            accessToken,
            expiresIn: 900,
            account
        };
    } catch (error) {
        console.error('❌ [REFRESH ERROR]:', error.message);
        return { success: false, error: 'REFRESH_FAILED' };
    }
}

/**
 * Invalidate all refresh tokens for an account (logout from all devices)
 */
async function invalidateAllRefreshTokens(accountUuid) {
    console.log('🚪 [LOGOUT] Invalidating all refresh tokens for account:', accountUuid);

    try {
        await RefreshToken.update(
            { is_valid: false },
            { where: { account_uuid: accountUuid, is_valid: true } }
        );

        console.log('✅ [LOGOUT] All refresh tokens invalidated');
    } catch (error) {
        console.error('❌ [LOGOUT ERROR]:', error.message);
        throw new Error('Failed to invalidate tokens');
    }
}

/**
 * Invalidate a specific refresh token (logout from one device)
 */
async function invalidateRefreshToken(refreshToken) {
    console.log('🚪 [LOGOUT] Invalidating specific refresh token...');

    try {
        const tokenHash = crypto
            .createHash('sha256')
            .update(refreshToken)
            .digest('hex');

        await RefreshToken.update(
            { is_valid: false },
            { where: { token_hash: tokenHash } }
        );

        console.log('✅ [LOGOUT] Refresh token invalidated');
    } catch (error) {
        console.error('❌ [LOGOUT ERROR]:', error.message);
        throw new Error('Failed to invalidate token');
    }
}

/**
 * Clean up expired refresh tokens (run periodically)
 */
async function cleanupExpiredTokens() {
    console.log('🧹 [CLEANUP] Removing expired refresh tokens...');

    try {
        const result = await RefreshToken.destroy({
            where: {
                [Op.or]: [
                    { expires_at: { [Op.lt]: new Date() } },
                    { is_valid: false }
                ]
            }
        });

        console.log(`✅ [CLEANUP] Removed ${result} expired tokens`);
        return result;
    } catch (error) {
        console.error('❌ [CLEANUP ERROR]:', error.message);
        return 0;
    }
}

module.exports = {
    findAccountByIdentifier,
    verifyPassword,
    canAccountLogin,
    isAccountLocked,
    trackFailedLoginAttempt,
    resetFailedLoginAttempts,
    generateTokens,
    refreshAccessToken,
    invalidateAllRefreshTokens,
    invalidateRefreshToken,
    cleanupExpiredTokens,
};