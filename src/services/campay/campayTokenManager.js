// src/services/campay/campayTokenManager.js


'use strict';

const axios               = require('axios');
const { redisClient }     = require('../../config/redis');

// ── Redis key & TTL ───────────────────────────────────────────────────────────
// CamPay temporary tokens last ~60 minutes.
// We cache for 50 minutes so we never serve a token that is about to expire.
const REDIS_KEY      = 'campay:auth_token';
const CACHE_TTL_SECS = 50 * 60; // 50 minutes

// ── CamPay token endpoint ─────────────────────────────────────────────────────
const TOKEN_URL = `${process.env.CAMPAY_BASE_URL}/token/`;

// ─────────────────────────────────────────────────────────────────────────────

class CamPayTokenManager {

    // ═══════════════════════════════════════════════════════════════════════════
    // PUBLIC — getToken()
    //
    // Returns a valid CamPay bearer token.
    // Checks Redis first; fetches fresh if missing or expired.
    // ═══════════════════════════════════════════════════════════════════════════

    async getToken() {

        // ── Shortcut: permanent token configured ──────────────────────────────
        // Set CAMPAY_PERMANENT_TOKEN in .env to skip the token exchange entirely.
        // Useful for testing or if CamPay issues you a non-expiring key.
        if (process.env.CAMPAY_PERMANENT_TOKEN) {
            return process.env.CAMPAY_PERMANENT_TOKEN;
        }

        // ── Try cache first ───────────────────────────────────────────────────
        try {
            const cached = await redisClient.get(REDIS_KEY);
            if (cached) {
                return cached;
            }
        } catch (redisErr) {
            // Redis failure is non-fatal — fall through to fetch a fresh token.
            // Log the warning so ops can see Redis health issues.
            console.warn('⚠️  [CAMPAY TOKEN] Redis read failed, fetching fresh token:', redisErr.message);
        }

        // ── Fetch fresh token from CamPay ─────────────────────────────────────
        return this._fetchAndCache();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PUBLIC — invalidate()
    //
    // Removes the cached token from Redis, forcing the next getToken() call
    // to fetch a fresh one. Call this if CamPay returns 401 on any request
    // so we don't keep retrying with a stale token.
    // ═══════════════════════════════════════════════════════════════════════════

    async invalidate() {
        try {
            await redisClient.del(REDIS_KEY);
            console.log('🔄 [CAMPAY TOKEN] Cache invalidated — next call will fetch fresh token');
        } catch (err) {
            console.warn('⚠️  [CAMPAY TOKEN] Failed to invalidate cache:', err.message);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PRIVATE — _fetchAndCache()
    //
    // Calls POST /token/ with app credentials, stores the result in Redis.
    // Throws if CamPay returns an error — callers must handle this.
    // ═══════════════════════════════════════════════════════════════════════════

    async _fetchAndCache() {

        const username = process.env.CAMPAY_APP_USERNAME;
        const password = process.env.CAMPAY_APP_PASSWORD;

        if (!username || !password) {
            throw new Error(
                '[CAMPAY TOKEN] CAMPAY_APP_USERNAME or CAMPAY_APP_PASSWORD is not set in .env'
            );
        }

        console.log('🔑 [CAMPAY TOKEN] Fetching fresh token from CamPay...');

        let response;
        try {
            response = await axios.post(
                TOKEN_URL,
                { username, password },
                {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 10_000, // 10 second timeout
                }
            );
        } catch (err) {
            // Provide a clean error regardless of whether it was a network failure
            // or a 4xx/5xx from CamPay.
            const status  = err.response?.status;
            const detail  = err.response?.data || err.message;
            throw new Error(
                `[CAMPAY TOKEN] Failed to fetch token — HTTP ${status ?? 'N/A'}: ${JSON.stringify(detail)}`
            );
        }

        const token = response.data?.token;

        if (!token) {
            throw new Error(
                `[CAMPAY TOKEN] CamPay response did not include a token: ${JSON.stringify(response.data)}`
            );
        }

        // ── Store in Redis with TTL ───────────────────────────────────────────
        try {
            await redisClient.setex(REDIS_KEY, CACHE_TTL_SECS, token);
            console.log(`✅ [CAMPAY TOKEN] Token cached in Redis for ${CACHE_TTL_SECS / 60} minutes`);
        } catch (redisErr) {
            // Non-fatal — the token is still valid, we just won't cache it this time.
            console.warn('⚠️  [CAMPAY TOKEN] Failed to cache token in Redis:', redisErr.message);
        }

        return token;
    }
}

// ── Export a singleton ────────────────────────────────────────────────────────
// All callers share the same instance so Redis is never hit more than needed.
module.exports = new CamPayTokenManager();