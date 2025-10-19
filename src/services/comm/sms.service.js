const twilio = require('twilio');

let client;

// Helper to ensure required environment variables exist
function required(name, val) {
    if (!val) {
        console.error(`[SMS ERROR] Missing ${name} in environment variables ❌`);
        throw new Error(`[SMS] Missing ${name} in environment`);
    }
    return val;
}

// ================== INITIALIZE TWILIO CLIENT ==================
async function initSms() {
    console.log("\n================= INITIALIZING TWILIO =================");

    const sid = required('TWILIO_SID', process.env.TWILIO_SID);
    const token = required('TWILIO_TOKEN', process.env.TWILIO_TOKEN);
    const from = required('SMS_FROM', process.env.SMS_FROM);

    console.log(`[SMS DEBUG] Using Twilio SID: ${sid}`);
    console.log(`[SMS DEBUG] Using SMS From Number: ${from}`);

    client = twilio(sid, token);

    try {
        console.log("[SMS DEBUG] Verifying Twilio credentials...");
        await client.api.v2010.accounts(sid).fetch();
        console.log("[SMS DEBUG] Twilio client successfully initialized ✅");
    } catch (err) {
        console.error("[SMS ERROR] Failed to initialize Twilio client ❌");
        console.error("[SMS ERROR DETAILS]:", err.message || err);
        throw err;
    }
}

// ================== SEND GENERIC SMS ==================
async function sendSms(to, body) {
    console.log("\n================= SENDING SMS =================");
    if (!client) {
        console.log("[SMS DEBUG] Twilio client not initialized yet, initializing...");
        await initSms();
    }

    const from = process.env.SMS_FROM;
    console.log(`[SMS DEBUG] Sending SMS to: ${to}`);
    console.log(`[SMS DEBUG] From: ${from}`);
    console.log(`[SMS DEBUG] Message Body: ${body}`);

    try {
        const message = await client.messages.create({ to, from, body });
        console.log("[SMS DEBUG] SMS sent successfully ✅");
        console.log("[SMS DEBUG] Twilio Message SID:", message.sid);
        console.log("[SMS DEBUG] Message Status:", message.status);
        return message;
    } catch (err) {
        console.error("[SMS ERROR] Failed to send SMS ❌");
        console.error("[SMS ERROR DETAILS]:", err.message || err);
        throw err;
    }
}

// ================== SEND OTP VIA SMS ==================
async function sendSmsOtp(to, code) {
    console.log("\n================= SENDING OTP VIA SMS =================");
    console.log(`[SMS DEBUG] Sending OTP to: ${to}`);
    console.log(`[SMS DEBUG] OTP Code: ${code}`);

    const body = `WEGO code: ${code}. Expires in 10 minutes.`;

    try {
        const message = await sendSms(to, body);
        console.log("[SMS DEBUG] OTP SMS sent successfully ✅");
        return message;
    } catch (err) {
        console.error("[SMS ERROR] Failed to send OTP SMS ❌");
        throw err;
    }
}

module.exports = { initSms, sendSms, sendSmsOtp };
