// src/services/otp.service.js
const bcrypt = require("bcrypt");
const { Op } = require("sequelize");
const { VerificationCode, Account } = require("../models");
const { sendEmailOtp } = require("./comm/email.service");
const { sendSmsOtp } = require("./comm/sms.service");

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
 * Create and send OTP (email or SMS)
 * @param {Object} param0 { accountUuid, purpose, channel, target }
 * @returns {Object} { id, delivery, channel, target }
 */
async function issueOtp({ accountUuid, purpose, channel, target }, tx) {
    console.log("🚀 [ISSUE OTP] Starting OTP issuance...");
    console.log(`📋 Params => accountUuid: ${accountUuid}, purpose: ${purpose}, channel: ${channel}, target: ${target}`);

    // 1️⃣ Generate OTP and hash
    const code = generateNumericCode();
    const code_hash = await bcrypt.hash(code, ROUNDS);
    const expires_at = new Date(Date.now() + OTP_TTL_MIN * 60 * 1000);
    console.log(`⏳ [OTP HASHED] Expires at: ${expires_at.toISOString()}`);

    // 2️⃣ Save to DB
    console.log("💾 [DB] Creating VerificationCode entry...");
    const vc = await VerificationCode.create(
        {
            account_uuid: accountUuid, // ✅ match your model
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
        console.log(`   Account UUID: ${accountUuid}`);
        console.log(`   Channel: ${channel}`);
        console.log(`   Target:  ${target}`);
        console.log(`   Code:    ${code}`);
        console.log(`   Status:  ${delivery}`);
    }

    console.log("🎯 [ISSUE OTP COMPLETE]");
    return { id: vc.id, delivery, channel, target };
}

/**
 * Send or resend OTP by user identifier (email or phone)
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
        throw e;
    }

    console.log(`✅ [ACCOUNT FOUND] UUID: ${account.uuid}`);

    const res = await issueOtp(
        {
            accountUuid: account.uuid, // ✅ correct column name
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
 * Verify an OTP code and mark account verified.
 * @param {Object} param0 { identifier, purpose, code, channelGuess }
 */
/**
 * Verify an OTP code and automatically detect the correct purpose (EMAIL or PHONE).
 */
async function verifyOtp({ identifier, purpose, code, channelGuess }) {
    console.log("🔐 [VERIFY OTP] Starting verification process...");
    console.log(`📋 Params => identifier: ${identifier}, purpose: ${purpose || "AUTO"}, enteredCode: ${code}`);

    // 1️⃣ Detect communication channel automatically if not provided
    const channel = channelGuess || (identifier.includes("@") ? "EMAIL" : "SMS");
    const whereAcc = channel === "EMAIL" ? { email: identifier } : { phone_e164: identifier };
    const account = await Account.findOne({ where: whereAcc });

    if (!account) {
        console.error("❌ [VERIFY FAILED] Account not found.");
        const e = new Error("Account not found");
        e.status = 404;
        throw e;
    }

    console.log(`✅ [ACCOUNT FOUND] UUID: ${account.uuid}`);

    const now = new Date();

    // 2️⃣ Flexible lookup: if purpose not provided, try both EMAIL_VERIFY and PHONE_VERIFY
    const purposeList = purpose
        ? [purpose]
        : ["EMAIL_VERIFY", "PHONE_VERIFY"];

    const vc = await VerificationCode.findOne({
        where: {
            account_uuid: account.uuid,
            purpose: { [Op.in]: purposeList },
            channel,
            target: identifier,
            consumed_at: { [Op.is]: null },
            expires_at: { [Op.gt]: now },
        },
        order: [["createdAt", "DESC"]],
    });

    if (!vc) {
        console.error("❌ [VERIFY FAILED] No valid OTP found or expired.");
        const e = new Error("No valid OTP found or it expired");
        e.status = 400;
        throw e;
    }

    if (vc.attempts >= vc.max_attempts) {
        console.error("⚠️ [VERIFY FAILED] Too many attempts.");
        const e = new Error("Too many attempts. Request a new OTP.");
        e.status = 429;
        throw e;
    }

    console.log("🔎 [VERIFY] Comparing entered code with stored hash...");
    const ok = await bcrypt.compare(code, vc.code_hash);
    await vc.update({ attempts: vc.attempts + 1 });

    if (!ok) {
        console.error("❌ [VERIFY FAILED] Invalid code.");
        const e = new Error("Invalid OTP");
        e.status = 400;
        throw e;
    }

    console.log("✅ [VERIFY SUCCESS] Code matched. Marking as consumed...");
    await vc.update({ consumed_at: new Date() });

    // 3️⃣ Auto-detect and apply verification purpose
    const detectedPurpose = vc.purpose || purpose;
    console.log(`🎯 [PURPOSE DETECTED] ${detectedPurpose}`);

    if (detectedPurpose === "EMAIL_VERIFY") {
        await account.update({ email_verified: true });
        console.log("📧 [ACCOUNT UPDATE] Email marked as verified.");
    }

    if (detectedPurpose === "PHONE_VERIFY") {
        await account.update({ phone_verified: true });
        console.log("📱 [ACCOUNT UPDATE] Phone marked as verified.");
    }

    console.log("🎉 [VERIFY COMPLETE] OTP successfully verified.");
    return {
        account,
        verified_type:
            detectedPurpose === "EMAIL_VERIFY"
                ? "email"
                : detectedPurpose === "PHONE_VERIFY"
                    ? "phone"
                    : "unknown",
        verified_channel: channel,
    };
}


module.exports = {
    issueOtp,
    sendOtpByIdentifier,
    verifyOtp,
};
