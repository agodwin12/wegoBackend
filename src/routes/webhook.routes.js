// src/routes/webhook.routes.js
//
// ═══════════════════════════════════════════════════════════════════════════════
// WEBHOOK ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
//
// Mounts the CamPay inbound webhook endpoint.
//
// ⚠️  CRITICAL — app.js mounting order:
//   This MUST be mounted BEFORE express.json() middleware, or use the
//   rawBody capture middleware below to preserve the raw request buffer.
//   Signature validation (HMAC-SHA256) requires the original bytes,
//   not the parsed JSON object.
//
//   In app.js, add BEFORE any auth middleware:
//     const webhookRoutes = require('./routes/webhook.routes');
//     app.use('/api/webhooks', webhookRoutes);
//
// No authentication middleware on this router — CamPay has no JWT.
// Security is handled inside the controller via signature validation.
//
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/payment/campayWebhook.controller');

// ── rawBody capture middleware ────────────────────────────────────────────────
// express.json() parses and discards the raw buffer. We need the raw bytes to
// compute the HMAC signature. This middleware runs before JSON parsing and
// attaches req.rawBody so the webhook controller can verify the signature.
//
// Only applies to routes on this router — does not affect the rest of the app.
const captureRawBody = (req, res, next) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { data += chunk; });
    req.on('end',  ()    => {
        req.rawBody = data;
        try {
            // Parse body manually so req.body is still available downstream
            req.body = JSON.parse(data);
        } catch {
            req.body = {};
        }
        next();
    });
};

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

router.post('/campay', captureRawBody, ctrl.handleWebhook);

module.exports = router;