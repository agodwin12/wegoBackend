// src/services/auth.services.js
const { v4: uuidv4 } = require("uuid");
const bcrypt = require("bcrypt");
const { sequelize, Account, PassengerProfile, DriverProfile } = require("../models");
const { issueOtp } = require("./otp.service");
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
        const err = new Error("Either email or phone number is required.");
        err.status = 400;
        throw err;
    }

    // ✅ Step 2: Check duplicates
    if (email) {
        const existingEmail = await Account.findOne({ where: { email } });
        if (existingEmail) {
            const err = new Error("Email already registered");
            err.status = 409;
            throw err;
        }
    }

    if (phone_e164) {
        const existingPhone = await Account.findOne({ where: { phone_e164 } });
        if (existingPhone) {
            const err = new Error("Phone number already registered");
            err.status = 409;
            throw err;
        }
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
                account_id: uuid, // link via UUID
                address_text: address_text || null,
                notes: notes || null,
            },
            { transaction: t }
        );
        console.log("✅ [PROFILE CREATED] Passenger profile linked successfully.");

        await t.commit();
        console.log("💚 [TRANSACTION COMMIT] Passenger account and profile saved.");

        // ✅ Step 5: Welcome email
        if (email) {
            try {
                console.log("📨 [WELCOME EMAIL] Sending welcome email...");
                await sendWelcomeEmail(email, first_name || "Passenger");
                console.log("✅ [WELCOME EMAIL] Sent successfully.");
            } catch (err) {
                console.warn("⚠️ [WELCOME EMAIL FAILED]:", err.message);
            }
        }

        // ✅ Step 6: Issue OTPs
        console.log("📨 [OTP] Sending verification codes...");
        const otpDelivery = {};

        // ---- EMAIL OTP ----
        if (email) {
            try {
                console.log(`📧 [OTP] Issuing EMAIL OTP to ${email}...`);
                const emailOtp = await issueOtp({
                    accountUuid: account.uuid, // ✅ fixed
                    purpose: "EMAIL_VERIFY",
                    channel: "EMAIL",
                    target: email,
                });
                otpDelivery.email = {
                    delivery: emailOtp.delivery,
                    target: emailOtp.target,
                };
                console.log(`✅ [OTP EMAIL SENT] → ${emailOtp.target}`);
            } catch (err) {
                console.error("❌ [OTP EMAIL FAILED]:", err.message);
                otpDelivery.email = { delivery: "FAILED", error: err.message };
            }
        }

        // ---- PHONE OTP ----
        if (phone_e164) {
            try {
                console.log(`📱 [OTP] Issuing SMS OTP to ${phone_e164}...`);
                const phoneOtp = await issueOtp({
                    accountUuid: account.uuid, // ✅ fixed
                    purpose: "PHONE_VERIFY",
                    channel: "SMS",
                    target: phone_e164,
                });
                otpDelivery.phone = {
                    delivery: phoneOtp.delivery,
                    target: phoneOtp.target,
                };
                console.log(`✅ [OTP SMS SENT] → ${phoneOtp.target}`);
            } catch (err) {
                console.error("❌ [OTP SMS FAILED]:", err.message);
                otpDelivery.phone = { delivery: "FAILED", error: err.message };
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
        throw err;
    }
}

/**
 * ==========================================================
 * 🚘 REGISTER DRIVER ACCOUNT
 * ==========================================================
 */
async function signupDriver(data) {
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🚘 [SIGNUP DRIVER] Starting driver registration process...");
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
        cni_number,
        license_number,
        license_expiry,
        vehicle_brand,
        vehicle_model,
        vehicle_year,
        vehicle_plate,
        insurance_number,
        insurance_expiry,
    } = data;

    // ✅ Validation
    if (!email && !phone_e164) {
        const err = new Error("Either email or phone number is required.");
        err.status = 400;
        throw err;
    }

    if (!license_number) {
        const err = new Error("License number is required.");
        err.status = 400;
        throw err;
    }

    if (!cni_number) {
        const err = new Error("CNI number is required.");
        err.status = 400;
        throw err;
    }

    // ✅ Duplicate checks
    if (email) {
        const existingEmail = await Account.findOne({ where: { email } });
        if (existingEmail) {
            const err = new Error("Email already registered");
            err.status = 409;
            throw err;
        }
    }

    if (phone_e164) {
        const existingPhone = await Account.findOne({ where: { phone_e164 } });
        if (existingPhone) {
            const err = new Error("Phone number already registered");
            err.status = 409;
            throw err;
        }
    }

    // ✅ Hash password
    console.log("🔐 [SECURITY] Hashing driver password...");
    const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    console.log("✅ [SECURITY] Password hashed successfully.");

    // ✅ Transaction
    console.log("💾 [TRANSACTION] Starting driver account creation...");
    const t = await sequelize.transaction();

    try {
        const uuid = uuidv4();

        // 4.1️⃣ Create Account
        console.log("🧱 [ACCOUNT] Creating Driver Account record...");
        const account = await Account.create(
            {
                uuid,
                user_type: "DRIVER",
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
                status: "PENDING", // awaiting admin approval
            },
            { transaction: t }
        );
        console.log(`✅ [ACCOUNT CREATED] UUID: ${account.uuid}`);

        // 4.2️⃣ Create Driver Profile
        console.log("📄 [PROFILE] Creating DriverProfile record...");
        await DriverProfile.create(
            {
                account_id: uuid,
                cni_number,
                license_number,
                license_expiry: license_expiry || null,
                vehicle_brand: vehicle_brand || null,
                vehicle_model: vehicle_model || null,
                vehicle_year: vehicle_year || null,
                vehicle_plate: vehicle_plate || null,
                insurance_number: insurance_number || null,
                insurance_expiry: insurance_expiry || null,
            },
            { transaction: t }
        );
        console.log("✅ [PROFILE CREATED] Driver profile linked successfully.");

        await t.commit();
        console.log("💚 [TRANSACTION COMMIT] Driver account and profile saved.");

        // ✅ Welcome Email
        if (email) {
            try {
                console.log("📨 [WELCOME EMAIL] Sending welcome email...");
                await sendWelcomeEmail(email, first_name || "Driver");
                console.log("✅ [WELCOME EMAIL] Sent successfully.");
            } catch (err) {
                console.warn("⚠️ [WELCOME EMAIL FAILED]:", err.message);
            }
        }

        // ✅ OTPs
        console.log("📨 [OTP] Sending verification codes...");
        const otpDelivery = {};

        if (email) {
            try {
                console.log(`📧 [OTP] Issuing EMAIL OTP to ${email}...`);
                const emailOtp = await issueOtp({
                    accountUuid: account.uuid, // ✅ fixed
                    purpose: "EMAIL_VERIFY",
                    channel: "EMAIL",
                    target: email,
                });
                otpDelivery.email = {
                    delivery: emailOtp.delivery,
                    target: emailOtp.target,
                };
                console.log(`✅ [OTP EMAIL SENT] → ${emailOtp.target}`);
            } catch (err) {
                console.error("❌ [OTP EMAIL FAILED]:", err.message);
                otpDelivery.email = { delivery: "FAILED", error: err.message };
            }
        }

        if (phone_e164) {
            try {
                console.log(`📱 [OTP] Issuing SMS OTP to ${phone_e164}...`);
                const phoneOtp = await issueOtp({
                    accountUuid: account.uuid, // ✅ fixed
                    purpose: "PHONE_VERIFY",
                    channel: "SMS",
                    target: phone_e164,
                });
                otpDelivery.phone = {
                    delivery: phoneOtp.delivery,
                    target: phoneOtp.target,
                };
                console.log(`✅ [OTP SMS SENT] → ${phoneOtp.target}`);
            } catch (err) {
                console.error("❌ [OTP SMS FAILED]:", err.message);
                otpDelivery.phone = { delivery: "FAILED", error: err.message };
            }
        }

        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.log("🎉 [SIGNUP SUCCESS] Driver registered successfully.");
        console.log("🆔 Account UUID:", account.uuid);
        console.log("👤 Name:", `${first_name || ""} ${last_name || ""}`);
        console.log("📧 Email:", email || "N/A");
        console.log("📱 Phone:", phone_e164 || "N/A");
        console.log("🪪 CNI:", cni_number);
        console.log("🚘 License:", license_number);
        console.log("⏳ Status: PENDING (awaiting admin approval)");
        console.log("📨 OTP Delivery:", otpDelivery);
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

        return { account, otpDelivery };
    } catch (err) {
        await t.rollback();
        console.error("💥 [TRANSACTION ROLLBACK] Driver signup failed:", err.message);
        throw err;
    }
}

module.exports = {
    signupPassenger,
    signupDriver,
};
