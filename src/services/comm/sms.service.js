// src/services/comm/sms.service.js
'use strict';

const axios = require('axios');

// ═══════════════════════════════════════════════════════════════
// TECHSOFT SMS CONFIG
// ═══════════════════════════════════════════════════════════════
//
// Techsoft expects:
// - api_token
// - recipient WITHOUT +
// - sender_id
// - type: plain
// - message
//
// Example:
// +237673030303 → 237673030303
//
// Required .env:
// TECHSOFT_API_TOKEN=your_token
// TECHSOFT_SENDER_ID=PROXYM
//
// Optional .env:
// TECHSOFT_SMS_URL=https://app.techsoft-sms.com/api/http/sms/send/
// TECHSOFT_SMS_TIMEOUT=15000
//

const SMS_API_URL =
    process.env.TECHSOFT_SMS_URL ||
    'https://app.techsoft-sms.com/api/http/sms/send/';

const SMS_API_TOKEN =
    process.env.TECHSOFT_API_TOKEN;

const SMS_SENDER_ID =
    process.env.TECHSOFT_SENDER_ID ||
    'PROXYM';

const SMS_TIMEOUT =
    parseInt(process.env.TECHSOFT_SMS_TIMEOUT || '15000', 10);

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function required(name, value) {
    if (!value) {
        console.error(`[SMS ERROR] Missing ${name} in environment variables`);
        const err = new Error(`[SMS] Missing ${name} in environment`);
        err.code = 'SMS_CONFIG_MISSING';
        err.status = 500;
        throw err;
    }

    return value;
}

function normalizeRecipient(phone) {
    if (!phone) return '';

    return String(phone)
        .trim()
        .replace(/\s+/g, '')
        .replace(/^\+/, '');
}

function maskToken(token) {
    if (!token) return 'N/A';
    if (token.length <= 10) return '********';
    return `${token.substring(0, 6)}...${token.substring(token.length - 4)}`;
}

function buildOtpMessage(code) {
    const ttl = process.env.OTP_TTL_MIN || 10;
    return `WEGO code: ${code}. Expires in ${ttl} minutes. Do not share this code.`;
}

// ═══════════════════════════════════════════════════════════════
// INIT / HEALTH CHECK
// ═══════════════════════════════════════════════════════════════

async function initSms() {
    console.log('\n================= INITIALIZING TECHSOFT SMS =================');

    required('TECHSOFT_API_TOKEN', SMS_API_TOKEN);

    console.log(`[SMS DEBUG] Provider      : Techsoft`);
    console.log(`[SMS DEBUG] API URL       : ${SMS_API_URL}`);
    console.log(`[SMS DEBUG] Sender ID     : ${SMS_SENDER_ID}`);
    console.log(`[SMS DEBUG] API Token     : ${maskToken(SMS_API_TOKEN)}`);
    console.log(`[SMS DEBUG] Timeout       : ${SMS_TIMEOUT}ms`);
    console.log('=============================================================\n');

    return true;
}

// ═══════════════════════════════════════════════════════════════
// SEND GENERIC SMS
// ═══════════════════════════════════════════════════════════════

async function sendSms(to, message) {
    const apiToken = required('TECHSOFT_API_TOKEN', SMS_API_TOKEN);
    const recipient = normalizeRecipient(to);

    if (!recipient) {
        const err = new Error('SMS recipient is required');
        err.code = 'SMS_RECIPIENT_REQUIRED';
        err.status = 400;
        throw err;
    }

    if (!message) {
        const err = new Error('SMS message body is required');
        err.code = 'SMS_MESSAGE_REQUIRED';
        err.status = 400;
        throw err;
    }

    const payload = {
        api_token: apiToken,
        recipient,
        sender_id: SMS_SENDER_ID,
        type: 'plain',
        message,
    };

    console.log('\n================= SENDING SMS VIA TECHSOFT =================');
    console.log(`[SMS DEBUG] Recipient original : ${to}`);
    console.log(`[SMS DEBUG] Recipient techsoft : ${recipient}`);
    console.log(`[SMS DEBUG] Sender ID          : ${SMS_SENDER_ID}`);
    console.log(`[SMS DEBUG] Message            : ${message}`);
    console.log('============================================================');

    try {
        const startedAt = Date.now();

        const response = await axios.post(SMS_API_URL, payload, {
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            timeout: SMS_TIMEOUT,
            validateStatus: () => true,
        });

        const duration = Date.now() - startedAt;

        console.log(`[SMS DEBUG] Techsoft responded in ${duration}ms`);
        console.log(`[SMS DEBUG] HTTP Status: ${response.status}`);
        console.log(`[SMS DEBUG] Body: ${JSON.stringify(response.data)}`);

        if (response.status >= 200 && response.status < 300) {
            console.log('[SMS DEBUG] SMS sent successfully ✅');
            console.log('============================================================\n');

            return {
                success: true,
                provider: 'TECHSOFT',
                status: response.status,
                data: response.data,
            };
        }

        console.error('[SMS ERROR] Techsoft returned non-success status ❌');
        console.error(`[SMS ERROR] Status: ${response.status}`);
        console.error(`[SMS ERROR] Body: ${JSON.stringify(response.data)}`);
        console.error('============================================================\n');

        const err = new Error(
            response.data?.message ||
            response.data?.error ||
            `Techsoft SMS failed with status ${response.status}`
        );

        err.code = 'SMS_SEND_FAILED';
        err.status = 503;
        err.providerStatus = response.status;
        err.providerResponse = response.data;

        throw err;

    } catch (err) {
        console.error('[SMS ERROR] Failed to send SMS ❌');

        if (err.code === 'ENOTFOUND') {
            console.error('[SMS ERROR] DNS lookup failed — cannot reach Techsoft.');
        } else if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') {
            console.error('[SMS ERROR] Request timed out.');
        } else if (err.code === 'ECONNREFUSED') {
            console.error('[SMS ERROR] Connection refused by Techsoft endpoint.');
        }

        console.error('[SMS ERROR DETAILS]:', err.message);
        console.error('============================================================\n');

        if (!err.status) err.status = 503;
        if (!err.code || err.code === 'ERR_BAD_REQUEST') err.code = 'SMS_SEND_FAILED';

        throw err;
    }
}

// ═══════════════════════════════════════════════════════════════
// SEND OTP VIA SMS
// ═══════════════════════════════════════════════════════════════

async function sendSmsOtp(to, code) {
    console.log('\n================= SENDING OTP VIA TECHSOFT SMS =================');
    console.log(`[SMS DEBUG] Sending OTP to: ${to}`);
    console.log(`[SMS DEBUG] OTP Code: ${code}`);

    if (!code) {
        const err = new Error('OTP code is required');
        err.code = 'OTP_CODE_REQUIRED';
        err.status = 400;
        throw err;
    }

    const message = buildOtpMessage(code);

    try {
        const result = await sendSms(to, message);

        console.log('[SMS DEBUG] OTP SMS sent successfully ✅');
        console.log('===============================================================\n');

        return result;

    } catch (err) {
        console.error('[SMS ERROR] Failed to send OTP SMS ❌');
        console.error('[SMS ERROR DETAILS]:', err.message);
        console.error('===============================================================\n');

        if (!err.status) err.status = 503;
        if (!err.code) err.code = 'SMS_SEND_FAILED';

        throw err;
    }
}

// ═══════════════════════════════════════════════════════════════
// SEND GENERIC NOTIFICATION SMS
// ═══════════════════════════════════════════════════════════════

async function sendSmsNotification(to, message) {
    console.log('\n================= SENDING NOTIFICATION SMS =================');
    console.log(`[SMS DEBUG] Recipient: ${to}`);

    try {
        return await sendSms(to, message);
    } catch (err) {
        console.error('[SMS ERROR] Notification SMS failed ❌');
        console.error('[SMS ERROR DETAILS]:', err.message);
        throw err;
    }
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
    initSms,
    sendSms,
    sendSmsOtp,
    sendSmsNotification,
};