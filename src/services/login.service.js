// src/services/login.service.js
'use strict';

const { Op } = require('sequelize');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const {
    Account,
    PassengerProfile,
    DriverProfile,
    RefreshToken,
    Driver,
    DeliveryWallet,
} = require('../models');

const { redis } = require('../config/redis');
const {
    generateAccessToken,
    generateRefreshToken,
} = require('../utils/jwt');

// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION = 15 * 60; // 15 minutes in seconds
const FAILED_ATTEMPTS_TTL = 15 * 60; // 15 minutes

// Target bcrypt cost. Existing accounts hashed at a higher cost are transparently
// re-hashed down to this on their next successful login (see verifyPassword), so
// logins get fast without forcing a password reset. cost 10 ≈ OWASP minimum.
const TARGET_BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
const REFRESH_TOKEN_EXPIRY_DAYS = parseInt(
    process.env.REFRESH_TOKEN_EXPIRY_DAYS || '365',
    10
);

const ACCESS_TOKEN_EXPIRES_IN_SECONDS = parseInt(
    process.env.ACCESS_TOKEN_EXPIRES_IN_SECONDS || '900',
    10
);

// ═══════════════════════════════════════════════════════════════
// PRIVATE HELPERS
// ═══════════════════════════════════════════════════════════════

function hashRefreshToken(refreshToken) {
    return crypto
        .createHash('sha256')
        .update(refreshToken)
        .digest('hex');
}

function buildAccessTokenPayload(account) {
    return {
        uuid: account.uuid,
        user_type: account.user_type,
        active_mode: account.active_mode || null,
        email: account.email || null,
        phone_e164: account.phone_e164 || null,
        phone: account.phone_e164 || null, // kept for backward compatibility
        status: account.status,
    };
}

function getRefreshTokenExpiryDate() {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_EXPIRY_DAYS);
    return expiresAt;
}

function getSafeDeviceInfo(deviceInfo = null) {
    if (!deviceInfo) return null;

    if (typeof deviceInfo === 'string') {
        return deviceInfo.substring(0, 500);
    }

    try {
        return JSON.stringify(deviceInfo).substring(0, 500);
    } catch (_) {
        return null;
    }
}

async function createRefreshTokenRecord(accountUuid, refreshTokenString, options = {}) {
    const refreshTokenHash = hashRefreshToken(refreshTokenString);
    const expiresAt = getRefreshTokenExpiryDate();

    const payload = {
        account_uuid: accountUuid,
        token_hash: refreshTokenHash,
        expires_at: expiresAt,
        is_valid: true,
        ip_address: options.ip_address || null,
        user_agent: options.user_agent
            ? String(options.user_agent).substring(0, 500)
            : null,
    };

    await RefreshToken.create(payload);

    return {
        refreshTokenHash,
        expiresAt,
    };
}

async function loadAccountWithProfiles(whereClause) {
    return Account.findOne({
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
            },
            {
                model: Driver,
                as: 'driver_record',
                foreignKey: 'userId',
                required: false,
                include: [
                    {
                        model: DeliveryWallet,
                        as: 'delivery_wallet',
                        required: false,
                    },
                ],
            },
        ],
    });
}

function isAccountAllowedForRefresh(account) {
    if (!account) {
        return {
            allowed: false,
            error: 'ACCOUNT_NOT_FOUND',
        };
    }

    if (account.status === 'DELETED') {
        return {
            allowed: false,
            error: 'ACCOUNT_DELETED',
        };
    }

    if (account.status === 'SUSPENDED') {
        return {
            allowed: false,
            error: 'ACCOUNT_SUSPENDED',
        };
    }

    if (account.status === 'INACTIVE') {
        return {
            allowed: false,
            error: 'ACCOUNT_INACTIVE',
        };
    }

    if (account.status !== 'ACTIVE') {
        return {
            allowed: false,
            error: 'ACCOUNT_INACTIVE',
        };
    }

    if (
        account.user_type === 'DELIVERY_AGENT' &&
        account.driver_record &&
        account.driver_record.delivery_wallet
    ) {
        const walletStatus = account.driver_record.delivery_wallet.status;

        if (walletStatus === 'frozen') {
            return {
                allowed: false,
                error: 'WALLET_FROZEN',
            };
        }

        if (walletStatus === 'suspended') {
            return {
                allowed: false,
                error: 'WALLET_SUSPENDED',
            };
        }
    }

    return {
        allowed: true,
        error: null,
    };
}

// ═══════════════════════════════════════════════════════════════
// FIND ACCOUNT
// ═══════════════════════════════════════════════════════════════

/**
 * Find account by email or phone number.
 * Also includes associated profile data.
 */
async function findAccountByIdentifier(identifier) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔍 [FIND ACCOUNT] Looking up account...');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📧 Identifier:', identifier);

    if (!identifier) {
        console.log('❌ [FIND ACCOUNT] Missing identifier');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        return null;
    }

    const normalizedIdentifier = String(identifier).trim();
    const isEmail = normalizedIdentifier.includes('@');

    const whereClause = isEmail
        ? { email: normalizedIdentifier.toLowerCase() }
        : { phone_e164: normalizedIdentifier };

    console.log('🔍 [SEARCH] Searching by:', isEmail ? 'EMAIL' : 'PHONE');

    try {
        const account = await loadAccountWithProfiles(whereClause);

        if (!account) {
            console.log('❌ [FIND ACCOUNT] Account not found');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
            return null;
        }

        console.log('✅ [FIND ACCOUNT] Account found!');
        console.log('   UUID        :', account.uuid);
        console.log('   User Type   :', account.user_type);
        console.log('   Active Mode :', account.active_mode || '(not set)');
        console.log('   Email       :', account.email || 'N/A');
        console.log('   Phone       :', account.phone_e164 || 'N/A');
        console.log('   Status      :', account.status);
        console.log('   Email Verif :', account.email_verified);
        console.log('   Phone Verif :', account.phone_verified);

        if (account.user_type === 'PASSENGER' && account.passenger_profile) {
            console.log('👤 [PASSENGER PROFILE] Loaded');
        }

        if (account.user_type === 'DRIVER' && account.driver_profile) {
            console.log('🚗 [DRIVER PROFILE] Loaded');
            console.log('   License      :', account.driver_profile.license_number);
            console.log('   Verification :', account.driver_profile.verification_state);
        }

        if (account.user_type === 'DELIVERY_AGENT' && account.driver_record) {
            console.log('📦 [DELIVERY AGENT RECORD] Loaded');
            console.log('   Driver ID :', account.driver_record.id);
            console.log('   Mode      :', account.driver_record.current_mode);
            console.log('   Status    :', account.driver_record.status);

            if (account.driver_record.delivery_wallet) {
                console.log('   Wallet Balance:', account.driver_record.delivery_wallet.balance);
                console.log('   Wallet Status :', account.driver_record.delivery_wallet.status);
            }
        }

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        return account;

    } catch (error) {
        console.error('❌ [FIND ACCOUNT ERROR]:', error.message);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        const err = new Error('Database error while finding account');
        err.code = 'FIND_ACCOUNT_FAILED';
        err.status = 500;
        throw err;
    }
}

// ═══════════════════════════════════════════════════════════════
// PASSWORD
// ═══════════════════════════════════════════════════════════════

// Re-hash a verified password down to TARGET_BCRYPT_ROUNDS in the background.
// Never awaited by the login path — a failure here just leaves the old hash.
function _maybeRehashPassword(accountUuid, plainPassword, currentHash) {
    let currentCost;
    try {
        currentCost = bcrypt.getRounds(currentHash);
    } catch {
        return; // not a bcrypt hash — leave it alone
    }
    if (currentCost <= TARGET_BCRYPT_ROUNDS) return;

    bcrypt.hash(plainPassword, TARGET_BCRYPT_ROUNDS)
        .then((newHash) => Account.update(
            { password_hash: newHash },
            { where: { uuid: accountUuid } }
        ))
        .then(() => console.log(`🔁 [PASSWORD] Re-hashed ${accountUuid} cost ${currentCost} → ${TARGET_BCRYPT_ROUNDS}`))
        .catch((e) => console.warn('⚠️ [PASSWORD] Background re-hash failed:', e.message));
}

async function verifyPassword(plainPassword, hash, account = null) {
    console.log('🔐 [PASSWORD] Verifying password...');

    if (!plainPassword) {
        console.log('❌ [PASSWORD] Missing plain password');
        return {
            valid: false,
            reason: 'MISSING_PASSWORD',
        };
    }

    /**
     * Google-only accounts have no local password.
     * They must authenticate using Google OAuth unless they later set a password.
     */
    if (!hash) {
        const authProvider = account?.auth_provider || null;

        if (authProvider === 'GOOGLE') {
            console.log('⚠️ [PASSWORD] Google-only account tried password login');

            return {
                valid: false,
                reason: 'USE_GOOGLE_LOGIN',
                message: 'This account uses Google sign-in. Please continue with Google.',
            };
        }

        console.log('❌ [PASSWORD] Missing password hash');

        return {
            valid: false,
            reason: 'PASSWORD_NOT_SET',
            message: 'Password is not set for this account.',
        };
    }

    try {
        const isValid = await bcrypt.compare(plainPassword, hash);

        console.log(isValid ? '✅ [PASSWORD] Valid' : '❌ [PASSWORD] Invalid');

        // Speed up this user's NEXT login: if their hash was made at a higher
        // bcrypt cost, re-hash at the target cost. Fire-and-forget so it never
        // adds latency to this response.
        if (isValid && account && account.uuid) {
            _maybeRehashPassword(account.uuid, plainPassword, hash);
        }

        return {
            valid: isValid,
            reason: isValid ? null : 'INVALID_PASSWORD',
        };

    } catch (error) {
        console.error('❌ [PASSWORD VERIFY ERROR]:', error.message);

        return {
            valid: false,
            reason: 'PASSWORD_VERIFY_ERROR',
            message: 'Failed to verify password.',
        };
    }
}
// ═══════════════════════════════════════════════════════════════
// LOGIN LOCKOUT
// ═══════════════════════════════════════════════════════════════

async function isAccountLocked(accountUuid) {
    try {
        const lockKey = `account_lock:${accountUuid}`;
        const isLocked = await redis.get(lockKey);

        if (isLocked) {
            const ttl = await redis.ttl(lockKey);
            console.log(`🔒 [SECURITY] Account locked for ${ttl} more seconds`);

            return {
                locked: true,
                remainingTime: ttl,
            };
        }

        return {
            locked: false,
            remainingTime: 0,
        };

    } catch (error) {
        console.error('❌ [LOCK CHECK ERROR]:', error.message);

        return {
            locked: false,
            remainingTime: 0,
        };
    }
}

async function trackFailedLoginAttempt(accountUuid) {
    console.log('⚠️ [SECURITY] Tracking failed login attempt for account:', accountUuid);

    try {
        const attemptsKey = `login_attempts:${accountUuid}`;
        const lockKey = `account_lock:${accountUuid}`;

        const attempts = await redis.incr(attemptsKey);

        if (attempts === 1) {
            await redis.expire(attemptsKey, FAILED_ATTEMPTS_TTL);
        }

        console.log(`   Failed attempts: ${attempts}/${MAX_FAILED_ATTEMPTS}`);

        if (attempts >= MAX_FAILED_ATTEMPTS) {
            await redis.setex(lockKey, LOCKOUT_DURATION, 'locked');

            console.log(`🔒 [SECURITY] Account LOCKED for ${LOCKOUT_DURATION / 60} minutes`);

            return {
                locked: true,
                attempts,
                lockoutDuration: LOCKOUT_DURATION,
            };
        }

        return {
            locked: false,
            attempts,
            remainingAttempts: MAX_FAILED_ATTEMPTS - attempts,
        };

    } catch (error) {
        console.error('❌ [TRACK ATTEMPT ERROR]:', error.message);

        return {
            locked: false,
            attempts: 0,
        };
    }
}

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

// ═══════════════════════════════════════════════════════════════
// LOGIN ELIGIBILITY
// ═══════════════════════════════════════════════════════════════

function canAccountLogin(account) {
    console.log('🔒 [LOGIN CHECK] Validating account eligibility...');

    if (!account) {
        return {
            allowed: false,
            reason: 'ACCOUNT_NOT_FOUND',
            message: 'Account not found.',
        };
    }

    if (account.status === 'DELETED') {
        console.log('❌ [LOGIN CHECK] Account is DELETED');

        return {
            allowed: false,
            reason: 'ACCOUNT_DELETED',
            message: 'This account has been deleted.',
        };
    }

    if (account.status === 'SUSPENDED') {
        console.log('❌ [LOGIN CHECK] Account is SUSPENDED');

        return {
            allowed: false,
            reason: 'ACCOUNT_SUSPENDED',
            message: 'Your account has been suspended. Please contact support.',
        };
    }

    if (account.status === 'INACTIVE') {
        console.log('❌ [LOGIN CHECK] Account is INACTIVE');

        return {
            allowed: false,
            reason: 'ACCOUNT_INACTIVE',
            message: 'Your account is inactive. Please contact support.',
        };
    }

    if (account.user_type === 'DELIVERY_AGENT') {
        if (account.driver_record && account.driver_record.delivery_wallet) {
            const walletStatus = account.driver_record.delivery_wallet.status;

            if (walletStatus === 'frozen') {
                console.log('❌ [LOGIN CHECK] Delivery agent wallet is FROZEN');

                return {
                    allowed: false,
                    reason: 'WALLET_FROZEN',
                    message: 'Your delivery wallet has been frozen. Please contact support.',
                };
            }

            if (walletStatus === 'suspended') {
                console.log('❌ [LOGIN CHECK] Delivery agent wallet is SUSPENDED');

                return {
                    allowed: false,
                    reason: 'WALLET_SUSPENDED',
                    message: 'Your delivery wallet has been suspended. Please contact support.',
                };
            }
        }

        console.log('✅ [LOGIN CHECK] Delivery agent can login');

        return {
            allowed: true,
            reason: null,
            message: null,
        };
    }

    if (!account.phone_verified) {
        console.log('⚠️ [LOGIN CHECK] Phone not verified');

        return {
            allowed: false,
            reason: 'PHONE_NOT_VERIFIED',
            message: 'Please verify your phone number first.',
            requiresOtp: true,
        };
    }

    if (account.user_type === 'DRIVER') {
        if (!account.driver_profile) {
            console.log('❌ [LOGIN CHECK] Driver profile missing');

            return {
                allowed: false,
                reason: 'PROFILE_INCOMPLETE',
                message: 'Driver profile is incomplete. Please complete registration.',
            };
        }

        const driverVerification = account.driver_profile.verification_state;

        if (driverVerification === 'REJECTED') {
            console.log('❌ [LOGIN CHECK] Driver verification REJECTED');

            return {
                allowed: false,
                reason: 'VERIFICATION_REJECTED',
                message: 'Your driver verification was rejected. Please contact support.',
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
        message: null,
    };
}

// ═══════════════════════════════════════════════════════════════
// TOKEN GENERATION
// ═══════════════════════════════════════════════════════════════

/**
 * Generate both access and refresh tokens.
 *
 * Used on login.
 */
async function generateTokens(account, options = {}) {
    console.log('🎫 [TOKENS] Generating access and refresh tokens...');

    try {
        const accessTokenPayload = buildAccessTokenPayload(account);

        console.log('   Account UUID :', accessTokenPayload.uuid);
        console.log('   User Type    :', accessTokenPayload.user_type);
        console.log('   Active Mode  :', accessTokenPayload.active_mode || '(natural fallback in jwt)');
        console.log('   Status       :', accessTokenPayload.status);

        const accessToken = generateAccessToken(accessTokenPayload);

        const refreshTokenString = generateRefreshToken();

        const { expiresAt } = await createRefreshTokenRecord(
            account.uuid,
            refreshTokenString,
            options
        );

        console.log('✅ [TOKENS] Tokens generated successfully');
        console.log('   Access token expires :', ACCESS_TOKEN_EXPIRES_IN_SECONDS, 'seconds');
        console.log('   Refresh token expires:', expiresAt.toISOString());

        return {
            accessToken,
            refreshToken: refreshTokenString,
            expiresIn: ACCESS_TOKEN_EXPIRES_IN_SECONDS,
            refreshExpiresIn: REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60,
        };

    } catch (error) {
        console.error('❌ [TOKENS ERROR]:', error.message);

        const err = new Error('Failed to generate tokens');
        err.code = 'TOKEN_GENERATION_FAILED';
        err.status = 500;
        throw err;
    }
}

// ═══════════════════════════════════════════════════════════════
// REFRESH TOKEN ROTATION
// ═══════════════════════════════════════════════════════════════

/**
 * Verify refresh token, rotate it, and return a new access + refresh token.
 *
 * This is the proper persistent-login flow:
 * - client sends old refresh token
 * - backend verifies it
 * - backend invalidates old refresh token
 * - backend creates new refresh token
 * - backend returns new access token and new refresh token
 */
async function refreshAccessToken(refreshToken, options = {}) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔄 [REFRESH] Verifying refresh token...');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
        if (!refreshToken) {
            console.log('❌ [REFRESH] Missing refresh token');

            return {
                success: false,
                error: 'MISSING_REFRESH_TOKEN',
            };
        }

        const tokenHash = hashRefreshToken(refreshToken);

        const storedToken = await RefreshToken.findOne({
            where: {
                token_hash: tokenHash,
                is_valid: true,
                expires_at: {
                    [Op.gt]: new Date(),
                },
            },
            include: [
                {
                    model: Account,
                    as: 'account',
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
                        {
                            model: Driver,
                            as: 'driver_record',
                            foreignKey: 'userId',
                            required: false,
                            include: [
                                {
                                    model: DeliveryWallet,
                                    as: 'delivery_wallet',
                                    required: false,
                                },
                            ],
                        },
                    ],
                },
            ],
        });

        if (!storedToken) {
            console.log('❌ [REFRESH] Invalid, revoked, or expired refresh token');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            return {
                success: false,
                error: 'INVALID_REFRESH_TOKEN',
            };
        }

        const account = storedToken.account;

        console.log('✅ [REFRESH] Stored refresh token found');
        console.log('   Token ID     :', storedToken.id);
        console.log('   Account UUID :', account?.uuid || 'N/A');
        console.log('   User Type    :', account?.user_type || 'N/A');
        console.log('   Active Mode  :', account?.active_mode || '(not set)');
        console.log('   Status       :', account?.status || 'N/A');

        const eligibility = isAccountAllowedForRefresh(account);

        if (!eligibility.allowed) {
            console.log('❌ [REFRESH] Account cannot refresh:', eligibility.error);

            await storedToken.update({
                is_valid: false,
                last_used_at: new Date(),
            });

            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            return {
                success: false,
                error: eligibility.error,
            };
        }

        // ─────────────────────────────────────────────────────────────
        // ROTATE TOKEN
        // ─────────────────────────────────────────────────────────────
        // Important:
        // We invalidate the old refresh token and create a new one.
        // This reduces the risk of a stolen refresh token being reused.
        // ─────────────────────────────────────────────────────────────

        const newRefreshTokenString = generateRefreshToken();

        await storedToken.update({
            is_valid: false,
            last_used_at: new Date(),
        });

        const { expiresAt } = await createRefreshTokenRecord(
            account.uuid,
            newRefreshTokenString,
            options
        );

        const accessTokenPayload = buildAccessTokenPayload(account);
        const accessToken = generateAccessToken(accessTokenPayload);

        console.log('✅ [REFRESH] Token rotation successful');
        console.log('   Old token invalidated :', storedToken.id);
        console.log('   New refresh expires   :', expiresAt.toISOString());
        console.log('   New access mode       :', accessTokenPayload.active_mode || '(natural fallback in jwt)');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return {
            success: true,
            accessToken,
            refreshToken: newRefreshTokenString,
            expiresIn: ACCESS_TOKEN_EXPIRES_IN_SECONDS,
            refreshExpiresIn: REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60,
            account,
        };

    } catch (error) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ [REFRESH ERROR]:', error.message);
        console.error(error.stack);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return {
            success: false,
            error: 'REFRESH_FAILED',
        };
    }
}

// ═══════════════════════════════════════════════════════════════
// LOGOUT
// ═══════════════════════════════════════════════════════════════

async function invalidateAllRefreshTokens(accountUuid) {
    console.log('🚪 [LOGOUT] Invalidating all refresh tokens for account:', accountUuid);

    try {
        await RefreshToken.update(
            {
                is_valid: false,
            },
            {
                where: {
                    account_uuid: accountUuid,
                    is_valid: true,
                },
            }
        );

        console.log('✅ [LOGOUT] All refresh tokens invalidated');

    } catch (error) {
        console.error('❌ [LOGOUT ERROR]:', error.message);

        const err = new Error('Failed to invalidate tokens');
        err.code = 'LOGOUT_ALL_FAILED';
        err.status = 500;
        throw err;
    }
}

async function invalidateRefreshToken(refreshToken) {
    console.log('🚪 [LOGOUT] Invalidating specific refresh token...');

    try {
        if (!refreshToken) {
            console.log('⚠️ [LOGOUT] Missing refresh token, nothing to invalidate');
            return;
        }

        const tokenHash = hashRefreshToken(refreshToken);

        await RefreshToken.update(
            {
                is_valid: false,
                last_used_at: new Date(),
            },
            {
                where: {
                    token_hash: tokenHash,
                },
            }
        );

        console.log('✅ [LOGOUT] Refresh token invalidated');

    } catch (error) {
        console.error('❌ [LOGOUT ERROR]:', error.message);

        const err = new Error('Failed to invalidate token');
        err.code = 'LOGOUT_FAILED';
        err.status = 500;
        throw err;
    }
}

// ═══════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════

async function cleanupExpiredTokens() {
    console.log('🧹 [CLEANUP] Removing expired/invalid refresh tokens...');

    try {
        const result = await RefreshToken.destroy({
            where: {
                [Op.or]: [
                    {
                        expires_at: {
                            [Op.lt]: new Date(),
                        },
                    },
                    {
                        is_valid: false,
                    },
                ],
            },
        });

        console.log(`✅ [CLEANUP] Removed ${result} expired/invalid tokens`);
        return result;

    } catch (error) {
        console.error('❌ [CLEANUP ERROR]:', error.message);
        return 0;
    }
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

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