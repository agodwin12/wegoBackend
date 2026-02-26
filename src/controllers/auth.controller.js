// src/controllers/auth.controller.js
const { validationResult } = require('express-validator');
const multer = require('multer');
const { signupPassenger, signupDriver } = require('../services/auth.services');
const { sendOtpByIdentifier, verifyOtpAndCreateAccount } = require('../services/otp.service');
const {
    findAccountByIdentifier,
    verifyPassword,
    canAccountLogin,
    isAccountLocked,
    trackFailedLoginAttempt,
    resetFailedLoginAttempts,
    generateTokens,
    refreshAccessToken,
    invalidateRefreshToken,
    invalidateAllRefreshTokens,
} = require('../services/login.service');
const { uploadToR2, deleteFromR2 } = require('../utils/r2Upload');
const { Account, PassengerProfile, DriverProfile } = require('../models');

/**
 * Validation helper - returns user-friendly error messages
 */
function handleValidation(req) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        const message = errors.array().map(e => `${e.param}: ${e.msg}`).join(', ');
        console.log('❌ [VALIDATION ERROR]:', message);
        const err = new Error(message);
        err.status = 400;
        err.code = 'VALIDATION_ERROR';
        throw err;
    }
}

// ═══════════════════════════════════════════════════════════════════════
// MULTER CONFIGURATION - MEMORY STORAGE FOR R2 UPLOAD
// ═══════════════════════════════════════════════════════════════════════

const memoryStorage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|pdf|webp/;
    const ext = file.originalname.toLowerCase().match(/\.[^.]*$/)?.[0] || '';
    const isExtValid = allowedTypes.test(ext);

    const isMimeValid =
        allowedTypes.test(file.mimetype) ||
        file.mimetype === 'application/octet-stream';

    if (isExtValid && isMimeValid) {
        return cb(null, true);
    } else {
        return cb(
            new Error(
                `Invalid file type for ${file.fieldname}. Only JPEG, JPG, PNG, PDF, WEBP allowed.`
            )
        );
    }
};

/**
 * Multer middleware for single profile photo upload (Passenger)
 */
const uploadPassengerPhoto = multer({
    storage: memoryStorage,
    fileFilter: fileFilter,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
}).single('avatar');

/**
 * Multer middleware for multiple driver files
 */
const uploadDriverFiles = multer({
    storage: memoryStorage,
    fileFilter: fileFilter,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per file
}).fields([
    { name: 'avatar', maxCount: 1 },
    { name: 'license', maxCount: 1 },
    { name: 'insurance', maxCount: 1 },
    { name: 'vehicle_photo', maxCount: 1 },
]);

// ═══════════════════════════════════════════════════════════════════════
// REFRESH TOKEN
// ═══════════════════════════════════════════════════════════════════════

exports.refreshToken = async (req, res, next) => {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔄 [REFRESH TOKEN] Request received');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        const { refresh_token } = req.body;

        if (!refresh_token) {
            console.log('❌ [REFRESH TOKEN] Missing refresh token');
            return res.status(400).json({
                success: false,
                message: 'Refresh token is required',
                code: 'MISSING_REFRESH_TOKEN',
            });
        }

        console.log('🔍 [REFRESH TOKEN] Verifying and refreshing token...');

        // Use the new refresh service
        const result = await refreshAccessToken(refresh_token);

        if (!result.success) {
            console.log('❌ [REFRESH TOKEN] Failed:', result.error);

            const errorMessages = {
                'INVALID_REFRESH_TOKEN': 'Invalid or expired refresh token. Please login again.',
                'ACCOUNT_INACTIVE': 'Account is no longer active',
                'REFRESH_FAILED': 'Failed to refresh token'
            };

            const statusCodes = {
                'INVALID_REFRESH_TOKEN': 401,
                'ACCOUNT_INACTIVE': 403,
                'REFRESH_FAILED': 500
            };

            return res.status(statusCodes[result.error] || 500).json({
                success: false,
                message: errorMessages[result.error] || 'Failed to refresh token',
                code: result.error,
            });
        }

        // Build complete user object
        const account = result.account;
        const accountData = account.toJSON ? account.toJSON() : account;
        const { password_hash, password_algo, ...safeAccount } = accountData;
        let completeUser = { ...safeAccount };

        // Include profile data
        if (account.user_type === 'PASSENGER' && account.passenger_profile) {
            const profile = account.passenger_profile.toJSON
                ? account.passenger_profile.toJSON()
                : account.passenger_profile;

            completeUser.profile = {
                address_text: profile.address_text,
                notes: profile.notes,
            };
        }

        if (account.user_type === 'DRIVER' && account.driver_profile) {
            const profile = account.driver_profile.toJSON
                ? account.driver_profile.toJSON()
                : account.driver_profile;

            completeUser.profile = {
                cni_number: profile.cni_number,
                license_number: profile.license_number,
                license_expiry: profile.license_expiry,
                license_document_url: profile.license_document_url,
                insurance_number: profile.insurance_number,
                insurance_expiry: profile.insurance_expiry,
                insurance_document_url: profile.insurance_document_url,
                vehicle_type: profile.vehicle_type,
                vehicle_make_model: profile.vehicle_make_model,
                vehicle_color: profile.vehicle_color,
                vehicle_year: profile.vehicle_year,
                vehicle_plate: profile.vehicle_plate,
                vehicle_photo_url: profile.vehicle_photo_url,
                verification_state: profile.verification_state,
                is_online: profile.is_online,
                is_available: profile.is_available,
            };
        }

        delete completeUser.passenger_profile;
        delete completeUser.driver_profile;

        console.log('✅ [REFRESH TOKEN] Token refreshed successfully');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(200).json({
            success: true,
            message: 'Token refreshed successfully',
            data: {
                access_token: result.accessToken,
                expires_in: result.expiresIn,
                user: completeUser,
            },
        });
    } catch (err) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ [REFRESH TOKEN ERROR]:', err.message);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(err.status || 500).json({
            success: false,
            message: err.message || 'Failed to refresh token',
            code: err.code || 'REFRESH_TOKEN_ERROR',
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// REGISTER PASSENGER - CREATE PENDING SIGNUP
// ═══════════════════════════════════════════════════════════════════════

exports.registerPassenger = [
    uploadPassengerPhoto,
    async (req, res, next) => {
        try {
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('📝 [REGISTER PASSENGER] Request received');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('Body:', JSON.stringify(req.body, null, 2));
            console.log('File uploaded:', req.file ? req.file.originalname : 'No file');

            handleValidation(req);

            // Upload profile photo to R2 if provided
            if (req.file) {
                console.log('📤 [PASSENGER] Uploading profile photo to R2...');
                try {
                    const avatarUrl = await uploadToR2(
                        req.file.buffer,
                        req.file.originalname,
                        'profiles',
                        req.file.mimetype
                    );
                    req.body.avatar_url = avatarUrl;
                    console.log('✅ [AVATAR] Profile photo uploaded:', avatarUrl);
                } catch (uploadError) {
                    console.error('❌ [AVATAR] Upload failed:', uploadError.message);
                    return res.status(500).json({
                        success: false,
                        message: 'Failed to upload profile photo',
                        code: 'AVATAR_UPLOAD_FAILED',
                    });
                }
            }

            // Create pending signup (not real account yet!)
            const pendingSignup = await signupPassenger(req.body);

            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('✅ [REGISTER PASSENGER] Pending signup created!');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            // Return signup_id instead of account details
            return res.status(200).json({
                success: true,
                message: 'Verification code sent. Please verify to complete registration.',
                data: {
                    signup_id: pendingSignup.uuid,
                    user_type: pendingSignup.user_type,
                    email: pendingSignup.email,
                    phone_e164: pendingSignup.phone_e164,
                    first_name: pendingSignup.first_name,
                    last_name: pendingSignup.last_name,
                    otp_delivery: pendingSignup.otpDelivery,
                },
            });
        } catch (err) {
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.error('❌ [REGISTER PASSENGER ERROR]:', err.message);
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            // Clean up uploaded file if registration failed
            if (req.body.avatar_url) {
                console.log('🗑️  [CLEANUP] Deleting uploaded avatar from R2...');
                await deleteFromR2(req.body.avatar_url);
            }

            res.status(err.status || 500).json({
                success: false,
                message: err.message || 'Failed to register passenger',
                code: err.code || 'REGISTRATION_ERROR',
            });
        }
    },
];

// ═══════════════════════════════════════════════════════════════════════
// REGISTER DRIVER - CREATE PENDING SIGNUP
// ═══════════════════════════════════════════════════════════════════════

exports.registerDriver = [
    uploadDriverFiles,
    async (req, res, next) => {
        try {
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('🚗 [REGISTER DRIVER] Request received');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('Body:', JSON.stringify(req.body, null, 2));
            console.log('Files uploaded:', req.files ? Object.keys(req.files) : 'No files');

            handleValidation(req);

            const uploadedUrls = {}; // Track uploaded URLs for cleanup on error

            // ─────────────────────────────────────────────────────────────
            // UPLOAD FILES TO R2
            // ─────────────────────────────────────────────────────────────

            try {
                // Avatar (optional)
                if (req.files.avatar && req.files.avatar[0]) {
                    console.log('📤 [DRIVER] Uploading avatar to R2...');
                    const avatarUrl = await uploadToR2(
                        req.files.avatar[0].buffer,
                        req.files.avatar[0].originalname,
                        'profiles',
                        req.files.avatar[0].mimetype
                    );
                    req.body.avatar_url = avatarUrl;
                    uploadedUrls.avatar_url = avatarUrl;
                    console.log('✅ [AVATAR] Uploaded:', avatarUrl);
                }

                // Driver's License (REQUIRED)
                if (req.files.license && req.files.license[0]) {
                    console.log('📤 [DRIVER] Uploading license document to R2...');
                    const licenseUrl = await uploadToR2(
                        req.files.license[0].buffer,
                        req.files.license[0].originalname,
                        'documents',
                        req.files.license[0].mimetype
                    );
                    req.body.license_document_url = licenseUrl;
                    uploadedUrls.license_document_url = licenseUrl;
                    console.log('✅ [LICENSE] Uploaded:', licenseUrl);
                } else {
                    console.log('❌ [LICENSE] License document is required');
                    return res.status(400).json({
                        success: false,
                        message: 'Driver license document is required',
                        code: 'MISSING_LICENSE_DOCUMENT',
                    });
                }

                // Insurance document (optional)
                if (req.files.insurance && req.files.insurance[0]) {
                    console.log('📤 [DRIVER] Uploading insurance document to R2...');
                    const insuranceUrl = await uploadToR2(
                        req.files.insurance[0].buffer,
                        req.files.insurance[0].originalname,
                        'documents',
                        req.files.insurance[0].mimetype
                    );
                    req.body.insurance_document_url = insuranceUrl;
                    uploadedUrls.insurance_document_url = insuranceUrl;
                    console.log('✅ [INSURANCE] Uploaded:', insuranceUrl);
                }

                // Vehicle photo (optional)
                if (req.files.vehicle_photo && req.files.vehicle_photo[0]) {
                    console.log('📤 [DRIVER] Uploading vehicle photo to R2...');
                    const vehicleUrl = await uploadToR2(
                        req.files.vehicle_photo[0].buffer,
                        req.files.vehicle_photo[0].originalname,
                        'vehicles',
                        req.files.vehicle_photo[0].mimetype
                    );
                    req.body.vehicle_photo_url = vehicleUrl;
                    uploadedUrls.vehicle_photo_url = vehicleUrl;
                    console.log('✅ [VEHICLE] Uploaded:', vehicleUrl);
                }
            } catch (uploadError) {
                console.error('❌ [UPLOAD ERROR]:', uploadError.message);

                // Cleanup any files that were uploaded before the error
                console.log('🗑️  [CLEANUP] Deleting uploaded files from R2...');
                for (const url of Object.values(uploadedUrls)) {
                    await deleteFromR2(url);
                }

                return res.status(500).json({
                    success: false,
                    message: 'Failed to upload documents',
                    code: 'FILE_UPLOAD_FAILED',
                    error: uploadError.message,
                });
            }

            // ─────────────────────────────────────────────────────────────
            // CREATE PENDING DRIVER SIGNUP
            // ─────────────────────────────────────────────────────────────

            try {
                // Create pending signup (not real account yet!)
                const pendingSignup = await signupDriver(req.body);

                console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                console.log('✅ [REGISTER DRIVER] Pending signup created!');
                console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

                // Return signup_id instead of account details
                return res.status(200).json({
                    success: true,
                    message: 'Verification code sent. Please verify to complete registration.',
                    data: {
                        signup_id: pendingSignup.uuid,
                        user_type: pendingSignup.user_type,
                        email: pendingSignup.email,
                        phone_e164: pendingSignup.phone_e164,
                        first_name: pendingSignup.first_name,
                        last_name: pendingSignup.last_name,
                        otp_delivery: pendingSignup.otpDelivery,
                    },
                });
            } catch (signupError) {
                // If signup fails, cleanup uploaded files
                console.log('🗑️  [CLEANUP] Signup failed, deleting uploaded files from R2...');
                for (const url of Object.values(uploadedUrls)) {
                    await deleteFromR2(url);
                }
                throw signupError;
            }
        } catch (err) {
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.error('❌ [REGISTER DRIVER ERROR]:', err.message);
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            res.status(err.status || 500).json({
                success: false,
                message: err.message || 'Failed to register driver',
                code: err.code || 'REGISTRATION_ERROR',
            });
        }
    },
];

// ═══════════════════════════════════════════════════════════════════════
// OTP ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════

exports.sendOtp = async (req, res, next) => {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📨 [SEND OTP] Request received');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        handleValidation(req);
        const { identifier, channel, purpose } = req.body;

        const { account, otp } = await sendOtpByIdentifier({ identifier, channel, purpose });

        console.log('✅ [SEND OTP] OTP sent successfully!');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(200).json({
            success: true,
            message: 'OTP sent successfully',
            data: {
                user_type: account.user_type,
                delivery: otp.delivery,
                channel: otp.channel,
                target: otp.target,
            },
        });
    } catch (err) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ [SEND OTP ERROR]:', err.message);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(err.status || 500).json({
            success: false,
            message: err.message || 'Failed to send OTP',
            code: err.code || 'OTP_SEND_ERROR',
        });
    }
};

exports.verifyOtp = async (req, res, next) => {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔍 [VERIFY OTP] Request received');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        handleValidation(req);
        const { identifier, purpose, code } = req.body;

        // This now creates the account!
        const { account } = await verifyOtpAndCreateAccount({ identifier, purpose, code });

        console.log('✅ [VERIFY OTP] OTP verified and account created!');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(200).json({
            success: true,
            message: 'Account created successfully! You can now login.',
            data: {
                uuid: account.uuid,
                user_type: account.user_type,
                email: account.email,
                phone_e164: account.phone_e164,
                first_name: account.first_name,
                last_name: account.last_name,
                status: account.status,
                email_verified: account.email_verified,
                phone_verified: account.phone_verified,
            },
        });
    } catch (err) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ [VERIFY OTP ERROR]:', err.message);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(err.status || 500).json({
            success: false,
            message: err.message || 'Failed to verify OTP',
            code: err.code || 'OTP_VERIFY_ERROR',
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// LOGIN ENDPOINT (WITH REFRESH TOKEN & SECURITY)
// ═══════════════════════════════════════════════════════════════════════

exports.login = async (req, res, next) => {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔐 [LOGIN] Request received');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        const { identifier, password } = req.body;

        if (!identifier || !password) {
            console.log('❌ [LOGIN] Missing credentials');
            return res.status(400).json({
                success: false,
                message: 'Identifier and password are required',
                code: 'MISSING_CREDENTIALS',
            });
        }

        console.log('🔍 [LOGIN] Looking up account...');

        const account = await findAccountByIdentifier(identifier);

        if (!account) {
            console.log('❌ [LOGIN] Account not found');
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials',
                code: 'INVALID_CREDENTIALS',
            });
        }

        // Check if account is locked
        const lockStatus = await isAccountLocked(account.uuid);
        if (lockStatus.locked) {
            console.log('🔒 [LOGIN] Account is locked');
            return res.status(429).json({
                success: false,
                message: `Too many failed login attempts. Account locked for ${Math.ceil(lockStatus.remainingTime / 60)} more minutes.`,
                code: 'ACCOUNT_LOCKED',
                data: {
                    remainingTime: lockStatus.remainingTime,
                },
            });
        }

        console.log('🔑 [LOGIN] Verifying password...');

        const isPasswordValid = await verifyPassword(password, account.password_hash);

        if (!isPasswordValid) {
            console.log('❌ [LOGIN] Invalid password');

            // Track failed attempt
            const attemptResult = await trackFailedLoginAttempt(account.uuid);

            if (attemptResult.locked) {
                return res.status(429).json({
                    success: false,
                    message: `Too many failed login attempts. Account locked for ${attemptResult.lockoutDuration / 60} minutes.`,
                    code: 'ACCOUNT_LOCKED',
                    data: {
                        attempts: attemptResult.attempts,
                        lockoutDuration: attemptResult.lockoutDuration,
                    },
                });
            }

            return res.status(401).json({
                success: false,
                message: 'Invalid credentials',
                code: 'INVALID_CREDENTIALS',
                data: {
                    remainingAttempts: attemptResult.remainingAttempts,
                },
            });
        }

        console.log('✅ [LOGIN] Password verified');

        // Check if account can login
        const eligibility = canAccountLogin(account);
        if (!eligibility.allowed) {
            console.log('❌ [LOGIN] Login not allowed:', eligibility.reason);

            const statusCodes = {
                'ACCOUNT_SUSPENDED': 403,
                'ACCOUNT_INACTIVE': 403,
                'PHONE_NOT_VERIFIED': 403,
                'PROFILE_INCOMPLETE': 403,
                'VERIFICATION_REJECTED': 403,
            };

            return res.status(statusCodes[eligibility.reason] || 403).json({
                success: false,
                message: eligibility.message,
                code: eligibility.reason,
                requiresOtp: eligibility.requiresOtp || false,
            });
        }

        console.log('✅ [LOGIN] Eligibility check passed');

        // Reset failed attempts on successful login
        await resetFailedLoginAttempts(account.uuid);

        // Generate tokens (access + refresh)
        console.log('🎫 [LOGIN] Generating tokens...');
        const tokens = await generateTokens(account);

        // Build complete user object
        const accountData = account.toJSON ? account.toJSON() : account;
        const { password_hash, password_algo, ...safeAccount } = accountData;
        let completeUser = { ...safeAccount };

        if (account.user_type === 'PASSENGER' && account.passenger_profile) {
            console.log('👤 [LOGIN] Including passenger profile data');
            const profile = account.passenger_profile.toJSON
                ? account.passenger_profile.toJSON()
                : account.passenger_profile;

            completeUser.profile = {
                address_text: profile.address_text,
                notes: profile.notes,
            };
        }

        if (account.user_type === 'DRIVER' && account.driver_profile) {
            console.log('🚗 [LOGIN] Including driver profile data');
            const profile = account.driver_profile.toJSON
                ? account.driver_profile.toJSON()
                : account.driver_profile;

            completeUser.profile = {
                cni_number: profile.cni_number,
                license_number: profile.license_number,
                license_expiry: profile.license_expiry,
                license_document_url: profile.license_document_url,
                insurance_number: profile.insurance_number,
                insurance_expiry: profile.insurance_expiry,
                insurance_document_url: profile.insurance_document_url,
                vehicle_type: profile.vehicle_type,
                vehicle_make_model: profile.vehicle_make_model,
                vehicle_color: profile.vehicle_color,
                vehicle_year: profile.vehicle_year,
                vehicle_plate: profile.vehicle_plate,
                vehicle_photo_url: profile.vehicle_photo_url,
                verification_state: profile.verification_state,
                is_online: profile.is_online,
                is_available: profile.is_available,
            };
        }

        delete completeUser.passenger_profile;
        delete completeUser.driver_profile;

        // Check for pending driver
        if (account.user_type === 'DRIVER' && account.status === 'PENDING') {
            console.log('⏳ [LOGIN] Driver status: PENDING approval');

            console.log('✅ [LOGIN] Login successful (PENDING driver)');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            return res.status(200).json({
                success: true,
                message: 'Login successful. Your account is pending admin approval.',
                warning: 'You cannot accept rides until your account is approved by an administrator.',
                data: {
                    access_token: tokens.accessToken,
                    refresh_token: tokens.refreshToken,
                    expires_in: tokens.expiresIn,
                    refresh_expires_in: tokens.refreshExpiresIn,
                    user: completeUser,
                    isPending: true,
                },
            });
        }

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ [LOGIN] Login successful!');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(200).json({
            success: true,
            message: 'Login successful',
            data: {
                access_token: tokens.accessToken,
                refresh_token: tokens.refreshToken,
                expires_in: tokens.expiresIn,
                refresh_expires_in: tokens.refreshExpiresIn,
                user: completeUser,
                isPending: false,
            },
        });
    } catch (err) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ [LOGIN ERROR]:', err.message);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(err.status || 500).json({
            success: false,
            message: err.message || 'Login failed',
            code: err.code || 'LOGIN_ERROR',
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// PROFILE ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════

exports.getProfile = async (req, res, next) => {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('👤 [GET PROFILE] Request received');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        if (!req.user) {
            return res.status(401).json({
                success: false,
                message: 'User not authenticated',
                code: 'NOT_AUTHENTICATED',
            });
        }

        const { password_hash, password_algo, ...safeUser } = req.user.toJSON
            ? req.user.toJSON()
            : req.user;

        console.log('✅ [GET PROFILE] Profile retrieved');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(200).json({
            success: true,
            message: 'Profile retrieved successfully',
            data: safeUser,
        });
    } catch (err) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ [GET PROFILE ERROR]:', err.message);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(err.status || 500).json({
            success: false,
            message: err.message || 'Failed to retrieve profile',
            code: err.code || 'PROFILE_ERROR',
        });
    }
};

exports.updateAvatar = [
    uploadPassengerPhoto,
    async (req, res, next) => {
        try {
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('🖼️  [UPDATE AVATAR] Request received');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

            if (!req.file) {
                console.log('❌ [UPDATE AVATAR] No file uploaded');
                return res.status(400).json({
                    success: false,
                    message: 'No file uploaded',
                    code: 'NO_FILE_UPLOADED',
                });
            }

            // Upload new avatar to R2
            console.log('📤 [UPDATE AVATAR] Uploading to R2...');
            const newAvatarUrl = await uploadToR2(
                req.file.buffer,
                req.file.originalname,
                'profiles',
                req.file.mimetype
            );

            // Delete old avatar from R2 if exists
            if (req.user.avatar_url) {
                console.log('🗑️  [UPDATE AVATAR] Deleting old avatar from R2...');
                await deleteFromR2(req.user.avatar_url);
            }

            const account = await Account.findByPk(req.user.uuid);
            if (!account) {
                // Cleanup uploaded file
                await deleteFromR2(newAvatarUrl);
                return res.status(404).json({
                    success: false,
                    message: 'Account not found',
                    code: 'ACCOUNT_NOT_FOUND',
                });
            }

            await account.update({ avatar_url: newAvatarUrl });
            const { password_hash, password_algo, ...safeAccount } = account.toJSON();

            console.log('✅ [UPDATE AVATAR] Avatar updated successfully!');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            res.status(200).json({
                success: true,
                message: 'Avatar updated successfully',
                data: {
                    avatar_url: newAvatarUrl,
                    user: safeAccount,
                },
            });
        } catch (err) {
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.error('❌ [UPDATE AVATAR ERROR]:', err.message);
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            res.status(err.status || 500).json({
                success: false,
                message: err.message || 'Failed to update avatar',
                code: err.code || 'AVATAR_UPDATE_ERROR',
            });
        }
    },
];

// ═══════════════════════════════════════════════════════════════════════
// LOGOUT (INVALIDATE REFRESH TOKEN)
// ═══════════════════════════════════════════════════════════════════════

exports.logout = async (req, res, next) => {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('👋 [LOGOUT] Request received');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        const { refresh_token, logout_all } = req.body;

        if (logout_all) {
            // Logout from all devices
            console.log('🚪 [LOGOUT] Logging out from ALL devices...');
            await invalidateAllRefreshTokens(req.user.uuid);
            console.log('✅ [LOGOUT] All refresh tokens invalidated');
        } else if (refresh_token) {
            // Logout from this device only
            console.log('🚪 [LOGOUT] Logging out from this device...');
            await invalidateRefreshToken(refresh_token);
            console.log('✅ [LOGOUT] Refresh token invalidated');
        } else {
            console.log('⚠️ [LOGOUT] No refresh token provided, client-side logout only');
        }

        console.log('✅ [LOGOUT] Logout successful');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(200).json({
            success: true,
            message: 'Logged out successfully',
        });
    } catch (err) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ [LOGOUT ERROR]:', err.message);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(err.status || 500).json({
            success: false,
            message: err.message || 'Logout failed',
            code: err.code || 'LOGOUT_ERROR',
        });
    }
};