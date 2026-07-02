// src/services/auth.services.js
'use strict';

const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');

const {
    PendingSignup,
    VerificationCode,
    Account,
    DriverProfile,
} = require('../models');

const { issueOtp } = require('./otp.service');
const { deleteFromR2 } = require('../utils/r2Upload');

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
const SIGNUP_EXPIRY_MINUTES = parseInt(process.env.SIGNUP_EXPIRY_MINUTES || '30', 10);

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function makeError(message, status = 400, code = 'BAD_REQUEST') {
    const err = new Error(message);
    err.status = status;
    err.code = code;
    return err;
}

async function cleanupUploadedFiles(uploadedFiles = []) {
    if (!uploadedFiles.length) return;

    console.log('🗑️ [CLEANUP] Deleting uploaded files from R2...');

    for (const fileUrl of uploadedFiles) {
        try {
            await deleteFromR2(fileUrl);
            console.log(`   ✅ Deleted: ${fileUrl}`);
        } catch (deleteErr) {
            console.warn(`   ⚠️ Failed to delete ${fileUrl}: ${deleteErr.message}`);
        }
    }
}

async function cleanupPendingSignup(uuid) {
    if (!uuid) return;

    console.log('🗑️ [CLEANUP] Removing pending signup and OTP records...');
    console.log('   UUID:', uuid);

    try {
        await VerificationCode.destroy({
            where: {
                account_uuid: uuid,
            },
        });

        await PendingSignup.destroy({
            where: {
                uuid,
            },
        });

        console.log('✅ [CLEANUP] Pending signup and OTP records removed');
    } catch (err) {
        console.warn('⚠️ [CLEANUP] Failed to cleanup pending signup:', err.message);
    }
}

function assertOtpWasSent(result, channel) {
    if (!result || result.delivery !== 'SENT') {
        throw makeError(
            `Failed to send OTP via ${channel}. Please try again.`,
            503,
            channel === 'EMAIL' ? 'EMAIL_SEND_FAILED' : 'SMS_SEND_FAILED'
        );
    }
}

async function sendBothSignupOtps({ uuid, email, phone_e164 }) {
    console.log('📨 [OTP] Sending verification codes via BOTH EMAIL and SMS...');
    console.log('   Email:', email);
    console.log('   Phone:', phone_e164);

    if (!email) {
        throw makeError(
            'Email is required because registration sends an email OTP.',
            400,
            'MISSING_EMAIL'
        );
    }

    if (!phone_e164) {
        throw makeError(
            'Phone number is required because registration sends an SMS OTP.',
            400,
            'MISSING_PHONE'
        );
    }

    const otpDelivery = {};

    // EMAIL OTP — BEST EFFORT. Email is an auxiliary channel; a down/misconfigured
    // SMTP credential must NOT block signup. SMS (below) is the required channel,
    // and the account is created once EITHER OTP is verified (verifyOtpAndCreateAccount
    // marks both email_verified and phone_verified). So SMS alone completes signup.
    console.log(`📧 [OTP] Issuing EMAIL OTP to ${email}...`);
    try {
        const emailOtp = await issueOtp(
            {
                accountUuid: uuid,
                purpose: 'EMAIL_VERIFY',
                channel: 'EMAIL',
                target: email,
            },
            null
        );
        // Only report the email channel when it was actually SENT. Clients pick
        // their verification channel from otp_delivery — advertising a FAILED
        // email would make them wait for a code that never arrives.
        if (emailOtp?.delivery === 'SENT') {
            otpDelivery.email = {
                delivery: 'SENT',
                channel:  'EMAIL',
                target:   email,
            };
            console.log(`✅ [OTP EMAIL] SENT → ${email}`);
        } else {
            console.warn(`⚠️  [OTP EMAIL] not sent — omitted from otp_delivery (SMS is the required channel)`);
        }
    } catch (emailErr) {
        console.warn(`⚠️  [OTP EMAIL] failed — continuing (SMS is the required channel): ${emailErr.message}`);
    }

    // SMS OTP
    console.log(`📱 [OTP] Issuing SMS OTP to ${phone_e164}...`);

    const smsOtp = await issueOtp(
        {
            accountUuid: uuid,
            purpose: 'PHONE_VERIFY',
            channel: 'SMS',
            target: phone_e164,
        },
        null
    );

    assertOtpWasSent(smsOtp, 'SMS');

    otpDelivery.phone = {
        delivery: smsOtp.delivery,
        channel: smsOtp.channel,
        target: smsOtp.target,
    };

    console.log(`✅ [OTP SMS] Sent → ${smsOtp.target}`);
    console.log('✅ [OTP] Both EMAIL and SMS OTPs sent successfully');

    return otpDelivery;
}

async function ensureNoDuplicateAccount({ email, phone_e164 }) {
    if (email) {
        console.log(`🔍 [DUPLICATE CHECK] Checking email: ${email}`);

        const existingEmail = await Account.findOne({
            where: {
                email,
            },
        });

        if (existingEmail) {
            throw makeError('Email already registered', 409, 'EMAIL_ALREADY_EXISTS');
        }

        console.log('✅ [DUPLICATE CHECK] Email is available');
    }

    if (phone_e164) {
        console.log(`🔍 [DUPLICATE CHECK] Checking phone: ${phone_e164}`);

        const existingPhone = await Account.findOne({
            where: {
                phone_e164,
            },
        });

        if (existingPhone) {
            throw makeError('Phone number already registered', 409, 'PHONE_ALREADY_EXISTS');
        }

        console.log('✅ [DUPLICATE CHECK] Phone is available');
    }
}

async function ensureNoDuplicatePendingSignup({ email, phone_e164 }) {
    if (email) {
        const pendingEmail = await PendingSignup.findOne({
            where: {
                email,
            },
        });

        if (pendingEmail) {
            console.log('⚠️ [PENDING SIGNUP] Existing pending signup with same email found. Removing old pending signup.');
            await cleanupPendingSignup(pendingEmail.uuid);
        }
    }

    if (phone_e164) {
        const pendingPhone = await PendingSignup.findOne({
            where: {
                phone_e164,
            },
        });

        if (pendingPhone) {
            console.log('⚠️ [PENDING SIGNUP] Existing pending signup with same phone found. Removing old pending signup.');
            await cleanupPendingSignup(pendingPhone.uuid);
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// REGISTER PASSENGER - STORE IN PENDING_SIGNUPS
// ═══════════════════════════════════════════════════════════════

async function signupPassenger(data) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🚖 [SIGNUP PASSENGER] Starting registration process...');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🧾 Payload:', JSON.stringify(data, null, 2));

    const {
        email,
        phone_e164,
        password,
        civility,
        first_name,
        last_name,
        birth_date,
        avatar_url,
        address_text,
        notes,
    } = data;

    const uploadedFiles = [];
    let uuid = null;

    try {
        if (!email) {
            throw makeError(
                'Email is required because registration sends an email OTP.',
                400,
                'MISSING_EMAIL'
            );
        }

        if (!phone_e164) {
            throw makeError(
                'Phone number is required because registration sends an SMS OTP.',
                400,
                'MISSING_PHONE'
            );
        }

        if (!password) {
            throw makeError('Password is required.', 400, 'MISSING_PASSWORD');
        }

        if (!first_name || !last_name) {
            throw makeError('First name and last name are required.', 400, 'MISSING_NAME');
        }

        if (avatar_url) {
            uploadedFiles.push(avatar_url);
        }

        await ensureNoDuplicateAccount({
            email,
            phone_e164,
        });

        await ensureNoDuplicatePendingSignup({
            email,
            phone_e164,
        });

        console.log('🔐 [SECURITY] Hashing password...');
        const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        console.log('✅ [SECURITY] Password hashed successfully.');

        uuid = uuidv4();
        const expires_at = new Date(Date.now() + SIGNUP_EXPIRY_MINUTES * 60 * 1000);

        console.log(`🆔 [UUID] Generated UUID: ${uuid}`);
        console.log(`⏰ [EXPIRY] Signup will expire at: ${expires_at.toISOString()}`);

        console.log('💾 [PENDING SIGNUP] Creating pending signup record...');

        await PendingSignup.create({
            uuid,
            user_type: 'PASSENGER',
            email,
            phone_e164,
            civility: civility || null,
            first_name,
            last_name,
            birth_date: birth_date || null,
            password_hash,
            avatar_url: avatar_url || null,
            address_text: address_text || null,
            notes: notes || null,
            otp_sent_at: new Date(),
            expires_at,
        });

        console.log(`✅ [PENDING SIGNUP] Record created with UUID: ${uuid}`);

        const otpDelivery = await sendBothSignupOtps({
            uuid,
            email,
            phone_e164,
        });

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🎉 [SIGNUP PASSENGER] Pending signup created successfully!');
        console.log('🆔 Signup UUID:', uuid);
        console.log('👤 Name:', `${first_name} ${last_name}`);
        console.log('📧 Email:', email);
        console.log('📱 Phone:', phone_e164);
        console.log('🖼️ Avatar:', avatar_url || 'No avatar');
        console.log('📨 OTP Delivery:', otpDelivery);
        console.log('⏰ Expires at:', expires_at.toISOString());
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return {
            uuid,
            user_type: 'PASSENGER',
            email,
            phone_e164,
            first_name,
            last_name,
            avatar_url: avatar_url || null,
            otpDelivery,
        };

    } catch (err) {
        console.error('💥 [PASSENGER SIGNUP FAILED]:', err.message);
        console.error('💥 [ERROR DETAILS]:', err);

        await cleanupPendingSignup(uuid);
        await cleanupUploadedFiles(uploadedFiles);

        if (!err.code) {
            err.code = 'PASSENGER_SIGNUP_FAILED';
        }

        throw err;
    }
}

// ═══════════════════════════════════════════════════════════════
// REGISTER DRIVER - STORE IN PENDING_SIGNUPS
// ═══════════════════════════════════════════════════════════════

async function signupDriver(data) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🚗 [SIGNUP DRIVER] Creating pending driver signup...');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🧾 Payload:', JSON.stringify(data, null, 2));

    const {
        email,
        phone_e164,
        password,
        first_name,
        last_name,
        civility,
        birth_date,
        avatar_url,

        cni_number,
        license_number,
        license_expiry,
        license_document_url,
        insurance_number,
        insurance_expiry,
        insurance_document_url,

        vehicle_type,
        vehicle_make_model,
        vehicle_color,
        vehicle_year,
        vehicle_plate,
        vehicle_photo_url,
    } = data;

    const uploadedFiles = [];
    let uuid = null;

    try {
        if (avatar_url) uploadedFiles.push(avatar_url);
        if (license_document_url) uploadedFiles.push(license_document_url);
        if (insurance_document_url) uploadedFiles.push(insurance_document_url);
        if (vehicle_photo_url) uploadedFiles.push(vehicle_photo_url);

        if (!email) {
            throw makeError(
                'Email is required because registration sends an email OTP.',
                400,
                'MISSING_EMAIL'
            );
        }

        if (!phone_e164) {
            throw makeError(
                'Phone number is required because registration sends an SMS OTP.',
                400,
                'MISSING_PHONE'
            );
        }

        if (!password) {
            throw makeError('Password is required', 400, 'MISSING_PASSWORD');
        }

        if (!first_name || !last_name) {
            throw makeError('First name and last name are required', 400, 'MISSING_NAME');
        }

        if (!cni_number) {
            throw makeError('National ID card number is required', 400, 'MISSING_CNI');
        }

        if (!license_number) {
            throw makeError('Driver license number is required', 400, 'MISSING_LICENSE');
        }

        if (!license_document_url) {
            throw makeError('Driver license document is required', 400, 'MISSING_LICENSE_DOCUMENT');
        }

        await ensureNoDuplicateAccount({
            email,
            phone_e164,
        });

        await ensureNoDuplicatePendingSignup({
            email,
            phone_e164,
        });

        if (vehicle_plate) {
            const existingPlate = await DriverProfile.findOne({
                where: {
                    vehicle_plate,
                },
            });

            if (existingPlate) {
                throw makeError('Vehicle plate number already registered', 409, 'PLATE_EXISTS');
            }
        }

        console.log('✅ [SIGNUP DRIVER] No conflicts found');

        console.log('🔒 [SIGNUP DRIVER] Hashing password...');
        const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        console.log('✅ [SIGNUP DRIVER] Password hashed');

        uuid = uuidv4();
        const expires_at = new Date(Date.now() + SIGNUP_EXPIRY_MINUTES * 60 * 1000);

        console.log(`🆔 [UUID] ${uuid}`);
        console.log(`⏰ [EXPIRY] ${expires_at.toISOString()}`);

        const driver_data = {
            cni_number,
            license_number,
            license_expiry: license_expiry || null,
            insurance_number: insurance_number || null,
            insurance_expiry: insurance_expiry || null,
            vehicle_type: vehicle_type || 'Standard',
            vehicle_make_model: vehicle_make_model || null,
            vehicle_color: vehicle_color || null,
            vehicle_year: vehicle_year ? parseInt(vehicle_year, 10) : null,
            vehicle_plate: vehicle_plate || null,
        };

        console.log('💾 [PENDING SIGNUP] Creating pending driver signup...');

        await PendingSignup.create({
            uuid,
            user_type: 'DRIVER',
            email,
            phone_e164,
            civility: civility || null,
            first_name,
            last_name,
            birth_date: birth_date || null,
            password_hash,
            avatar_url: avatar_url || null,
            driver_data,
            license_document_url,
            insurance_document_url: insurance_document_url || null,
            vehicle_photo_url: vehicle_photo_url || null,
            otp_sent_at: new Date(),
            expires_at,
        });

        console.log(`✅ [PENDING SIGNUP] Driver record created with UUID: ${uuid}`);

        const otpDelivery = await sendBothSignupOtps({
            uuid,
            email,
            phone_e164,
        });

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ [SIGNUP DRIVER] Pending driver signup complete!');
        console.log('🆔 Signup UUID:', uuid);
        console.log('👤 Name:', `${first_name} ${last_name}`);
        console.log('📧 Email:', email);
        console.log('📱 Phone:', phone_e164);
        console.log('🚗 Vehicle:', vehicle_make_model || 'N/A');
        console.log('🔢 Plate:', vehicle_plate || 'N/A');
        console.log('📨 OTP Delivery:', otpDelivery);
        console.log('⏰ Expires at:', expires_at.toISOString());
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return {
            uuid,
            user_type: 'DRIVER',
            email,
            phone_e164,
            first_name,
            last_name,
            avatar_url: avatar_url || null,
            otpDelivery,
        };

    } catch (err) {
        console.error('💥 [DRIVER SIGNUP FAILED]:', err.message);
        console.error('💥 [ERROR DETAILS]:', err);

        await cleanupPendingSignup(uuid);
        await cleanupUploadedFiles(uploadedFiles);

        if (!err.code) {
            err.code = 'DRIVER_SIGNUP_FAILED';
        }

        throw err;
    }
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
    signupPassenger,
    signupDriver,
};