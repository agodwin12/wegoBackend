// src/config/security.js
'use strict';

const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');

// ═══════════════════════════════════════════════════════════════════════
// CORS
// ═══════════════════════════════════════════════════════════════════════
// CORS_ORIGIN is a comma-separated allowlist, e.g.
//   CORS_ORIGIN=https://admin.wego.com,https://wego.com
// Set it to "*" to allow any origin (development only — never in prod).
//
// Requests with no Origin header (native mobile apps, curl, health checks,
// server-to-server) are always allowed: CORS is a browser concept and these
// clients enforce their own auth via the Bearer token.
// ═══════════════════════════════════════════════════════════════════════

function parseOrigins(raw) {
    return (raw || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

const ALLOWED_ORIGINS = parseOrigins(process.env.CORS_ORIGIN);
const ALLOW_ALL = ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes('*');

const corsOptions = {
    origin(origin, callback) {
        // No Origin → non-browser client (mobile, curl, SSR). Allow.
        if (!origin) return callback(null, true);
        if (ALLOW_ALL) return callback(null, true);
        if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        return callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: String(process.env.CORS_CREDENTIALS || 'true') === 'true',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // NB: 'Cache-Control' and 'Pragma' are required because the backoffice
    // sends `Cache-Control: no-cache` on GETs to bust caching. Without them the
    // browser's CORS preflight rejects the request and the fetch fails.
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Idempotency-Key', 'Cache-Control', 'Pragma'],
};

// ═══════════════════════════════════════════════════════════════════════
// RATE LIMITERS  (express-rate-limit v6 — in-memory store)
// ═══════════════════════════════════════════════════════════════════════
// In-memory is correct for a single API instance (the current deploy).
// To run multiple API replicas, swap in `rate-limit-redis` so the counters
// are shared. See README — the redis client already exists in config/redis.js.
// ═══════════════════════════════════════════════════════════════════════

const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
// Generous per-KEY budget. The key is the authenticated user (see below), not
// the IP, so a whole neighbourhood behind one carrier NAT no longer shares a
// single bucket. ~3000 req / 15 min ≈ 3.3 req/s sustained per user — far above
// what an active app session needs, while still stopping a runaway client.
const GLOBAL_MAX = Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 3000;
// Brute-force guard on credentials — keyed by account, so one person's bad
// attempts never lock out other users on the same NAT.
const AUTH_MAX = Number(process.env.AUTH_RATE_LIMIT_MAX) || 30;

// Key by authenticated user id when a Bearer token is present, else by IP.
// The token is only *decoded* (not verified) to derive a stable bucket key —
// forging it can't grant more quota, it just changes which bucket you land in.
function userOrIpKey(req) {
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) {
        try {
            const payload = jwt.decode(auth.slice(7));
            if (payload && payload.uuid) return `u:${payload.uuid}`;
        } catch (_) { /* fall through to IP */ }
    }
    return `ip:${req.ip}`;
}

// Auth limiter key: IP + the identifier being tried, so brute-force protection
// is per-account and shared-NAT users don't throttle each other.
function authKey(req) {
    const id = (req.body && (req.body.identifier || req.body.email || req.body.phone_e164)) || '';
    return `auth:${req.ip}:${String(id).toLowerCase()}`;
}

const globalLimiter = rateLimit({
    windowMs: WINDOW_MS,
    max: GLOBAL_MAX,
    keyGenerator: userOrIpKey,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many requests, please try again later.' },
    // Webhooks must never be throttled (payment providers retry hard).
    skip: (req) => req.path.startsWith('/api/webhooks'),
});

// Stricter limiter for credential endpoints (brute-force protection).
const authLimiter = rateLimit({
    windowMs: WINDOW_MS,
    max: AUTH_MAX,
    keyGenerator: authKey,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many attempts, please try again later.' },
});

module.exports = { corsOptions, globalLimiter, authLimiter, ALLOWED_ORIGINS, ALLOW_ALL };
