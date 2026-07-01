// src/config/security.js
'use strict';

const rateLimit = require('express-rate-limit');

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
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Idempotency-Key'],
};

// ═══════════════════════════════════════════════════════════════════════
// RATE LIMITERS  (express-rate-limit v6 — in-memory store)
// ═══════════════════════════════════════════════════════════════════════
// In-memory is correct for a single API instance (the current deploy).
// To run multiple API replicas, swap in `rate-limit-redis` so the counters
// are shared. See README — the redis client already exists in config/redis.js.
// ═══════════════════════════════════════════════════════════════════════

const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
const GLOBAL_MAX = Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 100;
const AUTH_MAX = Number(process.env.AUTH_RATE_LIMIT_MAX) || 10;

const globalLimiter = rateLimit({
    windowMs: WINDOW_MS,
    max: GLOBAL_MAX,
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
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many attempts, please try again later.' },
});

module.exports = { corsOptions, globalLimiter, authLimiter, ALLOWED_ORIGINS, ALLOW_ALL };
