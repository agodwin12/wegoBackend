// src/services/auth.services.js
const { v4: uuidv4 } = require("uuid");
const bcrypt = require("bcrypt");
const { sequelize, PendingSignup } = require("../models");
const { issueOtp } = require("./otp.service");
const { sendWelcomeEmail } = require("./comm/email.service");
const { deleteFromR2 } = require("../utils/r2Upload");

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || "12", 10);

/**
 * ==========================================================
 * 🧍 REGISTER PASSENGER - STORE IN PENDING_SIGNUPS
 * ==========================================================
 */
async function signupPassenger(data) {
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🚖 [SIGNUP PASSENGER] Starting registration process...");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🧾 Payload:", JSON.stringify(data, null, 2));

    const {
        email,
        phone_e164,
        password,
        civility,
        first_name,
        last_name,
        birth_date,
        avatar_url,
    } = data;

    let uploadedFiles = [];

    try {
        // ✅ Step 1: Validate input
        if (!email && !phone_e164) {
            console.log("❌ [VALIDATION] Either email or phone is required");
            const err = new Error("Either email or phone number is required.");
            err.status = 400;
            err.code = 'MISSING_CONTACT_INFO';
            throw err;
        }

        if (!password) {
            console.log("❌ [VALIDATION] Password is required");
            const err = new Error("Password is required.");
            err.status = 400;
            err.code = 'MISSING_PASSWORD';
            throw err;
        }

        if (!first_name || !last_name) {
            console.log("❌ [VALIDATION] First and last name are required");
            const err = new Error("First name and last name are required.");
            err.status = 400;
            err.code = 'MISSING_NAME';
            throw err;
        }

        if (avatar_url) {
            uploadedFiles.push(avatar_url);
        }

        // ✅ Step 2: Check duplicates in active accounts
        const { Account } = require("../models");

        if (email) {
            console.log(`🔍 [DUPLICATE CHECK] Checking email: ${email}`);
            const existingEmail = await Account.findOne({ where: { email } });
            if (existingEmail) {
                const err = new Error("Email already registered");
                err.status = 409;
                err.code = 'EMAIL_ALREADY_EXISTS';
                throw err;
            }
            console.log("✅ [DUPLICATE CHECK] Email is available");
        }

        if (phone_e164) {
            console.log(`🔍 [DUPLICATE CHECK] Checking phone: ${phone_e164}`);
            const existingPhone = await Account.findOne({ where: { phone_e164 } });
            if (existingPhone) {
                const err = new Error("Phone number already registered");
                err.status = 409;
                err.code = 'PHONE_ALREADY_EXISTS';
                throw err;
            }
            console.log("✅ [DUPLICATE CHECK] Phone is available");
        }

        // ✅ Step 3: Hash password
        console.log("🔐 [SECURITY] Hashing password...");
        const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        console.log("✅ [SECURITY] Password hashed successfully.");

        // ✅ Step 4: Generate UUID
        const uuid = uuidv4();
        console.log(`🆔 [UUID] Generated UUID: ${uuid}`);

        // ✅ Step 5: Calculate expiry (30 minutes)
        const expires_at = new Date(Date.now() + 30 * 60 * 1000);
        console.log(`⏰ [EXPIRY] Signup will expire at: ${expires_at.toISOString()}`);

        // ✅ Step 6: Store in pending_signups
        console.log("💾 [PENDING SIGNUP] Creating pending signup record...");

        await PendingSignup.create({
            uuid,
            user_type: "PASSENGER",
            email: email || null,
            phone_e164: phone_e164 || null,
            civility: civility || null,
            first_name,
            last_name,
            birth_date: birth_date || null,
            password_hash,
            avatar_url: avatar_url || null,
            otp_sent_at: new Date(),
            expires_at,
        });

        console.log(`✅ [PENDING SIGNUP] Record created with UUID: ${uuid}`);

        // ✅ Step 7: Send OTP via ONE channel only
        // ─────────────────────────────────────────────────────────
        // IMPORTANT: We issue only ONE OTP to ONE channel.
        // Priority: SMS (phone) first, EMAIL as fallback.
        // This prevents the bug where two different OTP codes are
        // generated and the user submits the wrong one.
        // ─────────────────────────────────────────────────────────
        console.log("📨 [OTP] Sending verification code via single channel...");

        const otpDelivery = {};

        if (phone_e164) {
            // ── PREFERRED: SMS ────────────────────────────────────
            console.log(`📱 [OTP] Issuing SMS OTP to ${phone_e164}...`);
            try {
                const phoneOtp = await issueOtp(
                    {
                        accountUuid: uuid,
                        purpose: "PHONE_VERIFY",
                        channel: "SMS",
                        target: phone_e164,
                    },
                    null
                );
                otpDelivery.phone = {
                    delivery: phoneOtp.delivery,
                    target: phoneOtp.target,
                };
                console.log(`✅ [OTP SMS] Sent → ${phoneOtp.target} (delivery: ${phoneOtp.delivery})`);
            } catch (err) {
                console.error("❌ [OTP SMS FAILED]:", err.message);
                await PendingSignup.destroy({ where: { uuid } });
                throw err;
            }

        } else if (email) {
            // ── FALLBACK: EMAIL (only when no phone provided) ─────
            console.log(`📧 [OTP] Issuing EMAIL OTP to ${email}...`);
            try {
                const emailOtp = await issueOtp(
                    {
                        accountUuid: uuid,
                        purpose: "EMAIL_VERIFY",
                        channel: "EMAIL",
                        target: email,
                    },
                    null
                );
                otpDelivery.email = {
                    delivery: emailOtp.delivery,
                    target: emailOtp.target,
                };
                console.log(`✅ [OTP EMAIL] Sent → ${emailOtp.target} (delivery: ${emailOtp.delivery})`);
            } catch (err) {
                console.error("❌ [OTP EMAIL FAILED]:", err.message);
                await PendingSignup.destroy({ where: { uuid } });
                throw err;
            }
        }

        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.log("🎉 [SIGNUP PASSENGER] Pending signup created successfully!");
        console.log("🆔 Signup UUID:", uuid);
        console.log("👤 Name:", `${first_name} ${last_name}`);
        console.log("📧 Email:", email || "N/A");
        console.log("📱 Phone:", phone_e164 || "N/A");
        console.log("🖼️  Avatar:", avatar_url || "No avatar");
        console.log("📨 OTP Delivery:", otpDelivery);
        console.log("   Channel used:", phone_e164 ? "SMS" : "EMAIL");
        console.log("⏰ Expires at:", expires_at.toISOString());
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

        return {
            uuid,
            user_type: "PASSENGER",
            email: email || null,
            phone_e164: phone_e164 || null,
            first_name,
            last_name,
            avatar_url: avatar_url || null,
            otpDelivery,
        };

    } catch (err) {
        console.error("💥 [PENDING SIGNUP FAILED]:", err.message);
        console.error("💥 [ERROR DETAILS]:", err);

        if (uploadedFiles.length > 0) {
            console.log('🗑️  [CLEANUP] Deleting uploaded files from R2...');
            for (const fileUrl of uploadedFiles) {
                try {
                    await deleteFromR2(fileUrl);
                    console.log(`   ✅ Deleted: ${fileUrl}`);
                } catch (deleteErr) {
                    console.warn(`   ⚠️  Failed to delete ${fileUrl}: ${deleteErr.message}`);
                }
            }
        }

        if (!err.code) {
            err.code = 'SIGNUP_FAILED';
        }
        throw err;
    }
}

/**
 * ==========================================================
 * 🚗 REGISTER DRIVER - STORE IN PENDING_SIGNUPS
 * ==========================================================
 */
async function signupDriver(data) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🚗 [SIGNUP DRIVER] Creating pending driver signup...');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const {
        email,
        phone_e164,
        password,
        first_name,
        last_name,
        civility,
        birth_date,
        avatar_url,

        // Driver-specific fields
        cni_number,
        license_number,
        license_expiry,
        license_document_url,
        insurance_number,
        insurance_expiry,
        insurance_document_url,

        // Vehicle info
        vehicle_type,
        vehicle_make_model,
        vehicle_color,
        vehicle_year,
        vehicle_plate,
        vehicle_photo_url,
    } = data;

    let uploadedFiles = [];

    try {
        if (avatar_url) uploadedFiles.push(avatar_url);
        if (license_document_url) uploadedFiles.push(license_document_url);
        if (insurance_document_url) uploadedFiles.push(insurance_document_url);
        if (vehicle_photo_url) uploadedFiles.push(vehicle_photo_url);

        // ─────────────────────────────────────────────────────────────
        // VALIDATION
        // ─────────────────────────────────────────────────────────────
        if (!email && !phone_e164) {
            const err = new Error('Email or phone number is required');
            err.status = 400;
            err.code = 'MISSING_IDENTIFIER';
            throw err;
        }

        if (!password) {
            const err = new Error('Password is required');
            err.status = 400;
            err.code = 'MISSING_PASSWORD';
            throw err;
        }

        if (!first_name || !last_name) {
            const err = new Error('First name and last name are required');
            err.status = 400;
            err.code = 'MISSING_NAME';
            throw err;
        }

        if (!cni_number) {
            const err = new Error('National ID card number is required');
            err.status = 400;
            err.code = 'MISSING_CNI';
            throw err;
        }

        if (!license_number) {
            const err = new Error('Driver license number is required');
            err.status = 400;
            err.code = 'MISSING_LICENSE';
            throw err;
        }

        if (!license_document_url) {
            const err = new Error('Driver license document is required');
            err.status = 400;
            err.code = 'MISSING_LICENSE_DOCUMENT';
            throw err;
        }

        // ─────────────────────────────────────────────────────────────
        // DUPLICATE CHECKS
        // ─────────────────────────────────────────────────────────────
        console.log('🔍 [SIGNUP DRIVER] Checking for existing account...');
        const { Account, DriverProfile } = require("../models");

        if (email) {
            const existing = await Account.findOne({ where: { email } });
            if (existing) {
                const err = new Error('Email already registered');
                err.status = 409;
                err.code = 'EMAIL_EXISTS';
                throw err;
            }
        }

        if (phone_e164) {
            const existing = await Account.findOne({ where: { phone_e164 } });
            if (existing) {
                const err = new Error('Phone number already registered');
                err.status = 409;
                err.code = 'PHONE_EXISTS';
                throw err;
            }
        }

        if (vehicle_plate) {
            const existingPlate = await DriverProfile.findOne({ where: { vehicle_plate } });
            if (existingPlate) {
                const err = new Error('Vehicle plate number already registered');
                err.status = 409;
                err.code = 'PLATE_EXISTS';
                throw err;
            }
        }

        console.log('✅ [SIGNUP DRIVER] No conflicts found');

        // ─────────────────────────────────────────────────────────────
        // HASH PASSWORD
        // ─────────────────────────────────────────────────────────────
        console.log('🔒 [SIGNUP DRIVER] Hashing password...');
        const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        console.log('✅ [SIGNUP DRIVER] Password hashed');

        // ─────────────────────────────────────────────────────────────
        // UUID & EXPIRY
        // ─────────────────────────────────────────────────────────────
        const uuid = uuidv4();
        const expires_at = new Date(Date.now() + 30 * 60 * 1000);
        console.log(`🆔 [UUID] ${uuid}`);
        console.log(`⏰ [EXPIRY] ${expires_at.toISOString()}`);

        // ─────────────────────────────────────────────────────────────
        // DRIVER DATA JSON
        // ─────────────────────────────────────────────────────────────
        const driver_data = {
            cni_number,
            license_number,
            license_expiry: license_expiry || null,
            insurance_number: insurance_number || null,
            insurance_expiry: insurance_expiry || null,
            vehicle_type: vehicle_type || 'Standard',
            vehicle_make_model: vehicle_make_model || null,
            vehicle_color: vehicle_color || null,
            vehicle_year: vehicle_year ? parseInt(vehicle_year) : null,
            vehicle_plate: vehicle_plate || null,
        };

        // ─────────────────────────────────────────────────────────────
        // CREATE PENDING SIGNUP
        // ─────────────────────────────────────────────────────────────
        console.log('💾 [PENDING SIGNUP] Creating pending driver signup...');

        await PendingSignup.create({
            uuid,
            user_type: 'DRIVER',
            email: email || null,
            phone_e164: phone_e164 || null,
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

        // ─────────────────────────────────────────────────────────────
        // SEND OTP via ONE channel only
        // Priority: SMS first, EMAIL as fallback
        // ─────────────────────────────────────────────────────────────
        console.log('📨 [OTP] Sending verification code via single channel...');

        const otpDelivery = {};

        if (phone_e164) {
            // ── PREFERRED: SMS ────────────────────────────────────
            console.log(`📱 [OTP] Issuing SMS OTP to ${phone_e164}...`);
            try {
                const phoneOtp = await issueOtp(
                    {
                        accountUuid: uuid,
                        purpose: 'PHONE_VERIFY',
                        channel: 'SMS',
                        target: phone_e164,
                    },
                    null
                );
                otpDelivery.phone = {
                    delivery: phoneOtp.delivery,
                    target: phoneOtp.target,
                };
                console.log(`✅ [OTP SMS] Sent → ${phoneOtp.target} (delivery: ${phoneOtp.delivery})`);
            } catch (err) {
                console.error('❌ [OTP SMS FAILED]:', err.message);
                await PendingSignup.destroy({ where: { uuid } });
                throw err;
            }

        } else if (email) {
            // ── FALLBACK: EMAIL (only when no phone provided) ─────
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
                otpDelivery.email = {
                    delivery: emailOtp.delivery,
                    target: emailOtp.target,
                };
                console.log(`✅ [OTP EMAIL] Sent → ${emailOtp.target} (delivery: ${emailOtp.delivery})`);
            } catch (err) {
                console.error('❌ [OTP EMAIL FAILED]:', err.message);
                await PendingSignup.destroy({ where: { uuid } });
                throw err;
            }
        }

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ [SIGNUP DRIVER] Pending driver signup complete!');
        console.log('🆔 Signup UUID:', uuid);
        console.log('👤 Name:', `${first_name} ${last_name}`);
        console.log('📧 Email:', email || 'N/A');
        console.log('📱 Phone:', phone_e164 || 'N/A');
        console.log('🚗 Vehicle:', vehicle_make_model || 'N/A');
        console.log('🔢 Plate:', vehicle_plate || 'N/A');
        console.log('📨 OTP Delivery:', otpDelivery);
        console.log('   Channel used:', phone_e164 ? 'SMS' : 'EMAIL');
        console.log('⏰ Expires at:', expires_at.toISOString());
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return {
            uuid,
            user_type: 'DRIVER',
            email: email || null,
            phone_e164: phone_e164 || null,
            first_name,
            last_name,
            avatar_url: avatar_url || null,
            otpDelivery,
        };

    } catch (err) {
        console.error('💥 [PENDING SIGNUP FAILED]:', err.message);
        console.error('💥 [ERROR DETAILS]:', err);

        if (uploadedFiles.length > 0) {
            console.log('🗑️  [CLEANUP] Deleting uploaded files from R2...');
            for (const fileUrl of uploadedFiles) {
                try {
                    await deleteFromR2(fileUrl);
                    console.log(`   ✅ Deleted: ${fileUrl}`);
                } catch (deleteErr) {
                    console.warn(`   ⚠️  Failed to delete ${fileUrl}: ${deleteErr.message}`);
                }
            }
        }

        if (!err.code) {
            err.code = 'DRIVER_SIGNUP_FAILED';
        }
        throw err;
    }
}

module.exports = {
    signupPassenger,
    signupDriver,
};