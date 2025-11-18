// src/services/auth.services.js
const { v4: uuidv4 } = require("uuid");
const bcrypt = require("bcrypt");
const { sequelize, Account, PassengerProfile, DriverProfile } = require("../models");
const { issueOtp, sendOtpByIdentifier } = require("./otp.service"); // ✅ ADD sendOtpByIdentifier
const { sendWelcomeEmail } = require("./comm/email.service");

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || "12", 10);

/**
 * ==========================================================
 * 🧍 REGISTER PASSENGER ACCOUNT
 * ==========================================================
 */
async function signupPassenger(data) {
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🚖 [SIGNUP PASSENGER] Starting passenger registration process...");
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
        address_text,
        notes,
    } = data;

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

    // ✅ Step 2: Check duplicates
    if (email) {
        console.log(`🔍 [DUPLICATE CHECK] Checking if email exists: ${email}`);
        const existingEmail = await Account.findOne({ where: { email } });
        if (existingEmail) {
            console.log("❌ [DUPLICATE] Email already registered");
            const err = new Error("Email already registered");
            err.status = 409;
            err.code = 'EMAIL_ALREADY_EXISTS';
            throw err;
        }
        console.log("✅ [DUPLICATE CHECK] Email is available");
    }

    if (phone_e164) {
        console.log(`🔍 [DUPLICATE CHECK] Checking if phone exists: ${phone_e164}`);
        const existingPhone = await Account.findOne({ where: { phone_e164 } });
        if (existingPhone) {
            console.log("❌ [DUPLICATE] Phone number already registered");
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

    // ✅ Step 4: Begin transaction
    console.log("💾 [TRANSACTION] Starting passenger account creation...");
    const t = await sequelize.transaction();

    try {
        // 4.1️⃣ Create Account
        const uuid = uuidv4();
        console.log("🧱 [ACCOUNT] Creating Account record...");
        console.log(`   UUID: ${uuid}`);
        console.log(`   User Type: PASSENGER`);
        console.log(`   Email: ${email || 'N/A'}`);
        console.log(`   Phone: ${phone_e164 || 'N/A'}`);

        const account = await Account.create(
            {
                uuid,
                user_type: "PASSENGER",
                email: email || null,
                phone_e164: phone_e164 || null,
                phone_verified: false,
                email_verified: false,
                password_hash,
                password_algo: "bcrypt",
                civility: civility || null,
                first_name: first_name || null,
                last_name: last_name || null,
                birth_date: birth_date || null,
                avatar_url: avatar_url || null,
                status: "ACTIVE",
            },
            { transaction: t }
        );
        console.log(`✅ [ACCOUNT CREATED] UUID: ${account.uuid}`);

        // 4.2️⃣ Create Passenger Profile
        console.log("📄 [PROFILE] Creating PassengerProfile record...");
        await PassengerProfile.create(
            {
                account_id: uuid,
                address_text: address_text || null,
                notes: notes || null,
            },
            { transaction: t }
        );
        console.log("✅ [PROFILE CREATED] Passenger profile linked successfully.");

        // 4.3️⃣ Issue OTPs within transaction
        console.log("📨 [OTP] Sending verification codes...");
        const otpDelivery = {};

        // ---- EMAIL OTP ----
        if (email) {
            try {
                console.log(`📧 [OTP] Issuing EMAIL OTP to ${email}...`);
                const emailOtp = await issueOtp(
                    {
                        accountUuid: account.uuid,
                        purpose: "EMAIL_VERIFY",
                        channel: "EMAIL",
                        target: email,
                    },
                    t // ✅ Pass transaction
                );
                otpDelivery.email = {
                    delivery: emailOtp.delivery,
                    target: emailOtp.target,
                };
                console.log(`✅ [OTP EMAIL SENT] → ${emailOtp.target}`);
            } catch (err) {
                console.error("❌ [OTP EMAIL FAILED]:", err.message);
                // ✅ Rollback if OTP fails
                throw err;
            }
        }

        // ---- PHONE OTP ----
        if (phone_e164) {
            try {
                console.log(`📱 [OTP] Issuing SMS OTP to ${phone_e164}...`);
                const phoneOtp = await issueOtp(
                    {
                        accountUuid: account.uuid,
                        purpose: "PHONE_VERIFY",
                        channel: "SMS",
                        target: phone_e164,
                    },
                    t // ✅ Pass transaction
                );
                otpDelivery.phone = {
                    delivery: phoneOtp.delivery,
                    target: phoneOtp.target,
                };
                console.log(`✅ [OTP SMS SENT] → ${phoneOtp.target}`);
            } catch (err) {
                console.error("❌ [OTP SMS FAILED]:", err.message);
                // ✅ Rollback if OTP fails
                throw err;
            }
        }

        // ✅ Commit transaction
        await t.commit();
        console.log("💚 [TRANSACTION COMMIT] Passenger account and profile saved.");

        // ✅ Step 5: Welcome email (outside transaction, non-critical)
        if (email) {
            try {
                console.log("📨 [WELCOME EMAIL] Sending welcome email...");
                await sendWelcomeEmail(email, first_name || "Passenger");
                console.log("✅ [WELCOME EMAIL] Sent successfully.");
            } catch (err) {
                console.warn("⚠️ [WELCOME EMAIL FAILED]:", err.message);
                // Non-critical error - continue execution
            }
        }

        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.log("🎉 [SIGNUP SUCCESS] Passenger registered successfully.");
        console.log("🆔 Account UUID:", account.uuid);
        console.log("👤 Name:", `${first_name || ""} ${last_name || ""}`);
        console.log("📧 Email:", email || "N/A");
        console.log("📱 Phone:", phone_e164 || "N/A");
        console.log("🖼️ Avatar:", avatar_url || "No avatar");
        console.log("📨 OTP Delivery:", otpDelivery);
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

        return { account, otpDelivery };
    } catch (err) {
        await t.rollback();
        console.error("💥 [TRANSACTION ROLLBACK] Passenger signup failed:", err.message);
        console.error("💥 [ERROR DETAILS]:", err);

        // Add error code if not present
        if (!err.code) {
            err.code = 'SIGNUP_FAILED';
        }
        throw err;
    }
}

// ═══════════════════════════════════════════════════════════════
// SIGN UP DRIVER - ✅ NOW WITH TRANSACTION
// ═══════════════════════════════════════════════════════════════
async function signupDriver(data) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🚗 [SIGNUP DRIVER] Creating driver account...');
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

    // ✅ Driver-specific validation
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
    // CHECK IF ACCOUNT EXISTS
    // ─────────────────────────────────────────────────────────────
    console.log('🔍 [SIGNUP DRIVER] Checking for existing account...');

    if (email) {
        const existing = await Account.findOne({ where: { email } });
        if (existing) {
            console.log('❌ [SIGNUP DRIVER] Email already registered');
            const err = new Error('Email already registered');
            err.status = 409;
            err.code = 'EMAIL_EXISTS';
            throw err;
        }
    }

    if (phone_e164) {
        const existing = await Account.findOne({ where: { phone_e164 } });
        if (existing) {
            console.log('❌ [SIGNUP DRIVER] Phone already registered');
            const err = new Error('Phone number already registered');
            err.status = 409;
            err.code = 'PHONE_EXISTS';
            throw err;
        }
    }

    // Check vehicle plate uniqueness
    if (vehicle_plate) {
        const existingPlate = await DriverProfile.findOne({ where: { vehicle_plate } });
        if (existingPlate) {
            console.log('❌ [SIGNUP DRIVER] Vehicle plate already registered');
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
    // ✅ START TRANSACTION
    // ─────────────────────────────────────────────────────────────
    console.log('💾 [TRANSACTION] Starting driver account creation...');
    const t = await sequelize.transaction();

    try {
        // ─────────────────────────────────────────────────────────────
        // CREATE ACCOUNT
        // ─────────────────────────────────────────────────────────────
        console.log('💾 [SIGNUP DRIVER] Creating account record...');
        const uuid = uuidv4();

        const account = await Account.create(
            {
                uuid,
                user_type: 'DRIVER',
                email: email || null,
                phone_e164: phone_e164 || null,
                password_hash,
                password_algo: 'bcrypt',
                first_name,
                last_name,
                civility: civility || null,
                birth_date: birth_date || null,
                avatar_url: avatar_url || null,
                status: 'PENDING', // Drivers need admin approval
                email_verified: false,
                phone_verified: false,
            },
            { transaction: t }
        );

        console.log('✅ [SIGNUP DRIVER] Account created:', account.uuid);

        // ─────────────────────────────────────────────────────────────
        // CREATE DRIVER PROFILE
        // ─────────────────────────────────────────────────────────────
        console.log('🚗 [SIGNUP DRIVER] Creating driver profile...');

        await DriverProfile.create(
            {
                account_id: account.uuid,

                // Identity & Documents
                cni_number,
                license_number,
                license_expiry: license_expiry || null,
                license_document_url,
                insurance_number: insurance_number || null,
                insurance_expiry: insurance_expiry || null,
                insurance_document_url: insurance_document_url || null,

                // Vehicle Information
                vehicle_type: vehicle_type || 'Standard',
                vehicle_make_model: vehicle_make_model || null,
                vehicle_color: vehicle_color || null,
                vehicle_year: vehicle_year ? parseInt(vehicle_year) : null,
                vehicle_plate: vehicle_plate || null,
                vehicle_photo_url: vehicle_photo_url || null,

                // Status
                verification_state: 'PENDING',
                status: 'offline',
                rating_avg: 0.0,
                rating_count: 0,
            },
            { transaction: t }
        );

        console.log('✅ [SIGNUP DRIVER] Driver profile created');

        // ─────────────────────────────────────────────────────────────
        // ✅ SEND OTP VERIFICATION (WITHIN TRANSACTION)
        // ─────────────────────────────────────────────────────────────
        console.log('📧 [SIGNUP DRIVER] Sending OTP verification...');

        const otpDelivery = {};

        if (email) {
            try {
                console.log(`📧 [OTP] Issuing EMAIL OTP to ${email}...`);
                const emailOtp = await issueOtp(
                    {
                        accountUuid: account.uuid,
                        purpose: 'EMAIL_VERIFY',
                        channel: 'EMAIL',
                        target: email,
                    },
                    t // ✅ Pass transaction
                );
                otpDelivery.email = {
                    delivery: emailOtp.delivery,
                    target: emailOtp.target,
                };
                console.log('✅ [SIGNUP DRIVER] OTP sent to email');
            } catch (err) {
                console.error('❌ [SIGNUP DRIVER] Failed to send email OTP:', err.message);
                // ✅ Rollback on failure
                throw err;
            }
        }

        if (phone_e164) {
            try {
                console.log(`📱 [OTP] Issuing SMS OTP to ${phone_e164}...`);
                const phoneOtp = await issueOtp(
                    {
                        accountUuid: account.uuid,
                        purpose: 'PHONE_VERIFY',
                        channel: 'SMS',
                        target: phone_e164,
                    },
                    t // ✅ Pass transaction
                );
                otpDelivery.phone = {
                    delivery: phoneOtp.delivery,
                    target: phoneOtp.target,
                };
                console.log('✅ [SIGNUP DRIVER] OTP sent to phone');
            } catch (err) {
                console.error('❌ [SIGNUP DRIVER] Failed to send SMS OTP:', err.message);
                // ✅ Rollback on failure
                throw err;
            }
        }

        // ✅ COMMIT TRANSACTION
        await t.commit();
        console.log('💚 [TRANSACTION COMMIT] Driver account and profile saved.');

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ [SIGNUP DRIVER] Driver registration complete!');
        console.log('🆔 Account UUID:', account.uuid);
        console.log('👤 Name:', `${first_name} ${last_name}`);
        console.log('📧 Email:', email || 'N/A');
        console.log('📱 Phone:', phone_e164 || 'N/A');
        console.log('🚗 Vehicle:', vehicle_make_model || 'N/A');
        console.log('🔢 Plate:', vehicle_plate || 'N/A');
        console.log('📨 OTP Delivery:', otpDelivery);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return { account, otpDelivery };
    } catch (err) {
        await t.rollback();
        console.error('💥 [TRANSACTION ROLLBACK] Driver signup failed:', err.message);
        console.error('💥 [ERROR DETAILS]:', err);

        // Add error code if not present
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