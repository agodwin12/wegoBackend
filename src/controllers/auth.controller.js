// src/controllers/auth.controller.js
const { validationResult } = require('express-validator');
const path = require('path');
const { signupPassenger, signupDriver } = require('../services/auth.services');
const { sendOtpByIdentifier, verifyOtp } = require('../services/otp.service');
const { findAccountByIdentifier, verifyPassword } = require('../services/login.service');
const { getFileUrl, deleteFile, getFilenameFromUrl } = require('../middleware/upload');
const { signAccessToken, signRefreshToken } = require('../utils/jwt');
const { Account } = require('../models');

/**
 * Validation helper
 */
function handleValidation(req) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        const message = errors.array().map(e => `${e.param}: ${e.msg}`).join(', ');
        console.log('❌ [VALIDATION ERROR]:', message);
        const err = new Error(message);
        err.status = 400;
        throw err;
    }
}


exports.refreshToken = async (req, res, next) => {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔄 [REFRESH TOKEN] Request received');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        const { refresh_token } = req.body;

        if (!refresh_token) {
            const err = new Error('Refresh token required');
            err.status = 400;
            throw err;
        }

        console.log('🔍 [REFRESH TOKEN] Verifying refresh token...');

        // Verify refresh token
        const { verifyRefreshToken } = require('../utils/jwt');
        const decoded = verifyRefreshToken(refresh_token);

        console.log('✅ [REFRESH TOKEN] Token verified for user:', decoded.uuid);

        // Get fresh user data
        const { Account } = require('../models');
        const account = await Account.findByPk(decoded.uuid);

        if (!account) {
            console.log('❌ [REFRESH TOKEN] Account not found');
            const err = new Error('Account not found');
            err.status = 404;
            throw err;
        }

        // Check if account is still active
        if (account.status === 'SUSPENDED' || account.status === 'DELETED') {
            console.log('❌ [REFRESH TOKEN] Account is', account.status);
            const err = new Error('Account is no longer active');
            err.status = 403;
            throw err;
        }

        // Generate new tokens
        console.log('🎫 [REFRESH TOKEN] Generating new tokens...');
        const newAccessToken = signAccessToken(account);
        const newRefreshToken = signRefreshToken(account);

        console.log('✅ [REFRESH TOKEN] New tokens generated');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(200).json({
            message: 'Tokens refreshed successfully',
            data: {
                access_token: newAccessToken,
                refresh_token: newRefreshToken
            }
        });
    } catch (err) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ [REFRESH TOKEN ERROR]:', err.message);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        next(err);
    }
};


/**
 * Helper to delete uploaded file on error
 */
function cleanupUploadedFile(file) {
    if (file && file.filename) {
        const filePath = path.join(__dirname, '../../uploads/profiles', file.filename);
        deleteFile(filePath);
        console.log('🗑️  [CLEANUP] Deleted uploaded file after error');
    }
}

// ═══════════════════════════════════════════════════════════════════════
// REGISTRATION ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Register Passenger with optional profile picture
 * POST /api/auth/signup/passenger
 * Body: multipart/form-data
 * Fields: email, phone_e164, password, first_name, last_name, etc.
 * File: avatar (optional)
 */
exports.registerPassenger = async (req, res, next) => {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📝 [REGISTER PASSENGER] Request received');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('Body:', JSON.stringify(req.body, null, 2));
        console.log('File uploaded:', req.file ? req.file.filename : 'No file');

        handleValidation(req);

        // ✅ If profile picture uploaded, add URL to request body
        if (req.file) {
            req.body.avatar_url = getFileUrl(req.file.filename, 'profile');
            console.log('✅ [AVATAR] Profile picture URL:', req.body.avatar_url);
            console.log('📁 [FILE] Filename:', req.file.filename);
            console.log('📏 [FILE] Size:', (req.file.size / 1024).toFixed(2), 'KB');
        }

        const { account, otpDelivery } = await signupPassenger(req.body);

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ [REGISTER PASSENGER] Success!');
        console.log('🆔 Account UUID:', account.uuid);
        console.log('👤 Name:', account.first_name, account.last_name);
        console.log('📧 Email:', account.email || 'N/A');
        console.log('📱 Phone:', account.phone_e164 || 'N/A');
        console.log('🖼️  Avatar:', account.avatar_url || 'No avatar');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📨 [OTP DELIVERY STATUS]');
        if (otpDelivery.email) {
            console.log('   Email OTP:', otpDelivery.email.delivery);
        }
        if (otpDelivery.phone) {
            console.log('   SMS OTP:', otpDelivery.phone.delivery);
        }
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(201).json({
            message: 'Passenger registered successfully. OTP(s) sent for verification.',
            data: {
                uuid: account.uuid,
                user_type: account.user_type,
                email: account.email,
                phone_e164: account.phone_e164,
                first_name: account.first_name,
                last_name: account.last_name,
                avatar_url: account.avatar_url,
                status: account.status,
                email_verified: account.email_verified,
                phone_verified: account.phone_verified,
                otp_delivery: otpDelivery,
            },
        });
    } catch (err) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ [REGISTER PASSENGER ERROR]:', err.message);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        // Cleanup uploaded file on error
        cleanupUploadedFile(req.file);

        next(err);
    }
};

/**
 * Register Driver with optional profile picture
 * POST /api/auth/signup/driver
 * Body: multipart/form-data
 * Fields: email, phone_e164, password, first_name, last_name, license_number, vehicle_plate, etc.
 * File: avatar (optional)
 */
exports.registerDriver = async (req, res, next) => {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🚗 [REGISTER DRIVER] Request received');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('Body:', JSON.stringify(req.body, null, 2));
        console.log('File uploaded:', req.file ? req.file.filename : 'No file');

        handleValidation(req);

        // ✅ If profile picture uploaded, add URL to request body
        if (req.file) {
            req.body.avatar_url = getFileUrl(req.file.filename, 'profile');
            console.log('✅ [AVATAR] Profile picture URL:', req.body.avatar_url);
            console.log('📁 [FILE] Filename:', req.file.filename);
            console.log('📏 [FILE] Size:', (req.file.size / 1024).toFixed(2), 'KB');
        }

        const { account, otpDelivery } = await signupDriver(req.body);

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ [REGISTER DRIVER] Success!');
        console.log('🆔 Account UUID:', account.uuid);
        console.log('👤 Name:', account.first_name, account.last_name);
        console.log('📧 Email:', account.email || 'N/A');
        console.log('📱 Phone:', account.phone_e164 || 'N/A');
        console.log('🖼️  Avatar:', account.avatar_url || 'No avatar');
        console.log('⏳ Status: PENDING (awaiting admin approval)');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📨 [OTP DELIVERY STATUS]');
        if (otpDelivery.email) {
            console.log('   Email OTP:', otpDelivery.email.delivery);
        }
        if (otpDelivery.phone) {
            console.log('   SMS OTP:', otpDelivery.phone.delivery);
        }
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(201).json({
            message: 'Driver registered successfully. Pending admin approval. OTP(s) sent for verification.',
            data: {
                uuid: account.uuid,
                user_type: account.user_type,
                email: account.email,
                phone_e164: account.phone_e164,
                first_name: account.first_name,
                last_name: account.last_name,
                avatar_url: account.avatar_url,
                status: account.status,
                email_verified: account.email_verified,
                phone_verified: account.phone_verified,
                otp_delivery: otpDelivery,
            },
        });
    } catch (err) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ [REGISTER DRIVER ERROR]:', err.message);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        // Cleanup uploaded file on error
        cleanupUploadedFile(req.file);

        next(err);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// OTP ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Send OTP to user
 * POST /api/auth/otp/send
 * Body: { identifier, channel, purpose }
 * identifier: email or phone_e164
 * channel: 'EMAIL' or 'SMS'
 * purpose: 'verify_account', 'reset_password', etc.
 */
exports.sendOtp = async (req, res, next) => {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📨 [SEND OTP] Request received');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('Identifier:', req.body.identifier);
        console.log('Channel:', req.body.channel);
        console.log('Purpose:', req.body.purpose);

        handleValidation(req);
        const { identifier, channel, purpose } = req.body;

        const { account, otp } = await sendOtpByIdentifier({ identifier, channel, purpose });

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ [SEND OTP] OTP sent successfully!');
        console.log('👤 User Type:', account.user_type);
        console.log('📬 Delivery Status:', otp.delivery);
        console.log('📡 Channel:', otp.channel);
        console.log('🎯 Target:', otp.target);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(200).json({
            message: 'OTP sent successfully',
            data: {
                user_type: account.user_type,
                delivery: otp.delivery,
                channel: otp.channel,
                target: otp.target,
            }
        });
    } catch (err) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ [SEND OTP ERROR]:', err.message);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        next(err);
    }
};

/**
 * Verify OTP
 * POST /api/auth/otp/verify
 * Body: { identifier, purpose, code }
 */
exports.verifyOtp = async (req, res, next) => {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔍 [VERIFY OTP] Request received');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('Identifier:', req.body.identifier);
        console.log('Purpose:', req.body.purpose);
        console.log('Code entered:', req.body.code);

        handleValidation(req);
        const { identifier, purpose, code } = req.body;

        const { account } = await verifyOtp({ identifier, purpose, code });
        const canProceed = !!(account.email_verified || account.phone_verified);

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ [VERIFY OTP] OTP verified successfully!');
        console.log('👤 User UUID:', account.uuid);
        console.log('📧 Email verified:', account.email_verified);
        console.log('📱 Phone verified:', account.phone_verified);
        console.log('✅ Can proceed to login:', canProceed);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(200).json({
            message: 'OTP verified successfully',
            data: {
                uuid: account.uuid,
                user_type: account.user_type,
                email_verified: account.email_verified,
                phone_verified: account.phone_verified,
                status: account.status,
                canProceed
            }
        });
    } catch (err) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ [VERIFY OTP ERROR]:', err.message);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        next(err);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// LOGIN ENDPOINT
// ═══════════════════════════════════════════════════════════════════════

/**
 * Login
 * POST /api/auth/login
 * Body: { identifier, password }
 * identifier: email or phone_e164
 */
exports.login = async (req, res, next) => {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔐 [LOGIN] Request received');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📋 Identifier:', req.body.identifier);
        console.log('🌐 IP Address:', req.ip || req.connection.remoteAddress);
        console.log('🖥️  User Agent:', req.get('user-agent'));

        const { identifier, password } = req.body;

        // ═══════════════════════════════════════════════════════════════
        // STEP 1: VALIDATE INPUT
        // ═══════════════════════════════════════════════════════════════
        if (!identifier || !password) {
            console.log('❌ [LOGIN] Missing credentials');
            console.log('   Identifier provided:', !!identifier);
            console.log('   Password provided:', !!password);
            const err = new Error('Identifier and password are required');
            err.status = 400;
            throw err;
        }

        console.log('✅ [LOGIN] Input validation passed');

        // ═══════════════════════════════════════════════════════════════
        // STEP 2: FIND ACCOUNT
        // ═══════════════════════════════════════════════════════════════
        console.log('🔍 [LOGIN] Looking up account...');
        const account = await findAccountByIdentifier(identifier);

        if (!account) {
            console.log('❌ [LOGIN] Account not found');
            console.log('   Identifier attempted:', identifier);

            // Don't reveal whether account exists (security best practice)
            const err = new Error('Invalid credentials');
            err.status = 401;
            throw err;
        }

        console.log('✅ [LOGIN] Account found');
        console.log('   UUID:', account.uuid);
        console.log('   User Type:', account.user_type);
        console.log('   Status:', account.status);
        console.log('   Email:', account.email || 'Not set');
        console.log('   Phone:', account.phone_e164 || 'Not set');

        // ═══════════════════════════════════════════════════════════════
        // STEP 3: VERIFY PASSWORD
        // ═══════════════════════════════════════════════════════════════
        console.log('🔑 [LOGIN] Verifying password...');
        const isPasswordValid = await verifyPassword(password, account.password_hash);

        if (!isPasswordValid) {
            console.log('❌ [LOGIN] Invalid password');
            console.log('   Account UUID:', account.uuid);

            // TODO: Implement failed login attempt tracking here
            // e.g., increment failed_login_attempts, lock after 5 attempts

            const err = new Error('Invalid credentials');
            err.status = 401;
            throw err;
        }

        console.log('✅ [LOGIN] Password verified successfully');

        // ═══════════════════════════════════════════════════════════════
        // STEP 4: CHECK VERIFICATION STATUS
        // ═══════════════════════════════════════════════════════════════
        const isVerified = !!(account.email_verified || account.phone_verified);
        console.log('📧 [LOGIN] Email verified:', account.email_verified);
        console.log('📱 [LOGIN] Phone verified:', account.phone_verified);
        console.log('✅ [LOGIN] At least one verified:', isVerified);

        if (!isVerified) {
            console.log('❌ [LOGIN] Account not verified');
            console.log('   User must verify email or phone before logging in');

            const err = new Error('Please verify your email or phone number via OTP before logging in.');
            err.status = 403;
            err.code = 'ACCOUNT_NOT_VERIFIED';
            throw err;
        }

        // ═══════════════════════════════════════════════════════════════
        // STEP 5: CHECK ACCOUNT STATUS (ALL USER TYPES)
        // ═══════════════════════════════════════════════════════════════
        console.log('🔐 [LOGIN] Checking account status...');

        // Check for SUSPENDED status (applies to all user types)
        if (account.status === 'SUSPENDED') {
            console.log('🚫 [LOGIN] Account is SUSPENDED');
            console.log('   UUID:', account.uuid);
            console.log('   User Type:', account.user_type);

            const err = new Error('Your account has been suspended. Please contact support for assistance.');
            err.status = 403;
            err.code = 'ACCOUNT_SUSPENDED';
            throw err;
        }

        // Check for DELETED status (applies to all user types)
        if (account.status === 'DELETED') {
            console.log('🗑️  [LOGIN] Account is DELETED');
            console.log('   UUID:', account.uuid);
            console.log('   User Type:', account.user_type);

            const err = new Error('This account has been deleted and cannot be accessed.');
            err.status = 403;
            err.code = 'ACCOUNT_DELETED';
            throw err;
        }

        // ═══════════════════════════════════════════════════════════════
        // STEP 6: DRIVER-SPECIFIC STATUS CHECKS
        // ═══════════════════════════════════════════════════════════════
        if (account.user_type === 'DRIVER') {
            console.log('🚗 [LOGIN] Driver account detected');
            console.log('   Checking driver-specific approval status...');

            if (account.status === 'PENDING') {
                console.log('⏳ [LOGIN] Driver status: PENDING approval');
                console.log('   Driver can login but cannot accept rides');

                // Generate tokens even for pending drivers (they can view the app)
                const accessToken = signAccessToken(account);
                const refreshToken = signRefreshToken(account);

                // Remove sensitive fields
                const { password_hash, password_algo, ...safeAccount } = account.toJSON ? account.toJSON() : account;

                console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                console.log('✅ [LOGIN] Login successful (PENDING driver)');
                console.log('👤 User:', account.first_name, account.last_name);
                console.log('🎫 Tokens generated');
                console.log('⚠️  Status: PENDING - Cannot accept rides yet');
                console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

                return res.status(200).json({
                    message: 'Login successful. Your account is pending admin approval.',
                    warning: 'You cannot accept rides until your account is approved by an administrator.',
                    data: {
                        access_token: accessToken,
                        refresh_token: refreshToken,
                        user: safeAccount,
                        isPending: true
                    }
                });
            }

            console.log('✅ [LOGIN] Driver status: ACTIVE');
        }

        // ═══════════════════════════════════════════════════════════════
        // STEP 7: GENERATE TOKENS
        // ═══════════════════════════════════════════════════════════════
        console.log('🎫 [LOGIN] Generating authentication tokens...');

        const accessToken = signAccessToken(account);
        console.log('   ✅ Access token generated (short-lived)');

        const refreshToken = signRefreshToken(account);
        console.log('   ✅ Refresh token generated (long-lived)');

        // ═══════════════════════════════════════════════════════════════
        // STEP 8: PREPARE RESPONSE
        // ═══════════════════════════════════════════════════════════════

        // Remove sensitive fields from response
        const { password_hash, password_algo, ...safeAccount } = account.toJSON ? account.toJSON() : account;

        // TODO: Optional - Update last_login timestamp
        // await account.update({ last_login: new Date() });

        // TODO: Optional - Log login event for audit trail
        // await LoginLog.create({ accountId: account.uuid, ipAddress: req.ip });

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ [LOGIN] Login successful!');
        console.log('👤 User:', account.first_name, account.last_name);
        console.log('📧 Email:', account.email || 'N/A');
        console.log('📱 Phone:', account.phone_e164 || 'N/A');
        console.log('🎭 User Type:', account.user_type);
        console.log('✅ Status:', account.status);
        console.log('🎫 Access token: Generated');
        console.log('🔄 Refresh token: Generated');
        console.log('⏰ Timestamp:', new Date().toISOString());
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        // ═══════════════════════════════════════════════════════════════
        // STEP 9: SEND RESPONSE
        // ═══════════════════════════════════════════════════════════════
        res.status(200).json({
            message: 'Login successful',
            data: {
                access_token: accessToken,
                refresh_token: refreshToken,
                user: safeAccount,
                isPending: false
            }
        });

    } catch (err) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ [LOGIN ERROR]');
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('Error Message:', err.message);
        console.error('Error Code:', err.code || 'N/A');
        console.error('Status Code:', err.status || 500);
        console.error('Stack Trace:', err.stack);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        next(err);
    }
};


// ═══════════════════════════════════════════════════════════════════════
// PROFILE ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Get current user profile (requires authentication)
 * GET /api/auth/me
 */
exports.getProfile = async (req, res, next) => {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('👤 [GET PROFILE] Request received');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('User UUID:', req.user ? req.user.uuid : 'No user in request');

        if (!req.user) {
            const err = new Error('User not found in request');
            err.status = 401;
            throw err;
        }

        // Remove sensitive fields
        const { password_hash, password_algo, ...safeUser } = req.user.toJSON ? req.user.toJSON() : req.user;

        console.log('✅ [GET PROFILE] Profile retrieved');
        console.log('👤 Name:', safeUser.first_name, safeUser.last_name);
        console.log('📧 Email:', safeUser.email || 'N/A');
        console.log('📱 Phone:', safeUser.phone_e164 || 'N/A');
        console.log('🖼️  Avatar:', safeUser.avatar_url || 'No avatar');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(200).json({
            message: 'Profile retrieved successfully',
            data: safeUser
        });
    } catch (err) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ [GET PROFILE ERROR]:', err.message);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        next(err);
    }
};

/**
 * Update user avatar (profile picture)
 * PATCH /api/auth/me/avatar
 * Requires authentication
 * File: avatar (required)
 */
exports.updateAvatar = async (req, res, next) => {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🖼️  [UPDATE AVATAR] Request received');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('User UUID:', req.user ? req.user.uuid : 'No user');
        console.log('File uploaded:', req.file ? req.file.filename : 'No file');

        if (!req.file) {
            console.log('❌ [UPDATE AVATAR] No file uploaded');
            const err = new Error('No file uploaded');
            err.status = 400;
            throw err;
        }

        console.log('📁 [FILE] Filename:', req.file.filename);
        console.log('📏 [FILE] Size:', (req.file.size / 1024).toFixed(2), 'KB');

        // Generate new avatar URL
        const newAvatarUrl = getFileUrl(req.file.filename, 'profile');
        console.log('✅ [AVATAR] New URL:', newAvatarUrl);

        // Delete old avatar if exists
        if (req.user.avatar_url) {
            const oldFilename = getFilenameFromUrl(req.user.avatar_url);
            if (oldFilename) {
                const oldFilePath = path.join(__dirname, '../../uploads/profiles', oldFilename);
                deleteFile(oldFilePath);
                console.log('🗑️  [CLEANUP] Deleted old avatar:', oldFilename);
            }
        }

        // Update account with new avatar URL
        const account = await Account.findByPk(req.user.uuid);
        if (!account) {
            console.log('❌ [UPDATE AVATAR] Account not found');
            cleanupUploadedFile(req.file);
            const err = new Error('Account not found');
            err.status = 404;
            throw err;
        }

        await account.update({ avatar_url: newAvatarUrl });
        console.log('✅ [DB UPDATE] Avatar URL saved to database');

        // Remove sensitive fields
        const { password_hash, password_algo, ...safeAccount } = account.toJSON();

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ [UPDATE AVATAR] Avatar updated successfully!');
        console.log('👤 User:', account.first_name, account.last_name);
        console.log('🖼️  New Avatar:', newAvatarUrl);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(200).json({
            message: 'Avatar updated successfully',
            data: {
                avatar_url: newAvatarUrl,
                user: safeAccount
            }
        });
    } catch (err) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ [UPDATE AVATAR ERROR]:', err.message);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        // Cleanup uploaded file on error
        cleanupUploadedFile(req.file);

        next(err);
    }
};

/**
 * Logout (optional - for token invalidation with Redis)
 * POST /api/auth/logout
 */
exports.logout = async (req, res, next) => {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('👋 [LOGOUT] Request received');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('User UUID:', req.user ? req.user.uuid : 'No user');

        // TODO: If using Redis for token blacklist, add token to blacklist here
        // await redisClient.set(`blacklist:${token}`, '1', 'EX', tokenTTL);

        console.log('✅ [LOGOUT] Logout successful');
        console.log('ℹ️  [INFO] Client should delete access token');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(200).json({
            message: 'Logged out successfully'
        });
    } catch (err) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ [LOGOUT ERROR]:', err.message);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        next(err);
    }
};