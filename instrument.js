// instrument.js
// ─────────────────────────────────────────────────────────────────────────────
// Sentry MUST be initialised before anything else is required, so its
// OpenTelemetry auto-instrumentation can patch http / express / mysql2 at load
// time. server.js requires this file on its very first line.
//
// Tuning is env-driven (all optional — sane defaults below):
//   SENTRY_DSN                    override the DSN (defaults to the project DSN)
//   SENTRY_ENABLED=false          disable the SDK entirely (e.g. noisy local dev)
//   SENTRY_ENVIRONMENT            defaults to NODE_ENV
//   SENTRY_RELEASE                release/version tag for grouping
//   SENTRY_TRACES_SAMPLE_RATE     0..1 (default: prod 0.1, else 1.0)
//   SENTRY_PROFILES_SAMPLE_RATE   0..1, relative to sampled traces (default 1.0)
//   SENTRY_ENABLE_LOGS=false      stop shipping console logs to Sentry Logs
//   SENTRY_SEND_PII=true          attach IP / request bodies / user data
// ─────────────────────────────────────────────────────────────────────────────
const path = require('path');

// Load env early so we can read SENTRY_* before init. server.js loads .env again
// with override:true afterwards — harmless (dotenv is idempotent here).
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const Sentry = require('@sentry/node');

const environment = process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development';
const enabled = process.env.SENTRY_ENABLED !== 'false';

// A DSN is a public, write-only key (safe to embed). Overridable per-env.
const dsn = process.env.SENTRY_DSN
    || 'https://443ff27c84ebdafc9c4b0670c0489cf2@o4511547077427200.ingest.de.sentry.io/4511693339951184';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const tracesSampleRate = num(process.env.SENTRY_TRACES_SAMPLE_RATE, environment === 'production' ? 0.1 : 1.0);

// Optional CPU profiling — only wired if @sentry/profiling-node is installed.
// Loaded defensively so a missing/unbuildable native binary never blocks boot.
const integrations = [];
let profilesSampleRate = 0;
try {
    const { nodeProfilingIntegration } = require('@sentry/profiling-node');
    integrations.push(nodeProfilingIntegration());
    profilesSampleRate = num(process.env.SENTRY_PROFILES_SAMPLE_RATE, 1.0);
} catch (_) {
    // @sentry/profiling-node not installed — errors, tracing and logs still work.
}

Sentry.init({
    dsn,
    enabled,
    environment,
    release: process.env.SENTRY_RELEASE || undefined,

    // Performance tracing — sample a fraction of requests (lower in prod to
    // control event volume; full sampling in dev).
    tracesSampleRate,

    // Profiling is relative to sampled traces.
    profilesSampleRate,
    integrations,

    // Ship structured / console logs to Sentry Logs.
    enableLogs: process.env.SENTRY_ENABLE_LOGS !== 'false',

    // Don't attach PII (IP, request bodies, user data) unless explicitly opted in.
    sendDefaultPii: process.env.SENTRY_SEND_PII === 'true',
});

if (enabled) {
    console.log(`🛰️  [SENTRY] Initialised — env=${environment}, tracing=${tracesSampleRate}, profiling=${profilesSampleRate > 0 ? profilesSampleRate : 'off'}`);
} else {
    console.log('🛰️  [SENTRY] Disabled (SENTRY_ENABLED=false)');
}

module.exports = Sentry;
