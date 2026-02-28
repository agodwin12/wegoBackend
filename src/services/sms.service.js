// src/services/comm/sms.service.js
//
// ═══════════════════════════════════════════════════════════════════════
// SMS SERVICE — Techsoft SMS API
// ═══════════════════════════════════════════════════════════════════════
// Replaces Twilio. Uses Techsoft HTTP API.
// Phone numbers must be sent WITHOUT the + prefix to the API.
// They are stored WITH the + prefix everywhere else in the system.
// ═══════════════════════════════════════════════════════════════════════

'use strict';

const axios = require('axios');

const SMS_API_URL  = 'https://app.techsoft-sms.com/api/http/sms/send/';
const SMS_API_TOKEN = process.env.TECHSOFT_API_TOKEN || '1453|kZyPuqcJthu1g01kNhhJ1SdI5O1iYoS9S9ZcwCxL379271c5';
const SMS_SENDER_ID = process.env.TECHSOFT_SENDER_ID || 'PROXYM';
const SMS_TIMEOUT   = 15000; // 15 seconds

// ─── Phone normalizer ─────────────────────────────────────────────────
// Techsoft requires the number WITHOUT the + prefix
// e.g. "+237673927172" → "237673927172"
function stripPlus(phone) {
    if (!phone) return '';
    return String(phone).trim().replace(/^\+/, '');
}

// ─── Core send function ───────────────────────────────────────────────
/**
 * Send a raw SMS message via Techsoft
 * @param {string} phone   - Phone in E.164 format with OR without +
 * @param {string} message - Text message body
 * @returns {Promise<{ success: boolean, data?: any, error?: any }>}
 */
async function sendSms(phone, message) {
    const recipient = stripPlus(phone);

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📱 [SMS SERVICE] Sending SMS...');
    console.log(`   Recipient : ${recipient}`);
    console.log(`   Sender ID : ${SMS_SENDER_ID}`);
    console.log(`   Message   : ${message.substring(0, 60)}${message.length > 60 ? '…' : ''}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const payload = {
        api_token:  SMS_API_TOKEN,
        recipient,
        sender_id:  SMS_SENDER_ID,
        type:       'plain',
        message,
    };

    try {
        const startTime = Date.now();

        const response = await axios.post(SMS_API_URL, payload, {
            headers: {
                'Content-Type': 'application/json',
                'Accept':       'application/json',
            },
            timeout: SMS_TIMEOUT,
            // Don't throw on non-2xx — handle manually so we can log properly
            validateStatus: () => true,
        });

        const duration = Date.now() - startTime;
        console.log(`⏱️  [SMS] API responded in ${duration}ms`);

        if (response.status >= 200 && response.status < 300) {
            console.log('✅ [SMS] Sent successfully');
            console.log('   Response:', JSON.stringify(response.data));
            return { success: true, data: response.data };
        }

        // Non-2xx response
        console.error('❌ [SMS] API returned error status:', response.status);
        console.error('   Body:', JSON.stringify(response.data));
        return {
            success: false,
            error: {
                status:  response.status,
                message: response.data?.message || response.statusText,
                data:    response.data,
            },
        };

    } catch (err) {
        console.error('❌ [SMS] Request failed');

        if (err.code === 'ENOTFOUND') {
            console.error('   🌐 DNS lookup failed — cannot reach app.techsoft-sms.com');
            console.error('   Check: internet connectivity, firewall, DNS settings');
        } else if (err.code === 'ETIMEDOUT') {
            console.error('   ⏱️  Connection timed out');
        } else if (err.code === 'ECONNREFUSED') {
            console.error('   🚫 Connection refused by server');
        } else {
            console.error('   Error:', err.message);
        }

        return {
            success: false,
            error: {
                type:    err.code || err.name,
                message: err.message,
            },
        };
    }
}

// ─── OTP-specific sender (used by otp.service.js) ─────────────────────
/**
 * Send a WEGO OTP code via SMS
 * @param {string} phone - Phone in E.164 format e.g. +237673927172
 * @param {string} code  - The numeric OTP code e.g. "482910"
 * @returns {Promise<void>} — throws if sending fails
 */
async function sendSmsOtp(phone, code) {
    console.log(`📲 [SMS OTP] Sending OTP to ${phone}...`);

    const message = `Your WEGO verification code is: ${code}. Valid for ${process.env.OTP_TTL_MIN || 10} minutes. Do not share this code with anyone.`;

    const result = await sendSms(phone, message);

    if (!result.success) {
        console.error('❌ [SMS OTP] Failed to send OTP SMS');
        const err = new Error('Failed to send OTP via SMS. Please try again.');
        err.code   = 'SMS_SEND_FAILED';
        err.status = 503;
        throw err;
    }

    console.log('✅ [SMS OTP] OTP delivered successfully');
}

// ─── Generic notification sender (for future use) ─────────────────────
/**
 * Send a generic notification SMS
 * @param {string} phone   - Recipient phone
 * @param {string} message - Message body
 * @returns {Promise<void>} — throws if sending fails
 */
async function sendSmsNotification(phone, message) {
    console.log(`📣 [SMS NOTIFY] Sending notification to ${phone}...`);

    const result = await sendSms(phone, message);

    if (!result.success) {
        console.warn('⚠️ [SMS NOTIFY] Failed to send notification — non-critical, continuing');
        // Notifications are non-critical — log but don't throw
    } else {
        console.log('✅ [SMS NOTIFY] Notification sent');
    }
}

module.exports = {
    sendSms,
    sendSmsOtp,           // ← used by otp.service.js
    sendSmsNotification,  // ← for future ride/booking alerts
};