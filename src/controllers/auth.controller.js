// src/controllers/auth.controller.js
'use strict';

const { validationResult } = require('express-validator');
const multer = require('multer');
const { googleAuth: googleAuthService } = require('../services/googleAccount.service');
const { signupPassenger, signupDriver } = require('../services/auth.services');

const {
    sendOtpByIdentifier,
    verifyOtpAndCreateAccount,
} = require('../services/otp.service');

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

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

function handleValidation(req) {
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
        const message = errors
            .array()
            .map(e => `${e.param || e.path}: ${e.msg}`)
            .join(', ');

        console.log('❌ [VALIDATION ERROR]:', message);

        const err = new Error(message);
        err.status = 400;
        err.code = 'VALIDATION_ERROR';
        throw err;
    }
}

function buildCompleteUser(account) {
    if (!account) return null;

    const accountData = account.toJSON ? account.toJSON() : account;

    const {
        password_hash,
        password_algo,
        passenger_profile,
        driver_profile,
        ...safeAccount
    } = accountData;

    const completeUser = {
        ...safeAccount,
        user_type: account.user_type,
        active_mode: account.active_mode || null,
        status: account.status,
    };

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

    if (account.user_type === 'DELIVERY_AGENT' && account.driver_record) {
        const driverRecord = account.driver_record.toJSON
            ? account.driver_record.toJSON()
            : account.driver_record;

        completeUser.driver_record = {
            id: driverRecord.id,
            userId: driverRecord.userId,
            status: driverRecord.status,
            current_mode: driverRecord.current_mode,
            phone: driverRecord.phone,
            rating: driverRecord.rating,
            lat: driverRecord.lat,
            lng: driverRecord.lng,
            delivery_wallet: driverRecord.delivery_wallet || null,
        };
    }

    return completeUser;
}

function getClientTokenOptions(req) {
    return {
        ip_address: req.ip || req.headers['x-forwarded-for'] || null,
        user_agent: req.headers['user-agent'] || null,
    };
}




function cleanupUploadedUrls(uploadedUrls) {
    return Promise.all(
        Object.values(uploadedUrls || {}).map(async url => {
            try {
                if (url) {
                    await deleteFromR2(url);
                    console.log('   ✅ Deleted:', url);
                }
            } catch (err) {
                console.warn('   ⚠️ Failed to delete uploaded file:', url, err.message);
            }
        })
    );
}

// ═══════════════════════════════════════════════════════════════════════
// MULTER CONFIGURATION
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
    }

    return cb(
        new Error(
            `Invalid file type for ${file.fieldname}. Only JPEG, JPG, PNG, PDF, WEBP allowed.`
        )
    );
};

const uploadPassengerPhoto = multer({
    storage: memoryStorage,
    fileFilter,
    limits: {
        fileSize: 10 * 1024 * 1024,
    },
}).single('avatar');

const uploadDriverFiles = multer({
    storage: memoryStorage,
    fileFilter,
    limits: {
        fileSize: 10 * 1024 * 1024,
    },
}).fields([
    { name: 'avatar', maxCount: 1 },
    { name: 'license', maxCount: 1 },
    { name: 'insurance', maxCount: 1 },
    { name: 'vehicle_photo', maxCount: 1 },
]);

// ═══════════════════════════════════════════════════════════════════════
// REFRESH TOKEN
// POST /api/auth/refresh
// POST /api/auth/refresh-token if you added route alias
// ═══════════════════════════════════════════════════════════════════════

exports.googleAuth = async (req, res) => {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔐 [GOOGLE AUTH] Request received');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        const {
            id_token,
            user_type,
        } = req.body || {};

        if (!id_token) {
            return res.status(400).json({
                success: false,
                message: 'Google ID token is required.',
                code: 'GOOGLE_ID_TOKEN_REQUIRED',
            });
        }

        // user_type is optional: omit to LOG IN (existing account), or send
        // PASSENGER/DRIVER to SIGN UP a new account in that role.
        const result = await googleAuthService({
            idToken: id_token,
            userType: user_type,
            tokenOptions: getClientTokenOptions(req),
        });

        const {
            tokens,
            user,
            flags,
            isNewAccount,
        } = result;

        console.log('✅ [GOOGLE AUTH] Successful');
        console.log('   User UUID  :', user?.uuid);
        console.log('   User Type  :', user?.user_type);
        console.log('   Active Mode:', user?.active_mode);
        console.log('   New Account:', isNewAccount);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        let message = 'Google authentication successful.';

        if (user?.user_type === 'DRIVER' && flags.requires_driver_profile) {
            message = 'Google authentication successful. Please complete your driver profile.';
        } else if (flags.requires_phone_verification) {
            message = 'Google authentication successful. Please verify your phone number.';
        }

        return res.status(200).json({
            success: true,
            message,
            data: {
                access_token: tokens.accessToken,
                refresh_token: tokens.refreshToken,
                expires_in: tokens.expiresIn,
                refresh_expires_in: tokens.refreshExpiresIn,

                user,

                is_new_account: isNewAccount,

                requires_phone_verification: flags.requires_phone_verification,
                requires_driver_profile: flags.requires_driver_profile,
                requires_admin_approval: flags.requires_admin_approval,
            },
        });

    } catch (err) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ [GOOGLE AUTH ERROR]:', err.message);
        console.error(err.stack);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(err.status || 500).json({
            success: false,
            message: err.message || 'Google authentication failed.',
            code: err.code || 'GOOGLE_AUTH_ERROR',
        });
    }
};


exports.refreshToken = async (req, res) => {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔄 [REFRESH TOKEN] Request received');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        const { refresh_token } = req.body;

        if (!refresh_token) {
            return res.status(400).json({
                success: false,
                message: 'Refresh token is required',
                code: 'MISSING_REFRESH_TOKEN',
            });
        }

        const result = await refreshAccessToken(
            refresh_token,
            getClientTokenOptions(req)
        );

        if (!result.success) {
            console.log('❌ [REFRESH TOKEN] Failed:', result.error);

            const errorMessages = {
                MISSING_REFRESH_TOKEN: 'Refresh token is required.',
                INVALID_REFRESH_TOKEN: 'Invalid or expired refresh token. Please login again.',
                ACCOUNT_NOT_FOUND: 'Account not found. Please login again.',
                ACCOUNT_DELETED: 'This account has been deleted.',
                ACCOUNT_SUSPENDED: 'Your account has been suspended. Please contact support.',
                ACCOUNT_INACTIVE: 'Account is no longer active.',
                WALLET_FROZEN: 'Your delivery wallet is frozen. Please contact support.',
                WALLET_SUSPENDED: 'Your delivery wallet is suspended. Please contact support.',
                REFRESH_FAILED: 'Failed to refresh token.',
            };

            const statusCodes = {
                MISSING_REFRESH_TOKEN: 400,
                INVALID_REFRESH_TOKEN: 401,
                ACCOUNT_NOT_FOUND: 401,
                ACCOUNT_DELETED: 403,
                ACCOUNT_SUSPENDED: 403,
                ACCOUNT_INACTIVE: 403,
                WALLET_FROZEN: 403,
                WALLET_SUSPENDED: 403,
                REFRESH_FAILED: 500,
            };

            return res.status(statusCodes[result.error] || 500).json({
                success: false,
                message: errorMessages[result.error] || 'Failed to refresh token',
                code: result.error,
                shouldRelogin: [
                    'INVALID_REFRESH_TOKEN',
                    'ACCOUNT_NOT_FOUND',
                    'ACCOUNT_DELETED',
                ].includes(result.error),
            });
        }

        const completeUser = buildCompleteUser(result.account);

        console.log('✅ [REFRESH TOKEN] Token refreshed and rotated successfully');
        console.log('   User UUID  :', completeUser?.uuid);
        console.log('   User Type  :', completeUser?.user_type);
        console.log('   Active Mode:', completeUser?.active_mode || '(natural fallback)');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({
            success: true,
            message: 'Token refreshed successfully',
            data: {
                access_token: result.accessToken,
                refresh_token: result.refreshToken,
                expires_in: result.expiresIn,
                refresh_expires_in: result.refreshExpiresIn,
                user: completeUser,
            },
        });

    } catch (err) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ [REFRESH TOKEN ERROR]:', err.message);
        console.error(err.stack);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(err.status || 500).json({
            success: false,
            message: err.message || 'Failed to refresh token',
            code: err.code || 'REFRESH_TOKEN_ERROR',
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// REGISTER PASSENGER
// POST /api/auth/signup/passenger
// Sends BOTH email OTP and SMS OTP.
// If either delivery fails, signup service throws and this endpoint fails.
// ═══════════════════════════════════════════════════════════════════════

exports.registerPassenger = [
    uploadPassengerPhoto,
    async (req, res) => {
        try {
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('📝 [REGISTER PASSENGER] Request received');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('Body:', JSON.stringify(req.body, null, 2));
            console.log('File uploaded:', req.file ? req.file.originalname : 'No file');

            handleValidation(req);

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

            const pendingSignup = await signupPassenger(req.body);

            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('✅ [REGISTER PASSENGER] Pending signup created and both OTPs sent!');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            return res.status(200).json({
                success: true,
                message: 'Verification codes sent by email and SMS. Please verify to complete registration.',
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

            if (req.body.avatar_url) {
                console.log('🗑️ [CLEANUP] Deleting uploaded avatar from R2...');
                await deleteFromR2(req.body.avatar_url);
            }

            return res.status(err.status || 500).json({
                success: false,
                message: err.message || 'Failed to register passenger',
                code: err.code || 'REGISTRATION_ERROR',
            });
        }
    },
];

// ═══════════════════════════════════════════════════════════════════════
// REGISTER DRIVER
// POST /api/auth/signup/driver
// Sends BOTH email OTP and SMS OTP.
// If either delivery fails, signup service throws and this endpoint fails.
// ═══════════════════════════════════════════════════════════════════════

exports.registerDriver = [
    uploadDriverFiles,
    async (req, res) => {
        const uploadedUrls = {};

        try {
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('🚗 [REGISTER DRIVER] Request received');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('Body:', JSON.stringify(req.body, null, 2));
            console.log('Files uploaded:', req.files ? Object.keys(req.files) : 'No files');

            handleValidation(req);

            try {
                if (req.files?.avatar?.[0]) {
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

                if (req.files?.license?.[0]) {
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

                    await cleanupUploadedUrls(uploadedUrls);

                    return res.status(400).json({
                        success: false,
                        message: 'Driver license document is required',
                        code: 'MISSING_LICENSE_DOCUMENT',
                    });
                }

                if (req.files?.insurance?.[0]) {
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

                if (req.files?.vehicle_photo?.[0]) {
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
                await cleanupUploadedUrls(uploadedUrls);

                return res.status(500).json({
                    success: false,
                    message: 'Failed to upload documents',
                    code: 'FILE_UPLOAD_FAILED',
                    error: uploadError.message,
                });
            }

            try {
                const pendingSignup = await signupDriver(req.body);

                console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                console.log('✅ [REGISTER DRIVER] Pending signup created and both OTPs sent!');
                console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

                return res.status(200).json({
                    success: true,
                    message: 'Verification codes sent by email and SMS. Please verify to complete registration.',
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
                console.log('🗑️ [CLEANUP] Signup failed, deleting uploaded files from R2...');
                await cleanupUploadedUrls(uploadedUrls);
                throw signupError;
            }

        } catch (err) {
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.error('❌ [REGISTER DRIVER ERROR]:', err.message);
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            return res.status(err.status || 500).json({
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

exports.sendOtp = async (req, res) => {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📨 [SEND OTP] Request received');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        handleValidation(req);

        const {
            identifier,
            channel,
            purpose,
        } = req.body;

        const { account, otp } = await sendOtpByIdentifier({
            identifier,
            channel,
            purpose,
        });

        console.log('✅ [SEND OTP] OTP sent successfully!');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({
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

        return res.status(err.status || 500).json({
            success: false,
            message: err.message || 'Failed to send OTP',
            code: err.code || 'OTP_SEND_ERROR',
        });
    }
};

exports.verifyOtp = async (req, res) => {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔍 [VERIFY OTP] Request received');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        handleValidation(req);

        const {
            identifier,
            purpose,
            code,
        } = req.body;

        const { account } = await verifyOtpAndCreateAccount({
            identifier,
            purpose,
            code,
        });

        console.log('✅ [VERIFY OTP] OTP verified and account created!');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({
            success: true,
            message: 'Account created successfully! You can now login.',
            data: {
                uuid: account.uuid,
                user_type: account.user_type,
                active_mode: account.active_mode || null,
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

        return res.status(err.status || 500).json({
            success: false,
            message: err.message || 'Failed to verify OTP',
            code: err.code || 'OTP_VERIFY_ERROR',
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// LOGIN ENDPOINT
// POST /api/auth/login
// ═══════════════════════════════════════════════════════════════════════

exports.login = async (req, res) => {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔐 [LOGIN] Request received');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        const {
            identifier,
            password,
        } = req.body;

        if (!identifier || !password) {
            return res.status(400).json({
                success: false,
                message: 'Identifier and password are required',
                code: 'MISSING_CREDENTIALS',
            });
        }

        const account = await findAccountByIdentifier(identifier);

        if (!account) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials',
                code: 'INVALID_CREDENTIALS',
            });
        }

        const lockStatus = await isAccountLocked(account.uuid);

        if (lockStatus.locked) {
            return res.status(429).json({
                success: false,
                message: `Too many failed login attempts. Account locked for ${Math.ceil(lockStatus.remainingTime / 60)} more minutes.`,
                code: 'ACCOUNT_LOCKED',
                data: {
                    remainingTime: lockStatus.remainingTime,
                },
            });
        }

        const passwordResult = await verifyPassword(
            password,
            account.password_hash,
            account
        );

        if (!passwordResult.valid) {
            console.log('❌ [LOGIN] Password login failed:', passwordResult.reason);

            if (passwordResult.reason === 'USE_GOOGLE_LOGIN') {
                return res.status(403).json({
                    success: false,
                    message: passwordResult.message || 'This account uses Google sign-in. Please continue with Google.',
                    code: 'USE_GOOGLE_LOGIN',
                    provider: 'GOOGLE',
                });
            }

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

        const eligibility = canAccountLogin(account);

        if (!eligibility.allowed) {
            const statusCodes = {
                ACCOUNT_DELETED: 403,
                ACCOUNT_SUSPENDED: 403,
                ACCOUNT_INACTIVE: 403,
                PHONE_NOT_VERIFIED: 403,
                PROFILE_INCOMPLETE: 403,
                VERIFICATION_REJECTED: 403,
                WALLET_FROZEN: 403,
                WALLET_SUSPENDED: 403,
            };

            return res.status(statusCodes[eligibility.reason] || 403).json({
                success: false,
                message: eligibility.message,
                code: eligibility.reason,
                requiresOtp: eligibility.requiresOtp || false,
            });
        }

        await resetFailedLoginAttempts(account.uuid);

        const tokens = await generateTokens(
            account,
            getClientTokenOptions(req)
        );

        const completeUser = buildCompleteUser(account);

        const isPendingDriver =
            account.user_type === 'DRIVER' &&
            account.status === 'PENDING';

        if (isPendingDriver) {
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
        console.log('   User UUID  :', completeUser.uuid);
        console.log('   User Type  :', completeUser.user_type);
        console.log('   Active Mode:', completeUser.active_mode || '(natural fallback)');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({
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
        console.error(err.stack);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(err.status || 500).json({
            success: false,
            message: err.message || 'Login failed',
            code: err.code || 'LOGIN_ERROR',
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// PROFILE ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════

exports.getProfile = async (req, res) => {
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

        const completeUser = buildCompleteUser(req.user);

        return res.status(200).json({
            success: true,
            message: 'Profile retrieved successfully',
            data: completeUser,
        });

    } catch (err) {
        return res.status(err.status || 500).json({
            success: false,
            message: err.message || 'Failed to retrieve profile',
            code: err.code || 'PROFILE_ERROR',
        });
    }
};

exports.updateAvatar = [
    uploadPassengerPhoto,
    async (req, res) => {
        let newAvatarUrl = null;

        try {
            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    message: 'No file uploaded',
                    code: 'NO_FILE_UPLOADED',
                });
            }

            newAvatarUrl = await uploadToR2(
                req.file.buffer,
                req.file.originalname,
                'profiles',
                req.file.mimetype
            );

            if (req.user.avatar_url) {
                await deleteFromR2(req.user.avatar_url);
            }

            const account = await Account.findByPk(req.user.uuid);

            if (!account) {
                if (newAvatarUrl) {
                    await deleteFromR2(newAvatarUrl);
                }

                return res.status(404).json({
                    success: false,
                    message: 'Account not found',
                    code: 'ACCOUNT_NOT_FOUND',
                });
            }

            await account.update({
                avatar_url: newAvatarUrl,
            });

            const completeUser = buildCompleteUser(account);

            return res.status(200).json({
                success: true,
                message: 'Avatar updated successfully',
                data: {
                    avatar_url: newAvatarUrl,
                    user: completeUser,
                },
            });

        } catch (err) {
            if (newAvatarUrl) {
                try {
                    await deleteFromR2(newAvatarUrl);
                } catch (_) {}
            }

            return res.status(err.status || 500).json({
                success: false,
                message: err.message || 'Failed to update avatar',
                code: err.code || 'AVATAR_UPDATE_ERROR',
            });
        }
    },
];

// ═══════════════════════════════════════════════════════════════════════
// LOGOUT
// POST /api/auth/logout
// ═══════════════════════════════════════════════════════════════════════

exports.logout = async (req, res) => {
    try {
        const {
            refresh_token,
            logout_all,
        } = req.body || {};

        if (logout_all) {
            await invalidateAllRefreshTokens(req.user.uuid);
        } else if (refresh_token) {
            await invalidateRefreshToken(refresh_token);
        }

        return res.status(200).json({
            success: true,
            message: 'Logged out successfully',
        });

    } catch (err) {
        return res.status(err.status || 500).json({
            success: false,
            message: err.message || 'Logout failed',
            code: err.code || 'LOGOUT_ERROR',
        });
    }
};



// ─────────────────────────────────────────────────────────────────────────────

