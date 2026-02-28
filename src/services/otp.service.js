// src/services/otp.service.js
'use strict';

const bcrypt = require("bcrypt");
const { Op } = require("sequelize");
const {
    sequelize,
    VerificationCode,
    Account,
    PassengerProfile,
    DriverProfile,
    DriverWallet,
    PendingSignup,
} = require("../models");
const { sendEmailOtp } = require("./comm/email.service");
const { sendSmsOtp }   = require("./comm/sms.service");
const { sendWelcomeEmail } = require("./comm/email.service");

const ROUNDS      = Number(process.env.BCRYPT_ROUNDS || 12);
const OTP_TTL_MIN = Number(process.env.OTP_TTL_MIN   || 10);
const OTP_LEN     = Number(process.env.OTP_LEN        || 6);

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

function generateNumericCode(len = OTP_LEN) {
    const min  = 10 ** (len - 1);
    const max  = 10 ** len - 1;
    const code = String(Math.floor(min + Math.random() * (max - min + 1)));
    console.log(`🔢 [OTP GENERATED] Code: ${code}`);
    return code;
}

// ═══════════════════════════════════════════════════════════════════════
// ISSUE OTP
// Used during signup (pending_signups UUID) and password reset
// ═══════════════════════════════════════════════════════════════════════

async function issueOtp({ accountUuid, purpose, channel, target }, tx) {
    console.log("🚀 [ISSUE OTP] Starting OTP issuance...");
    console.log(`📋 UUID: ${accountUuid} | purpose: ${purpose} | channel: ${channel} | target: ${target}`);

    // 1. Generate + hash
    const code       = generateNumericCode();
    const code_hash  = await bcrypt.hash(code, ROUNDS);
    const expires_at = new Date(Date.now() + OTP_TTL_MIN * 60 * 1000);
    console.log(`⏳ [OTP] Expires at: ${expires_at.toISOString()}`);

    // 2. Persist to DB
    const vc = await VerificationCode.create(
        {
            account_uuid: accountUuid,
            purpose,
            channel,
            target,
            code_hash,
            expires_at,
            attempts:     0,
            max_attempts: 5,
        },
        { transaction: tx }
    );
    console.log(`✅ [OTP DB] VerificationCode ID: ${vc.id}`);

    // 3. Deliver
    let delivery = 'SENT';
    try {
        if (channel === 'EMAIL') {
            console.log(`📧 [OTP] Sending via EMAIL to ${target}...`);
            await sendEmailOtp(target, code);
        } else if (channel === 'SMS') {
            console.log(`📱 [OTP] Sending via SMS to ${target}...`);
            await sendSmsOtp(target, code);
        } else {
            throw new Error(`Unsupported channel: ${channel}`);
        }
        console.log(`✅ [OTP DELIVERED] ${channel} → ${target}`);
    } catch (err) {
        delivery = 'FAILED';
        console.warn(`⚠️ [OTP DELIVERY FAILED] ${channel} → ${target} | ${err?.message}`);
    }

    // 4. Dev mode: log plaintext code
    if (process.env.NODE_ENV !== 'production') {
        console.log('🔍 [DEV OTP]');
        console.log(`   UUID    : ${accountUuid}`);
        console.log(`   Channel : ${channel}`);
        console.log(`   Target  : ${target}`);
        console.log(`   Code    : ${code}`);
        console.log(`   Status  : ${delivery}`);
    }

    return { id: vc.id, delivery, channel, target };
}

// ═══════════════════════════════════════════════════════════════════════
// SEND OTP TO EXISTING ACCOUNT
// Used for: password reset, re-verification
// ═══════════════════════════════════════════════════════════════════════

async function sendOtpByIdentifier({ identifier, channel, purpose }) {
    console.log("🔁 [SEND OTP BY IDENTIFIER]", { identifier, channel, purpose });

    const where   = identifier.includes('@') ? { email: identifier } : { phone_e164: identifier };
    const account = await Account.findOne({ where });

    if (!account) {
        const e = new Error("Account not found for identifier");
        e.status = 404;
        e.code   = 'ACCOUNT_NOT_FOUND';
        throw e;
    }

    console.log(`✅ [ACCOUNT FOUND] UUID: ${account.uuid}`);

    const res = await issueOtp({ accountUuid: account.uuid, purpose, channel, target: identifier }, null);

    return { account, otp: res };
}

// ═══════════════════════════════════════════════════════════════════════
// VERIFY OTP AND CREATE ACCOUNT
// ═══════════════════════════════════════════════════════════════════════
// Flow:
//   1. Find & validate OTP record
//   2. Compare code hash
//   3. Load pending signup data
//   4. In ONE transaction:
//      a. Create Account
//      b. Create PassengerProfile OR DriverProfile
//      c. ✅ If DRIVER → Create DriverWallet (balance=0, status=ACTIVE)
//      d. Delete pending signup
//   5. Commit
//   6. Send welcome email (non-critical, outside tx)
// ═══════════════════════════════════════════════════════════════════════

async function verifyOtpAndCreateAccount({ identifier, purpose, code }) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log("🔐 [VERIFY OTP & CREATE ACCOUNT]");
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`   Identifier : ${identifier}`);
    console.log(`   Purpose    : ${purpose}`);

    // ─────────────────────────────────────────────────────────────
    // STEP 1: Find the OTP record
    // ─────────────────────────────────────────────────────────────
    const now     = new Date();
    const channel = identifier.includes('@') ? 'EMAIL' : 'SMS';
    console.log(`📡 [CHANNEL] ${channel}`);

    const purposeList = purpose ? [purpose] : ['EMAIL_VERIFY', 'PHONE_VERIFY'];

    const vc = await VerificationCode.findOne({
        where: {
            purpose:      { [Op.in]: purposeList },
            channel,
            target:       identifier,
            consumed_at:  { [Op.is]: null },
            expires_at:   { [Op.gt]: now },
        },
        order: [['createdAt', 'DESC']],
    });

    if (!vc) {
        const e = new Error("No valid OTP found or it has expired. Please request a new code.");
        e.status = 400;
        e.code   = 'OTP_EXPIRED';
        throw e;
    }

    console.log(`✅ [OTP FOUND] ID: ${vc.id} | UUID: ${vc.account_uuid}`);

    if (vc.attempts >= vc.max_attempts) {
        const e = new Error("Too many incorrect attempts. Please request a new OTP.");
        e.status = 429;
        e.code   = 'TOO_MANY_ATTEMPTS';
        throw e;
    }

    // ─────────────────────────────────────────────────────────────
    // STEP 2: Verify the code
    // ─────────────────────────────────────────────────────────────
    console.log("🔎 [VERIFY] Comparing code with hash...");

    const isValid = await bcrypt.compare(code, vc.code_hash);
    await vc.update({ attempts: vc.attempts + 1 });

    if (!isValid) {
        const e = new Error("Invalid OTP code. Please try again.");
        e.status = 400;
        e.code   = 'INVALID_OTP';
        throw e;
    }

    await vc.update({ consumed_at: new Date() });
    console.log("✅ [OTP VALID] Code correct, marked as consumed");

    // ─────────────────────────────────────────────────────────────
    // STEP 3: Load pending signup
    // ─────────────────────────────────────────────────────────────
    console.log(`🔍 [PENDING SIGNUP] UUID: ${vc.account_uuid}`);

    const pendingSignup = await PendingSignup.findOne({
        where: { uuid: vc.account_uuid },
    });

    if (!pendingSignup) {
        const e = new Error("Signup session expired. Please start registration again.");
        e.status = 404;
        e.code   = 'SIGNUP_EXPIRED';
        throw e;
    }

    if (new Date() > pendingSignup.expires_at) {
        await PendingSignup.destroy({ where: { uuid: vc.account_uuid } });
        const e = new Error("Signup session expired. Please start registration again.");
        e.status = 400;
        e.code   = 'SIGNUP_EXPIRED';
        throw e;
    }

    console.log(`✅ [PENDING SIGNUP] Found | Type: ${pendingSignup.user_type} | Name: ${pendingSignup.first_name} ${pendingSignup.last_name}`);

    // ─────────────────────────────────────────────────────────────
    // STEP 4: Create account, profile (+ wallet for drivers)
    // ─────────────────────────────────────────────────────────────
    console.log("💾 [TRANSACTION] Starting...");

    const t = await sequelize.transaction();

    try {
        const verifiedPurpose = vc.purpose;
        // ✅ Verifying EITHER channel marks BOTH as verified.
        // A user who verifies their phone has proven their identity —
        // no reason to block email-related features and vice versa.
        const email_verified  = true;
        const phone_verified  = true;
        const status          = pendingSignup.user_type === 'PASSENGER' ? 'ACTIVE' : 'PENDING';

        console.log(`   Status       : ${status}`);
        console.log(`   EmailVerified: ${email_verified}`);
        console.log(`   PhoneVerified: ${phone_verified}`);

        // ── 4a: Account ───────────────────────────────────────────
        console.log("🧱 [ACCOUNT] Creating...");

        const account = await Account.create(
            {
                uuid:          pendingSignup.uuid,
                user_type:     pendingSignup.user_type,
                email:         pendingSignup.email,
                phone_e164:    pendingSignup.phone_e164,
                password_hash: pendingSignup.password_hash,
                password_algo: 'bcrypt',
                first_name:    pendingSignup.first_name,
                last_name:     pendingSignup.last_name,
                civility:      pendingSignup.civility,
                birth_date:    pendingSignup.birth_date,
                avatar_url:    pendingSignup.avatar_url,
                status,
                email_verified,
                phone_verified,
            },
            { transaction: t }
        );

        console.log(`✅ [ACCOUNT] Created — UUID: ${account.uuid}`);

        // ── 4b: Profile ───────────────────────────────────────────
        if (pendingSignup.user_type === 'PASSENGER') {
            console.log("📄 [PASSENGER PROFILE] Creating...");

            await PassengerProfile.create(
                {
                    account_id:   account.uuid,
                    address_text: pendingSignup.address_text || null,
                    notes:        pendingSignup.notes || null,
                },
                { transaction: t }
            );

            console.log("✅ [PASSENGER PROFILE] Created");

        } else if (pendingSignup.user_type === 'DRIVER') {
            console.log("📄 [DRIVER PROFILE] Creating...");

            // Parse driver_data JSON if stored as string
            let driverData = pendingSignup.driver_data || {};
            if (typeof driverData === 'string') {
                try {
                    driverData = JSON.parse(driverData);
                } catch (e) {
                    throw new Error('Invalid driver_data format in pending signup');
                }
            }

            console.log('📋 [DRIVER DATA]');
            console.log(`   CNI          : ${driverData.cni_number}`);
            console.log(`   License      : ${driverData.license_number}`);
            console.log(`   Vehicle Type : ${driverData.vehicle_type}`);
            console.log(`   Plate        : ${driverData.vehicle_plate}`);

            await DriverProfile.create(
                {
                    account_id:             account.uuid,
                    cni_number:             driverData.cni_number,
                    license_number:         driverData.license_number,
                    license_expiry:         driverData.license_expiry         || null,
                    license_document_url:   pendingSignup.license_document_url,
                    insurance_number:       driverData.insurance_number       || null,
                    insurance_expiry:       driverData.insurance_expiry       || null,
                    insurance_document_url: pendingSignup.insurance_document_url || null,
                    vehicle_type:           driverData.vehicle_type           || 'Standard',
                    vehicle_make_model:     driverData.vehicle_make_model     || null,
                    vehicle_color:          driverData.vehicle_color          || null,
                    vehicle_year:           driverData.vehicle_year           || null,
                    vehicle_plate:          driverData.vehicle_plate          || null,
                    vehicle_photo_url:      pendingSignup.vehicle_photo_url   || null,
                    verification_state:     'PENDING',
                    status:                 'offline',
                    rating_avg:             0.0,
                    rating_count:           0,
                },
                { transaction: t }
            );

            console.log("✅ [DRIVER PROFILE] Created");

            // ── 4c: Driver Wallet ─────────────────────────────────
            // Created in the SAME transaction as the account.
            // If wallet creation fails → whole signup rolls back.
            // ─────────────────────────────────────────────────────
            console.log("💰 [DRIVER WALLET] Creating wallet...");

            await DriverWallet.create(
                {
                    driverId:        account.uuid,  // FK → accounts.uuid
                    balance:         0,
                    totalEarned:     0,
                    totalCommission: 0,
                    totalBonuses:    0,
                    totalPayouts:    0,
                    lastPayoutAt:    null,
                    status:          'ACTIVE',       // Active from day one
                    frozenReason:    null,
                    frozenAt:        null,
                    frozenBy:        null,
                    currency:        'XAF',
                },
                { transaction: t }
            );

            console.log("✅ [DRIVER WALLET] Created — balance: 0 XAF, status: ACTIVE");
        }

        // ── 4d: Delete pending signup ─────────────────────────────
        console.log("🗑️  [CLEANUP] Deleting pending signup...");

        await PendingSignup.destroy({
            where:       { uuid: pendingSignup.uuid },
            transaction: t,
        });

        console.log("✅ [CLEANUP] Pending signup deleted");

        // ── Commit ────────────────────────────────────────────────
        await t.commit();
        console.log("💚 [TRANSACTION] Committed successfully");

        // ─────────────────────────────────────────────────────────
        // STEP 5: Welcome email (non-critical, outside transaction)
        // ─────────────────────────────────────────────────────────
        if (pendingSignup.email) {
            try {
                console.log("📨 [WELCOME EMAIL] Sending...");
                await sendWelcomeEmail(pendingSignup.email, pendingSignup.first_name || 'User');
                console.log("✅ [WELCOME EMAIL] Sent");
            } catch (err) {
                // Non-critical — never block account creation
                console.warn("⚠️ [WELCOME EMAIL] Failed (non-critical):", err.message);
            }
        }

        // ─────────────────────────────────────────────────────────
        // STEP 6: Return
        // ─────────────────────────────────────────────────────────
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log("🎉 [ACCOUNT CREATED]");
        console.log(`   UUID      : ${account.uuid}`);
        console.log(`   Type      : ${account.user_type}`);
        console.log(`   Name      : ${account.first_name} ${account.last_name}`);
        console.log(`   Status    : ${account.status}`);
        console.log(`   Wallet    : ${account.user_type === 'DRIVER' ? '✅ Created (0 XAF)' : 'N/A (passenger)'}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return {
            account,
            verified_type: verifiedPurpose === 'EMAIL_VERIFY' ? 'email' : 'phone',
        };

    } catch (err) {
        await t.rollback();
        console.error("💥 [TRANSACTION ROLLBACK] Account creation failed");
        console.error("   Error:", err.message);
        console.error("   Stack:", err.stack);

        if (!err.code) err.code = 'ACCOUNT_CREATION_FAILED';
        throw err;
    }
}

// ═══════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════

module.exports = {
    issueOtp,
    sendOtpByIdentifier,
    verifyOtpAndCreateAccount,
};