// src/services/otp.service.js
const bcrypt = require("bcrypt");
const { Op } = require("sequelize");
const { sequelize, VerificationCode, Account, PassengerProfile, DriverProfile, PendingSignup } = require("../models");
const { sendEmailOtp } = require("./comm/email.service");
const { sendSmsOtp } = require("./comm/sms.service");
const { sendWelcomeEmail } = require("./comm/email.service");

const ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);
const OTP_TTL_MIN = Number(process.env.OTP_TTL_MIN || 10);
const OTP_LEN = Number(process.env.OTP_LEN || 6);

/**
 * Generate numeric OTP (default: 6 digits)
 */
function generateNumericCode(len = OTP_LEN) {
    const min = 10 ** (len - 1);
    const max = 10 ** len - 1;
    const code = String(Math.floor(min + Math.random() * (max - min + 1)));
    console.log(`🔢 [OTP GENERATED] Code: ${code}`);
    return code;
}

/**
 * ═══════════════════════════════════════════════════════════════
 * CREATE AND SEND OTP
 * ═══════════════════════════════════════════════════════════════
 * Used for: Pending signups (uses UUID from pending_signups table)
 * @param {Object} param0 { accountUuid, purpose, channel, target }
 * @param {Transaction} tx - Sequelize transaction (optional)
 * @returns {Object} { id, delivery, channel, target }
 */
async function issueOtp({ accountUuid, purpose, channel, target }, tx) {
    console.log("🚀 [ISSUE OTP] Starting OTP issuance...");
    console.log(`📋 Params => UUID: ${accountUuid}, purpose: ${purpose}, channel: ${channel}, target: ${target}`);

    // 1️⃣ Generate OTP and hash
    const code = generateNumericCode();
    const code_hash = await bcrypt.hash(code, ROUNDS);
    const expires_at = new Date(Date.now() + OTP_TTL_MIN * 60 * 1000);
    console.log(`⏳ [OTP HASHED] Expires at: ${expires_at.toISOString()}`);

    // 2️⃣ Save to DB
    console.log("💾 [DB] Creating VerificationCode entry...");
    const vc = await VerificationCode.create(
        {
            account_uuid: accountUuid,
            purpose,
            channel,
            target,
            code_hash,
            expires_at,
            attempts: 0,
            max_attempts: 5,
        },
        { transaction: tx }
    );
    console.log(`✅ [DB SAVED] VerificationCode ID: ${vc.id}`);

    // 3️⃣ Try to deliver
    let delivery = "SENT";
    try {
        if (channel === "EMAIL") {
            console.log(`📧 [DELIVERY] Sending OTP via EMAIL to ${target}...`);
            await sendEmailOtp(target, code);
        } else if (channel === "SMS") {
            console.log(`📱 [DELIVERY] Sending OTP via SMS to ${target}...`);
            await sendSmsOtp(target, code);
        } else {
            throw new Error(`Unsupported channel: ${channel}`);
        }
        console.log(`✅ [DELIVERY SUCCESS] Channel: ${channel}, Target: ${target}`);
    } catch (err) {
        delivery = "FAILED";
        console.warn("⚠️ [DELIVERY FAILED]", { channel, target, error: err?.message || err });
    }

    // 4️⃣ Show code in dev mode
    if (process.env.NODE_ENV !== "production") {
        console.log("🔍 [DEV OTP INFO]");
        console.log(`   UUID: ${accountUuid}`);
        console.log(`   Channel: ${channel}`);
        console.log(`   Target:  ${target}`);
        console.log(`   Code:    ${code}`);
        console.log(`   Status:  ${delivery}`);
    }

    console.log("🎯 [ISSUE OTP COMPLETE]");
    return { id: vc.id, delivery, channel, target };
}

/**
 * ═══════════════════════════════════════════════════════════════
 * SEND OTP TO EXISTING ACCOUNT (For password reset, etc.)
 * ═══════════════════════════════════════════════════════════════
 * Used for: Resending OTP to already created accounts
 * @param {Object} param0 { identifier, channel, purpose }
 */
async function sendOtpByIdentifier({ identifier, channel, purpose }) {
    console.log("🔁 [SEND OTP BY IDENTIFIER] Starting...");
    console.log(`📋 Params => identifier: ${identifier}, channel: ${channel}, purpose: ${purpose}`);

    const where = channel === "EMAIL" ? { email: identifier } : { phone_e164: identifier };
    const account = await Account.findOne({ where });

    if (!account) {
        console.error("❌ [SEND OTP] Account not found");
        const e = new Error("Account not found for identifier");
        e.status = 404;
        e.code = 'ACCOUNT_NOT_FOUND';
        throw e;
    }

    console.log(`✅ [ACCOUNT FOUND] UUID: ${account.uuid}`);

    const res = await issueOtp(
        {
            accountUuid: account.uuid,
            purpose,
            channel,
            target: identifier,
        },
        null
    );

    console.log("🎉 [SEND OTP COMPLETE]");
    return { account, otp: res };
}

/**
 * ═══════════════════════════════════════════════════════════════
 * VERIFY OTP AND CREATE ACCOUNT FROM PENDING SIGNUP
 * ═══════════════════════════════════════════════════════════════
 * This is the MAIN verification function for new signups.
 * It:
 * 1. Verifies the OTP code
 * 2. Retrieves pending signup data
 * 3. Creates Account + Profile in a transaction
 * 4. Marks email/phone as verified
 * 5. Deletes pending signup
 *
 * @param {Object} param0 { identifier, purpose, code }
 * @returns {Object} { account, verified_type }
 */
async function verifyOtpAndCreateAccount({ identifier, purpose, code }) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log("🔐 [VERIFY OTP & CREATE ACCOUNT] Starting...");
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📋 Identifier: ${identifier}`);
    console.log(`🎯 Purpose: ${purpose}`);
    console.log(`🔢 Code: ${code}`);

    // ─────────────────────────────────────────────────────────────
    // STEP 1: Find the OTP verification code
    // ─────────────────────────────────────────────────────────────
    const now = new Date();
    const channel = identifier.includes("@") ? "EMAIL" : "SMS";

    console.log(`📡 [CHANNEL DETECTED] ${channel}`);

    // Flexible purpose lookup
    const purposeList = purpose ? [purpose] : ["EMAIL_VERIFY", "PHONE_VERIFY"];

    const vc = await VerificationCode.findOne({
        where: {
            purpose: { [Op.in]: purposeList },
            channel,
            target: identifier,
            consumed_at: { [Op.is]: null },
            expires_at: { [Op.gt]: now },
        },
        order: [["createdAt", "DESC"]],
    });

    if (!vc) {
        console.error("❌ [VERIFY FAILED] No valid OTP found or expired");
        const e = new Error("No valid OTP found or it has expired. Please request a new code.");
        e.status = 400;
        e.code = 'OTP_EXPIRED';
        throw e;
    }

    console.log(`✅ [OTP FOUND] VerificationCode ID: ${vc.id}`);
    console.log(`   UUID: ${vc.account_uuid}`);
    console.log(`   Purpose: ${vc.purpose}`);

    // Check attempts
    if (vc.attempts >= vc.max_attempts) {
        console.error("⚠️ [VERIFY FAILED] Too many attempts");
        const e = new Error("Too many incorrect attempts. Please request a new OTP.");
        e.status = 429;
        e.code = 'TOO_MANY_ATTEMPTS';
        throw e;
    }

    // ─────────────────────────────────────────────────────────────
    // STEP 2: Verify the OTP code
    // ─────────────────────────────────────────────────────────────
    console.log("🔎 [VERIFY] Comparing entered code with stored hash...");

    const isValid = await bcrypt.compare(code, vc.code_hash);

    // Increment attempts
    await vc.update({ attempts: vc.attempts + 1 });

    if (!isValid) {
        console.error("❌ [VERIFY FAILED] Invalid OTP code");
        const e = new Error("Invalid OTP code. Please try again.");
        e.status = 400;
        e.code = 'INVALID_OTP';
        throw e;
    }

    console.log("✅ [VERIFY SUCCESS] OTP code is correct!");

    // Mark OTP as consumed
    await vc.update({ consumed_at: new Date() });
    console.log("✅ [OTP CONSUMED] Marked as used");

    // ─────────────────────────────────────────────────────────────
    // STEP 3: Get pending signup data
    // ─────────────────────────────────────────────────────────────
    console.log(`🔍 [PENDING SIGNUP] Looking for UUID: ${vc.account_uuid}`);

    const pendingSignup = await PendingSignup.findOne({
        where: { uuid: vc.account_uuid },
    });

    if (!pendingSignup) {
        console.error("❌ [PENDING SIGNUP] Not found or expired");
        const e = new Error("Signup session expired. Please start registration again.");
        e.status = 404;
        e.code = 'SIGNUP_EXPIRED';
        throw e;
    }

    console.log("✅ [PENDING SIGNUP] Found pending signup data");
    console.log(`   User Type: ${pendingSignup.user_type}`);
    console.log(`   Name: ${pendingSignup.first_name} ${pendingSignup.last_name}`);
    console.log(`   Email: ${pendingSignup.email || 'N/A'}`);
    console.log(`   Phone: ${pendingSignup.phone_e164 || 'N/A'}`);

    // Check if expired
    if (new Date() > pendingSignup.expires_at) {
        console.error("❌ [PENDING SIGNUP] Expired");
        await PendingSignup.destroy({ where: { uuid: vc.account_uuid } });
        const e = new Error("Signup session expired. Please start registration again.");
        e.status = 400;
        e.code = 'SIGNUP_EXPIRED';
        throw e;
    }

    // ─────────────────────────────────────────────────────────────
    // STEP 4: Create actual Account + Profile in transaction
    // ─────────────────────────────────────────────────────────────
    console.log("💾 [CREATE ACCOUNT] Starting transaction...");

    const t = await sequelize.transaction();

    try {
        // Determine verification status
        const verifiedPurpose = vc.purpose;
        const email_verified = verifiedPurpose === 'EMAIL_VERIFY';
        const phone_verified = verifiedPurpose === 'PHONE_VERIFY';

        // Determine status based on user type
        const status = pendingSignup.user_type === 'PASSENGER' ? 'ACTIVE' : 'PENDING';

        console.log(`📝 [ACCOUNT STATUS] Will be: ${status}`);
        console.log(`✅ [VERIFICATION] Email: ${email_verified}, Phone: ${phone_verified}`);

        // ─────────────────────────────────────────────────────────
        // 4.1: Create Account
        // ─────────────────────────────────────────────────────────
        console.log("🧱 [ACCOUNT] Creating Account record...");

        const account = await Account.create(
            {
                uuid: pendingSignup.uuid, // ✅ Use same UUID
                user_type: pendingSignup.user_type,
                email: pendingSignup.email,
                phone_e164: pendingSignup.phone_e164,
                password_hash: pendingSignup.password_hash,
                password_algo: 'bcrypt',
                first_name: pendingSignup.first_name,
                last_name: pendingSignup.last_name,
                civility: pendingSignup.civility,
                birth_date: pendingSignup.birth_date,
                avatar_url: pendingSignup.avatar_url,
                status,
                email_verified,
                phone_verified,
            },
            { transaction: t }
        );

        console.log(`✅ [ACCOUNT CREATED] UUID: ${account.uuid}`);

        // ─────────────────────────────────────────────────────────
        // 4.2: Create Profile (Passenger or Driver)
        // ─────────────────────────────────────────────────────────

        if (pendingSignup.user_type === 'PASSENGER') {
            console.log("📄 [PROFILE] Creating PassengerProfile...");

            await PassengerProfile.create(
                {
                    account_id: account.uuid,
                    address_text: pendingSignup.address_text || null,
                    notes: pendingSignup.notes || null,
                },
                { transaction: t }
            );

            console.log("✅ [PROFILE] PassengerProfile created");
        }
        else if (pendingSignup.user_type === 'DRIVER') {
            console.log("📄 [PROFILE] Creating DriverProfile...");

            // ✅ FIX: Properly extract driver_data
            let driverData = pendingSignup.driver_data || {};

            // If driver_data is stored as a string, parse it
            if (typeof driverData === 'string') {
                try {
                    driverData = JSON.parse(driverData);
                } catch (e) {
                    console.error('❌ [PROFILE] Failed to parse driver_data:', e);
                    throw new Error('Invalid driver data format');
                }
            }

            // ✅ ADD DEBUG LOGS
            console.log('📋 [DRIVER DATA] Extracted data:');
            console.log('   CNI:', driverData.cni_number);
            console.log('   License:', driverData.license_number);
            console.log('   Vehicle Type:', driverData.vehicle_type);
            console.log('   Vehicle Make/Model:', driverData.vehicle_make_model);
            console.log('   Vehicle Plate:', driverData.vehicle_plate);

            await DriverProfile.create(
                {
                    account_id: account.uuid,

                    // Identity & Documents
                    cni_number: driverData.cni_number,
                    license_number: driverData.license_number,
                    license_expiry: driverData.license_expiry || null,
                    license_document_url: pendingSignup.license_document_url,
                    insurance_number: driverData.insurance_number || null,
                    insurance_expiry: driverData.insurance_expiry || null,
                    insurance_document_url: pendingSignup.insurance_document_url || null,

                    // Vehicle Information
                    vehicle_type: driverData.vehicle_type || 'Standard',
                    vehicle_make_model: driverData.vehicle_make_model || null,
                    vehicle_color: driverData.vehicle_color || null,
                    vehicle_year: driverData.vehicle_year || null,
                    vehicle_plate: driverData.vehicle_plate || null,
                    vehicle_photo_url: pendingSignup.vehicle_photo_url || null,

                    // Status
                    verification_state: 'PENDING',
                    status: 'offline',
                    rating_avg: 0.0,
                    rating_count: 0,
                },
                { transaction: t }
            );

            console.log("✅ [PROFILE] DriverProfile created");
        }

        // ─────────────────────────────────────────────────────────
        // 4.3: Delete pending signup record
        // ─────────────────────────────────────────────────────────
        console.log("🗑️  [CLEANUP] Deleting pending signup record...");

        await PendingSignup.destroy({
            where: { uuid: pendingSignup.uuid },
            transaction: t,
        });

        console.log("✅ [CLEANUP] Pending signup deleted");

        // ─────────────────────────────────────────────────────────
        // 4.4: Commit transaction
        // ─────────────────────────────────────────────────────────
        await t.commit();
        console.log("💚 [TRANSACTION COMMIT] Account created successfully!");

        // ─────────────────────────────────────────────────────────
        // STEP 5: Send welcome email (non-critical, outside transaction)
        // ─────────────────────────────────────────────────────────
        if (pendingSignup.email) {
            try {
                console.log("📨 [WELCOME EMAIL] Sending welcome email...");
                await sendWelcomeEmail(
                    pendingSignup.email,
                    pendingSignup.first_name || "User"
                );
                console.log("✅ [WELCOME EMAIL] Sent successfully");
            } catch (err) {
                console.warn("⚠️ [WELCOME EMAIL] Failed:", err.message);
                // Non-critical - don't throw error
            }
        }

        // ─────────────────────────────────────────────────────────
        // STEP 6: Return created account
        // ─────────────────────────────────────────────────────────
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log("🎉 [VERIFY & CREATE] Account created successfully!");
        console.log(`🆔 UUID: ${account.uuid}`);
        console.log(`👤 Name: ${account.first_name} ${account.last_name}`);
        console.log(`📧 Email: ${account.email || 'N/A'}`);
        console.log(`📱 Phone: ${account.phone_e164 || 'N/A'}`);
        console.log(`📊 Status: ${account.status}`);
        console.log(`✅ Email Verified: ${account.email_verified}`);
        console.log(`✅ Phone Verified: ${account.phone_verified}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return {
            account,
            verified_type: verifiedPurpose === "EMAIL_VERIFY" ? "email" : "phone",
        };

    } catch (err) {
        await t.rollback();
        console.error("💥 [TRANSACTION ROLLBACK] Account creation failed");
        console.error("💥 [ERROR]:", err.message);
        console.error("💥 [STACK]:", err.stack);

        // Add error code if not present
        if (!err.code) {
            err.code = 'ACCOUNT_CREATION_FAILED';
        }
        throw err;
    }
}

module.exports = {
    issueOtp,
    sendOtpByIdentifier,
    verifyOtpAndCreateAccount, // ✅ NEW - Main verification function
};