// src/services/campay/campayClient.js


'use strict';

const axios        = require('axios');
const tokenManager = require('./campayTokenManager');

const BASE_URL = process.env.CAMPAY_BASE_URL;

if (!BASE_URL) {
    throw new Error('[CAMPAY CLIENT] CAMPAY_BASE_URL is not set in .env');
}

// ── Default request timeout ───────────────────────────────────────────────────
// CamPay can be slow on mobile money networks. 30s is generous but safe.
// Collect/disburse need more time than status checks.
const DEFAULT_TIMEOUT_MS = 30_000;

// ─────────────────────────────────────────────────────────────────────────────

class CamPayClient {

    // ═══════════════════════════════════════════════════════════════════════════
    // COLLECT
    // POST /collect/
    //
    // Sends a payment request to a customer's MTN or Orange Money account.
    // The customer receives a USSD prompt on their phone to confirm with PIN.
    // This call returns immediately with a reference — payment is PENDING.
    // Resolution comes via webhook (preferred) or polling getTransaction().
    //
    // @param {object} payload
    //   @param {string|number} payload.amount             — XAF integer, NO decimals
    //   @param {string}        payload.currency           — always "XAF"
    //   @param {string}        payload.from               — phone with country code e.g. "237670000000"
    //   @param {string}        payload.description        — shown to customer on USSD prompt
    //   @param {string}        payload.external_reference — your unique ref for idempotency
    //
    // @returns {object} CamPay response:
    //   { reference, external_reference, status, ussd_code, operator }
    //   status is initially "PENDING"
    // ═══════════════════════════════════════════════════════════════════════════

    async collect(payload) {
        _validateCollectPayload(payload);

        console.log(`💳 [CAMPAY CLIENT] Collect → ${payload.amount} XAF from ${payload.from} | ref: ${payload.external_reference}`);

        return this._request('POST', '/collect/', payload);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DISBURSE
    // POST /disburse/
    //
    // Sends money FROM WeGo's CamPay balance TO a driver/agent's phone number.
    // Used when admin approves a cashout request.
    //
    // ⚠️  Requires "API Withdrawal" to be enabled in the CamPay app settings.
    //
    // @param {object} payload
    //   @param {string|number} payload.amount             — XAF integer, NO decimals
    //   @param {string}        payload.currency           — always "XAF"
    //   @param {string}        payload.to                 — phone with country code e.g. "237670000000"
    //   @param {string}        payload.description        — internal note for the transfer
    //   @param {string}        payload.external_reference — your unique ref for idempotency
    //
    // @returns {object} CamPay response:
    //   { reference, external_reference, status, amount, currency, operator, operator_reference }
    // ═══════════════════════════════════════════════════════════════════════════

    async disburse(payload) {
        _validateDisbursePayload(payload);

        console.log(`💸 [CAMPAY CLIENT] Disburse → ${payload.amount} XAF to ${payload.to} | ref: ${payload.external_reference}`);

        return this._request('POST', '/disburse/', payload);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // GET TRANSACTION
    // GET /transaction/{reference}/
    //
    // Checks the current status of a transaction by its CamPay reference.
    // Use this for polling if the webhook hasn't arrived yet, or to verify
    // a webhook payload independently.
    //
    // @param {string} reference — CamPay's own transaction reference (NOT external_reference)
    //
    // @returns {object} CamPay response:
    //   { reference, external_reference, status, amount, currency, operator, operator_reference }
    //   status: "PENDING" | "SUCCESSFUL" | "FAILED"
    // ═══════════════════════════════════════════════════════════════════════════

    async getTransaction(reference) {
        if (!reference || typeof reference !== 'string') {
            throw new Error('[CAMPAY CLIENT] getTransaction requires a valid reference string');
        }

        console.log(`🔍 [CAMPAY CLIENT] Checking transaction status: ${reference}`);

        return this._request('GET', `/transaction/${reference}/`);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // GET BALANCE
    // GET /balance/
    //
    // Returns WeGo's current CamPay wallet balance, split by operator.
    // Useful for the admin dashboard and before initiating large disbursements.
    //
    // @returns {object}
    //   { total_balance, mtn_balance, orange_balance, currency }
    // ═══════════════════════════════════════════════════════════════════════════

    async getBalance() {
        console.log('💰 [CAMPAY CLIENT] Fetching CamPay balance...');
        return this._request('GET', '/balance/');
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PRIVATE — _request(method, path, body)
    //
    // All public methods route through here.
    // Handles:
    //   - Token injection into Authorization header
    //   - 401 token refresh + single retry
    //   - CamPay error code extraction and clean error messages
    //   - Consistent logging
    // ═══════════════════════════════════════════════════════════════════════════

    async _request(method, path, body = null, isRetry = false) {
        const token = await tokenManager.getToken();
        const url   = `${BASE_URL}${path}`;

        const config = {
            method,
            url,
            headers: {
                'Authorization': `Token ${token}`,
                'Content-Type':  'application/json',
            },
            timeout: DEFAULT_TIMEOUT_MS,
        };

        if (body && method !== 'GET') {
            config.data = body;
        }

        try {
            const response = await axios(config);
            return response.data;

        } catch (err) {
            const status = err.response?.status;
            const data   = err.response?.data;

            // ── 401: token expired mid-session ────────────────────────────────
            // Invalidate the cached token and retry once with a fresh one.
            if (status === 401 && !isRetry) {
                console.warn('⚠️  [CAMPAY CLIENT] Received 401 — refreshing token and retrying...');
                await tokenManager.invalidate();
                return this._request(method, path, body, true); // retry flag prevents infinite loop
            }

            // ── Extract CamPay error code if present ──────────────────────────
            const campayCode    = data?.code    || null;
            const campayMessage = data?.message || data?.detail || JSON.stringify(data);

            // Map CamPay's own error codes to human-readable messages
            const knownErrors = {
                ER101: 'Invalid phone number. Must include country code (e.g. 237670000000).',
                ER102: 'Unsupported carrier. Only MTN and Orange numbers are accepted.',
                ER201: 'Invalid amount. Decimal amounts are not allowed — use whole XAF integers only.',
                ER301: 'Insufficient CamPay balance to complete this disbursement.',
            };

            const readableMessage = (campayCode && knownErrors[campayCode])
                ? knownErrors[campayCode]
                : campayMessage;

            const error        = new Error(`[CAMPAY CLIENT] ${method} ${path} failed — ${readableMessage}`);
            error.campayCode   = campayCode;
            error.httpStatus   = status;
            error.campayRaw    = data;

            console.error(`❌ [CAMPAY CLIENT] ${method} ${path} → HTTP ${status ?? 'N/A'} | code: ${campayCode ?? 'none'} | ${readableMessage}`);

            throw error;
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE VALIDATORS
// Called before making any API call. Fail fast with clear messages so bugs
// are caught at the point of call, not buried in a CamPay error response.
// ─────────────────────────────────────────────────────────────────────────────

function _validateCollectPayload(payload) {
    const { amount, currency, from, description, external_reference } = payload;

    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
        throw new Error('[CAMPAY CLIENT] collect: amount must be a positive number');
    }
    if (String(amount).includes('.')) {
        throw new Error('[CAMPAY CLIENT] collect: amount must be a whole integer — CamPay rejects decimals (ER201)');
    }
    if (!currency || currency !== 'XAF') {
        throw new Error('[CAMPAY CLIENT] collect: currency must be "XAF"');
    }
    if (!from || !/^237\d{9}$/.test(String(from))) {
        throw new Error('[CAMPAY CLIENT] collect: "from" must be a valid Cameroonian number starting with 237 (e.g. 237670000000)');
    }
    if (!description || typeof description !== 'string' || description.trim().length === 0) {
        throw new Error('[CAMPAY CLIENT] collect: description is required');
    }
    if (!external_reference || typeof external_reference !== 'string') {
        throw new Error('[CAMPAY CLIENT] collect: external_reference is required for idempotency');
    }
}

function _validateDisbursePayload(payload) {
    const { amount, currency, to, description, external_reference } = payload;

    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
        throw new Error('[CAMPAY CLIENT] disburse: amount must be a positive number');
    }
    if (String(amount).includes('.')) {
        throw new Error('[CAMPAY CLIENT] disburse: amount must be a whole integer — CamPay rejects decimals (ER201)');
    }
    if (!currency || currency !== 'XAF') {
        throw new Error('[CAMPAY CLIENT] disburse: currency must be "XAF"');
    }
    if (!to || !/^237\d{9}$/.test(String(to))) {
        throw new Error('[CAMPAY CLIENT] disburse: "to" must be a valid Cameroonian number starting with 237 (e.g. 237670000000)');
    }
    if (!description || typeof description !== 'string' || description.trim().length === 0) {
        throw new Error('[CAMPAY CLIENT] disburse: description is required');
    }
    if (!external_reference || typeof external_reference !== 'string') {
        throw new Error('[CAMPAY CLIENT] disburse: external_reference is required for idempotency');
    }
}

// ── Export a singleton ────────────────────────────────────────────────────────
module.exports = new CamPayClient();