'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Payment freshness helper (pure — no DB / no network deps, so it is trivially
// unit-testable).
//
// A pending CamPay collection should only BLOCK a new payment attempt while it
// is genuinely in progress: its WegoPayment is still PENDING and was initiated
// within the freshness window below. Anything older, or already resolved
// (SUCCESSFUL / FAILED / EXPIRED), or with no WegoPayment at all, is treated as
// stale — so a provider/customer is never dead-locked behind an abandoned
// attempt (the caller cancels the stale record and lets them retry).
// ─────────────────────────────────────────────────────────────────────────────

const PAYMENT_FRESH_MS = 15 * 60 * 1000; // 15 minutes — matches the expiry job

/**
 * @param {object|null} wp   A WegoPayment-like object ({ status, initiated_at }).
 * @param {Date} [now]       Injectable clock for testing.
 * @returns {boolean}        true only if the payment is still genuinely in progress.
 */
function isPaymentStillInProgress(wp, now = new Date()) {
    if (!wp || wp.status !== 'PENDING' || !wp.initiated_at) return false;
    const initiatedMs = new Date(wp.initiated_at).getTime();
    if (Number.isNaN(initiatedMs)) return false;
    return initiatedMs > (now.getTime() - PAYMENT_FRESH_MS);
}

module.exports = { isPaymentStillInProgress, PAYMENT_FRESH_MS };
