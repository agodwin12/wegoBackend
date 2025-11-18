// src/controllers/auth.controller.js
const { validationResult } = require('express-validator');
const path = require('path');
const { signupPassenger, signupDriver } = require('../services/auth.services');
const { sendOtpByIdentifier, verifyOtp } = require('../services/otp.service');
const { findAccountByIdentifier, verifyPassword } = require('../services/login.service');
const { getFileUrl, deleteFile, getFilenameFromUrl, uploadProfile, uploadDocuments, uploadVehicle } = require('../middleware/upload');
const { signAccessToken, signRefreshToken } = require('../utils/jwt');
const { Account } = require('../models');

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

/**
 * Helper to delete uploaded files on error
 */
function cleanupUploadedFiles(files) {
    if (!files) return;

    console.log('🗑️  [CLEANUP] Deleting uploaded files due to error...');

    // Handle single file (req.file)
    if (files.filename) {
        const filePath = path.join(__dirname, '../../uploads/profiles', files.filename);
        deleteFile(filePath);
        return;
    }

    // Handle multiple files (req.files)
    Object.keys(files).forEach(fieldName => {
        const fileArray = files[fieldName];
        if (Array.isArray(fileArray)) {
            fileArray.forEach(file => {
                let filePath;
                if (fieldName === 'avatar') {
                    filePath = path.join(__dirname, '../../uploads/profiles', file.filename);
                } else if (fieldName === 'vehicle_photo') {
                    filePath = path.join(__dirname, '../../uploads/vehicles', file.filename);
                } else {
                    filePath = path.join(__dirname, '../../uploads/documents', file.filename);
                }
                deleteFile(filePath);
            });
        }
    });

    console.log('✅ [CLEANUP] All uploaded files deleted');
}

// ═══════════════════════════════════════════════════════════════════════
// MULTER MIDDLEWARE FOR DRIVER REGISTRATION (Multiple Files)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Multer middleware to handle multiple file uploads for driver registration
 * Fields:
 * - avatar: Profile picture (optional)
 * - license: Driver's license document (required)
 * - insurance: Insurance document (optional)
 * - vehicle_photo: Vehicle photo (optional)
 */
const uploadDriverFiles = (req, res, next) => {
    // Use multer.fields() to handle multiple named file fields
    const upload = require('multer')({
        storage: require('multer').diskStorage({
            destination: (req, file, cb) => {
                if (file.fieldname === 'avatar') {
                    cb(null, path.join(__dirname, '../../uploads/profiles'));
                } else if (file.fieldname === 'vehicle_photo') {
                    cb(null, path.join(__dirname, '../../uploads/vehicles'));
                } else {
                    cb(null, path.join(__dirname, '../../uploads/documents'));
                }
            },
            filename: (req, file, cb) => {
                const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
                const ext = path.extname(file.originalname);
                const fieldName = file.fieldname;
                cb(null, `${fieldName}-${uniqueSuffix}${ext}`);
            }
        }),
        fileFilter: (req, file, cb) => {
            const allowedTypes = /jpeg|jpg|png|pdf|webp/;
            const ext = path.extname(file.originalname).toLowerCase();
            const isExtValid = allowedTypes.test(ext);

            // Accept octet-stream if extension is correct
            const isMimeValid =
                allowedTypes.test(file.mimetype) ||
                file.mimetype === "application/octet-stream";

            if (isExtValid && isMimeValid) {
                return cb(null, true);
            } else {
                return cb(
                    new Error(
                        `Invalid file type for ${file.fieldname}. Only JPEG, JPG, PNG, PDF, WEBP allowed.`
                    )
                );
            }
        },

        limits: {
            fileSize: 10 * 1024 * 1024 // 10MB max per file
        }
    }).fields([
        { name: 'avatar', maxCount: 1 },
        { name: 'license', maxCount: 1 },
        { name: 'insurance', maxCount: 1 },
        { name: 'vehicle_photo', maxCount: 1 }
    ]);

    upload(req, res, (err) => {
        if (err) {
            console.error('❌ [MULTER ERROR]:', err.message);

            // Clean up any files that were uploaded before error
            if (req.files) {
                cleanupUploadedFiles(req.files);
            }

            // Return user-friendly error
            return res.status(400).json({
                success: false,
                message: 'File upload error',
                error: err.message,
                code: 'FILE_UPLOAD_ERROR'
            });
        }
        next();
    });
};

exports.refreshToken = async (req, res, next) => {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔄 [REFRESH TOKEN] Request received');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        const { refresh_token } = req.body;

        if (!refresh_token) {
            return res.status(400).json({
                success: false,
                message: 'Refresh token is required',
                code: 'MISSING_REFRESH_TOKEN'
            });
        }

        console.log('🔍 [REFRESH TOKEN] Verifying refresh token...');

        const { verifyRefreshToken } = require('../utils/jwt');
        const decoded = verifyRefreshToken(refresh_token);

        console.log('✅ [REFRESH TOKEN] Token verified for user:', decoded.uuid);

        const account = await Account.findByPk(decoded.uuid);

        if (!account) {
            console.log('❌ [REFRESH TOKEN] Account not found');
            return res.status(404).json({
                success: false,
                message: 'Account not found',
                code: 'ACCOUNT_NOT_FOUND'
            });
        }

        if (account.status === 'SUSPENDED' || account.status === 'DELETED') {
            console.log('❌ [REFRESH TOKEN] Account is', account.status);
            return res.status(403).json({
                success: false,
                message: 'Account is no longer active',
                code: 'ACCOUNT_INACTIVE'
            });
        }

        console.log('🎫 [REFRESH TOKEN] Generating new tokens...');
        const newAccessToken = signAccessToken(account);
        const newRefreshToken = signRefreshToken(account);

        console.log('✅ [REFRESH TOKEN] New tokens generated');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(200).json({
            success: true,
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

        res.status(err.status || 500).json({
            success: false,
            message: err.message || 'Failed to refresh token',
            code: err.code || 'REFRESH_TOKEN_ERROR'
        });
    }
};

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

        // If profile picture uploaded, add URL to request body
        if (req.file) {
            req.body.avatar_url = getFileUrl(req.file.filename, 'profile');
            console.log('✅ [AVATAR] Profile picture URL:', req.body.avatar_url);
        }

        const { account, otpDelivery } = await signupPassenger(req.body);

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ [REGISTER PASSENGER] Success!');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(201).json({
            success: true,
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

        cleanupUploadedFiles(req.file);

        res.status(err.status || 500).json({
            success: false,
            message: err.message || 'Failed to register passenger',
            code: err.code || 'REGISTRATION_ERROR'
        });
    }
};

/**
 * Register Driver with multiple file uploads
 * POST /api/auth/signup/driver
 * Body: multipart/form-data
 * Fields: email, phone_e164, password, first_name, last_name, license_number, etc.
 * Files:
 *   - avatar (optional): Profile picture
 *   - license (required): Driver's license document
 *   - insurance (optional): Insurance document
 *   - vehicle_photo (optional): Vehicle photo
 */
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

            // Process uploaded files and add URLs to request body
            if (req.files) {
                // Avatar (profile picture)
                if (req.files.avatar && req.files.avatar[0]) {
                    req.body.avatar_url = getFileUrl(req.files.avatar[0].filename, 'profile');
                    console.log('✅ [AVATAR] Profile picture:', req.body.avatar_url);
                }

                // Driver's License
                if (req.files.license && req.files.license[0]) {
                    req.body.license_document_url = getFileUrl(req.files.license[0].filename, 'document');
                    console.log('✅ [LICENSE] License document:', req.body.license_document_url);
                } else {
                    // License document is REQUIRED for drivers
                    console.log('❌ [LICENSE] License document is required');
                    cleanupUploadedFiles(req.files);
                    return res.status(400).json({
                        success: false,
                        message: 'Driver license document is required',
                        code: 'MISSING_LICENSE_DOCUMENT'
                    });
                }

                // Insurance document
                if (req.files.insurance && req.files.insurance[0]) {
                    req.body.insurance_document_url = getFileUrl(req.files.insurance[0].filename, 'document');
                    console.log('✅ [INSURANCE] Insurance document:', req.body.insurance_document_url);
                }

                // Vehicle photo
                if (req.files.vehicle_photo && req.files.vehicle_photo[0]) {
                    req.body.vehicle_photo_url = getFileUrl(req.files.vehicle_photo[0].filename, 'vehicle');
                    console.log('✅ [VEHICLE] Vehicle photo:', req.body.vehicle_photo_url);
                }
            } else {
                console.log('❌ [FILES] No files uploaded - license document is required');
                return res.status(400).json({
                    success: false,
                    message: 'Driver license document is required',
                    code: 'MISSING_LICENSE_DOCUMENT'
                });
            }

            const { account, otpDelivery } = await signupDriver(req.body);

            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('✅ [REGISTER DRIVER] Success!');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            return res.status(201).json({
                success: true,
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

            cleanupUploadedFiles(req.files);

            res.status(err.status || 500).json({
                success: false,
                message: err.message || 'Failed to register driver',
                code: err.code || 'REGISTRATION_ERROR'
            });
        }
    }
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
            }
        });
    } catch (err) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ [SEND OTP ERROR]:', err.message);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(err.status || 500).json({
            success: false,
            message: err.message || 'Failed to send OTP',
            code: err.code || 'OTP_SEND_ERROR'
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

        const { account } = await verifyOtp({ identifier, purpose, code });
        const canProceed = !!(account.email_verified || account.phone_verified);

        console.log('✅ [VERIFY OTP] OTP verified successfully!');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(200).json({
            success: true,
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

        res.status(err.status || 500).json({
            success: false,
            message: err.message || 'Failed to verify OTP',
            code: err.code || 'OTP_VERIFY_ERROR'
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// LOGIN ENDPOINT
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
                code: 'MISSING_CREDENTIALS'
            });
        }

        console.log('✅ [LOGIN] Input validation passed');
        console.log('🔍 [LOGIN] Looking up account with profile data...');

        // ═══════════════════════════════════════════════════════════════
        // FETCH ACCOUNT WITH PROFILE DATA
        // ═══════════════════════════════════════════════════════════════
        const account = await findAccountByIdentifier(identifier);

        if (!account) {
            console.log('❌ [LOGIN] Account not found');
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials',
                code: 'INVALID_CREDENTIALS'
            });
        }

        console.log('✅ [LOGIN] Account found');
        console.log('🔑 [LOGIN] Verifying password...');

        // ═══════════════════════════════════════════════════════════════
        // VERIFY PASSWORD
        // ═══════════════════════════════════════════════════════════════
        const isPasswordValid = await verifyPassword(password, account.password_hash);

        if (!isPasswordValid) {
            console.log('❌ [LOGIN] Invalid password');
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials',
                code: 'INVALID_CREDENTIALS'
            });
        }

        console.log('✅ [LOGIN] Password verified successfully');

        // ═══════════════════════════════════════════════════════════════
        // CHECK VERIFICATION STATUS
        // ═══════════════════════════════════════════════════════════════
        const isVerified = !!(account.email_verified || account.phone_verified);

        if (!isVerified) {
            console.log('❌ [LOGIN] Account not verified');
            return res.status(403).json({
                success: false,
                message: 'Please verify your email or phone number via OTP before logging in.',
                code: 'ACCOUNT_NOT_VERIFIED'
            });
        }

        // ═══════════════════════════════════════════════════════════════
        // CHECK ACCOUNT STATUS
        // ═══════════════════════════════════════════════════════════════
        console.log('🔐 [LOGIN] Checking account status...');

        if (account.status === 'SUSPENDED') {
            console.log('🚫 [LOGIN] Account is SUSPENDED');
            return res.status(403).json({
                success: false,
                message: 'Your account has been suspended. Please contact support for assistance.',
                code: 'ACCOUNT_SUSPENDED'
            });
        }

        if (account.status === 'DELETED') {
            console.log('🗑️  [LOGIN] Account is DELETED');
            return res.status(403).json({
                success: false,
                message: 'This account has been deleted and cannot be accessed.',
                code: 'ACCOUNT_DELETED'
            });
        }

        // ═══════════════════════════════════════════════════════════════
        // BUILD COMPLETE USER OBJECT
        // ═══════════════════════════════════════════════════════════════
        console.log('📦 [LOGIN] Building complete user object...');

        // Convert to plain object
        const accountData = account.toJSON ? account.toJSON() : account;

        // Remove sensitive fields
        const { password_hash, password_algo, ...safeAccount } = accountData;

        // Build complete user object with profile
        let completeUser = { ...safeAccount };

        // ───────────────────────────────────────────────────────────────
        // PASSENGER: Include passenger profile data
        // ───────────────────────────────────────────────────────────────
        if (account.user_type === 'PASSENGER' && account.passenger_profile) {
            console.log('👤 [LOGIN] Including passenger profile data');
            const profile = account.passenger_profile.toJSON
                ? account.passenger_profile.toJSON()
                : account.passenger_profile;

            completeUser.profile = {
                address_text: profile.address_text,
                notes: profile.notes,
                // Add any other passenger-specific fields
            };

            console.log('   ✓ Passenger profile included');
        }

        // ───────────────────────────────────────────────────────────────
        // DRIVER: Include driver profile data
        // ───────────────────────────────────────────────────────────────
        if (account.user_type === 'DRIVER' && account.driver_profile) {
            console.log('🚗 [LOGIN] Including driver profile data');
            const profile = account.driver_profile.toJSON
                ? account.driver_profile.toJSON()
                : account.driver_profile;

            completeUser.profile = {
                // Identity Documents
                cni_number: profile.cni_number,
                license_number: profile.license_number,
                license_expiry: profile.license_expiry,
                license_document_url: profile.license_document_url,
                insurance_number: profile.insurance_number,
                insurance_expiry: profile.insurance_expiry,
                insurance_document_url: profile.insurance_document_url,

                // Vehicle Information
                vehicle_type: profile.vehicle_type,
                vehicle_make_model: profile.vehicle_make_model,
                vehicle_color: profile.vehicle_color,
                vehicle_year: profile.vehicle_year,
                vehicle_plate: profile.vehicle_plate,
                vehicle_photo_url: profile.vehicle_photo_url,

                // Driver Status
                verification_state: profile.verification_state,
                is_online: profile.is_online,
                is_available: profile.is_available,

                // Add any other driver-specific fields
            };

            console.log('   ✓ Driver profile included');
            console.log('   ✓ License:', profile.license_number);
            console.log('   ✓ Vehicle:', profile.vehicle_make_model || 'N/A');
            console.log('   ✓ License Document:', profile.license_document_url ? '✓' : '✗');
            console.log('   ✓ Vehicle Photo:', profile.vehicle_photo_url ? '✓' : '✗');
        }

        // Remove the raw profile associations from response
        delete completeUser.passenger_profile;
        delete completeUser.driver_profile;

        // ═══════════════════════════════════════════════════════════════
        // HANDLE PENDING DRIVER STATUS
        // ═══════════════════════════════════════════════════════════════
        if (account.user_type === 'DRIVER' && account.status === 'PENDING') {
            console.log('⏳ [LOGIN] Driver status: PENDING approval');

            const accessToken = signAccessToken(account);
            const refreshToken = signRefreshToken(account);

            console.log('✅ [LOGIN] Login successful (PENDING driver)');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            return res.status(200).json({
                success: true,
                message: 'Login successful. Your account is pending admin approval.',
                warning: 'You cannot accept rides until your account is approved by an administrator.',
                data: {
                    access_token: accessToken,
                    refresh_token: refreshToken,
                    user: completeUser,
                    isPending: true
                }
            });
        }

        // ═══════════════════════════════════════════════════════════════
        // GENERATE TOKENS AND RESPOND
        // ═══════════════════════════════════════════════════════════════
        console.log('🎫 [LOGIN] Generating authentication tokens...');

        const accessToken = signAccessToken(account);
        const refreshToken = signRefreshToken(account);

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ [LOGIN] Login successful!');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('👤 User:', completeUser.first_name, completeUser.last_name);
        console.log('📧 Email:', completeUser.email || 'N/A');
        console.log('📱 Phone:', completeUser.phone_e164 || 'N/A');
        console.log('🆔 UUID:', completeUser.uuid);
        console.log('🎭 Type:', completeUser.user_type);
        console.log('📸 Avatar:', completeUser.avatar_url ? '✓' : '✗');
        console.log('📦 Profile Data:', completeUser.profile ? '✓' : '✗');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(200).json({
            success: true,
            message: 'Login successful',
            data: {
                access_token: accessToken,
                refresh_token: refreshToken,
                user: completeUser,
                isPending: false
            }
        });

    } catch (err) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ [LOGIN ERROR]:', err.message);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(err.status || 500).json({
            success: false,
            message: err.message || 'Login failed',
            code: err.code || 'LOGIN_ERROR'
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
                code: 'NOT_AUTHENTICATED'
            });
        }

        const { password_hash, password_algo, ...safeUser } = req.user.toJSON ? req.user.toJSON() : req.user;

        console.log('✅ [GET PROFILE] Profile retrieved');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(200).json({
            success: true,
            message: 'Profile retrieved successfully',
            data: safeUser
        });
    } catch (err) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ [GET PROFILE ERROR]:', err.message);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(err.status || 500).json({
            success: false,
            message: err.message || 'Failed to retrieve profile',
            code: err.code || 'PROFILE_ERROR'
        });
    }
};

exports.updateAvatar = async (req, res, next) => {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🖼️  [UPDATE AVATAR] Request received');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        if (!req.file) {
            console.log('❌ [UPDATE AVATAR] No file uploaded');
            return res.status(400).json({
                success: false,
                message: 'No file uploaded',
                code: 'NO_FILE_UPLOADED'
            });
        }

        const newAvatarUrl = getFileUrl(req.file.filename, 'profile');

        if (req.user.avatar_url) {
            const oldFilename = getFilenameFromUrl(req.user.avatar_url);
            if (oldFilename) {
                const oldFilePath = path.join(__dirname, '../../uploads/profiles', oldFilename);
                deleteFile(oldFilePath);
            }
        }

        const account = await Account.findByPk(req.user.uuid);
        if (!account) {
            cleanupUploadedFiles(req.file);
            return res.status(404).json({
                success: false,
                message: 'Account not found',
                code: 'ACCOUNT_NOT_FOUND'
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
                user: safeAccount
            }
        });
    } catch (err) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ [UPDATE AVATAR ERROR]:', err.message);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        cleanupUploadedFiles(req.file);

        res.status(err.status || 500).json({
            success: false,
            message: err.message || 'Failed to update avatar',
            code: err.code || 'AVATAR_UPDATE_ERROR'
        });
    }
};

exports.logout = async (req, res, next) => {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('👋 [LOGOUT] Request received');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        console.log('✅ [LOGOUT] Logout successful');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(200).json({
            success: true,
            message: 'Logged out successfully'
        });
    } catch (err) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ [LOGOUT ERROR]:', err.message);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(err.status || 500).json({
            success: false,
            message: err.message || 'Logout failed',
            code: err.code || 'LOGOUT_ERROR'
        });
    }
};