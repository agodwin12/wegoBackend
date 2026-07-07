// src/jobs/paymentExpiry.job.js


'use strict';

const cron           = require('node-cron');
const { Op }         = require('sequelize');
const { WegoPayment, Delivery } = require('../models');
const campayService  = require('../services/campay/campayService');

// ── Configuration ─────────────────────────────────────────────────────────────
const EXPIRY_MINUTES = 15;
const CRON_SCHEDULE  = '* * * * *'; // every minute

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find all PENDING payments older than EXPIRY_MINUTES and mark them EXPIRED.
 * Also resets vertical state so the customer can retry.
 *
 * Called by the cron schedule and also exported for manual testing.
 *
 * @returns {{ expired: number, errors: number }}
 */
async function runExpiryCheck() {
    const cutoff = new Date(Date.now() - EXPIRY_MINUTES * 60 * 1000);

    // ── Find all expired PENDING payments ────────────────────────────────────
    const expiredPayments = await WegoPayment.findAll({
        where: {
            status:       'PENDING',
            initiated_at: { [Op.lt]: cutoff },
        },
        attributes: ['id', 'external_ref', 'vertical', 'vertical_id', 'initiated_at'],
    });

    if (expiredPayments.length === 0) {
        return { expired: 0, errors: 0 };
    }

    console.log(`\n⏳ [PAYMENT EXPIRY] Found ${expiredPayments.length} payment(s) to expire`);

    let expired = 0;
    let errors  = 0;

    for (const payment of expiredPayments) {
        try {
            await _expirePayment(payment);
            expired++;
        } catch (err) {
            errors++;
            console.error(`❌ [PAYMENT EXPIRY] Failed to expire payment ${payment.external_ref}:`, err.message);
        }
    }

    if (expired > 0) {
        console.log(`✅ [PAYMENT EXPIRY] Expired ${expired} payment(s) | Errors: ${errors}\n`);
    }

    return { expired, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE — expire one payment
// ─────────────────────────────────────────────────────────────────────────────

async function _expirePayment(payment) {
    const minutesOld = Math.round((Date.now() - new Date(payment.initiated_at).getTime()) / 60000);

    console.log(`  ⏱️  Expiring: ${payment.external_ref} | vertical: ${payment.vertical} | ${minutesOld} min old`);

    // ── 1. Mark WegoPayment as EXPIRED ────────────────────────────────────────
    await payment.update({
        status:         'EXPIRED',
        failure_reason: `No payment confirmation received within ${EXPIRY_MINUTES} minutes.`,
        resolved_at:    new Date(),
    });

    // ── 2. Reset vertical state so the customer can retry ─────────────────────
    await _resetVerticalState(payment.vertical, payment.vertical_id);
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE — reset vertical state per vertical type
// ─────────────────────────────────────────────────────────────────────────────

async function _resetVerticalState(vertical, verticalId) {
    if (!vertical || !verticalId) return; // disbursements (vertical=null) — nothing to reset

    switch (vertical) {

        case 'delivery':
            // Reset payment_status to 'pending' so the sender can initiate again.
            // Only reset if still 'pending' — don't overwrite 'paid' or 'cash_pending'.
            await Delivery.update(
                { payment_status: 'pending' },
                {
                    where: {
                        id:             parseInt(verticalId),
                        payment_status: 'pending', // only touch if still pending
                    },
                }
            );
            console.log(`  ↩️  [EXPIRY][DELIVERY] Delivery ${verticalId} payment_status reset to pending`);
            break;

        case 'rental':
            // VehicleRental stays in 'PENDING' — no change needed.
            console.log(`  ↩️  [EXPIRY][RENTAL] Rental ${verticalId} stays PENDING — customer can retry`);
            break;

        default:
            console.log(`  ℹ️  [EXPIRY] Unknown vertical "${vertical}" — no state reset applied`);
            break;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// RECONCILIATION — poll CamPay for still-PENDING payments and finalize
//
// Resolution normally happens via the webhook (if CamPay can reach us) or the
// app polling GET /payments/:ref/status. Neither is guaranteed: the webhook
// needs a public HTTPS URL, and the app may be backgrounded/closed. Without a
// server-side poll, a payment the customer actually completed would be force-
// EXPIRED after the window (money in, service not delivered). This closes that
// hole: every minute we ask CamPay for the authoritative status of each pending
// payment and run the SAME finalizers the webhook uses.
// ─────────────────────────────────────────────────────────────────────────────

async function runReconciliation() {
    const pending = await WegoPayment.findAll({
        where:      { status: 'PENDING', campay_ref: { [Op.ne]: null } },
        attributes: ['id', 'vertical', 'vertical_id', 'campay_ref', 'amount', 'operator', 'initiated_by', 'external_ref'],
    });

    if (pending.length === 0) return { checked: 0, resolved: 0 };

    // io may not be ready at process start; the finalizers tolerate a null io
    // (they skip the socket emit — the DB state is still updated).
    let io = null;
    try { io = require('../sockets').getIO(); } catch (_) { /* not initialised yet */ }

    const webhookCtrl = require('../controllers/payment/campayWebhook.controller');
    let resolved = 0;

    for (const p of pending) {
        try {
            const s = await campayService.checkStatus(p.campay_ref);
            if (!s || s.status === 'PENDING') continue;

            let newStatus = s.status === 'SUCCESSFUL' ? 'SUCCESSFUL' : 'FAILED';

            // Never credit on an amount mismatch — treat as FAILED.
            if (newStatus === 'SUCCESSFUL') {
                const paid = Math.round(Number(s.amount));
                if (!Number.isFinite(paid) || paid !== p.amount) {
                    console.error(`🚨 [RECONCILE] amount mismatch ${p.external_ref}: expected ${p.amount}, CamPay ${s.amount} — failing.`);
                    newStatus = 'FAILED';
                }
            }

            // Atomic transition — only one of {webhook, app-poll, reconcile} wins.
            const [affected] = await WegoPayment.update(
                {
                    status:      newStatus,
                    operator:    s.operator || p.operator,
                    resolved_at: new Date(),
                    ...(newStatus === 'FAILED' && { failure_reason: 'Resolved via reconciliation poll' }),
                },
                { where: { id: p.id, status: 'PENDING' } }
            );
            if (affected === 0) continue; // already resolved concurrently

            await p.reload();
            if (newStatus === 'SUCCESSFUL') {
                await webhookCtrl._finalizeFromPoll(p, { operator: s.operator || p.operator }, io);
            } else {
                await webhookCtrl._finalizeFailedFromPoll(p, { reason: 'Payment failed or cancelled.' }, io);
            }
            resolved++;
            console.log(`🔁 [RECONCILE] ${p.external_ref} (${p.vertical}) → ${newStatus}`);
        } catch (err) {
            // CamPay unreachable for this ref — leave PENDING, retry next tick.
            console.warn(`⚠️  [RECONCILE] ${p.external_ref}: ${err.message}`);
        }
    }

    if (resolved > 0) console.log(`✅ [RECONCILE] Resolved ${resolved}/${pending.length} pending payment(s)`);
    return { checked: pending.length, resolved };
}

// ─────────────────────────────────────────────────────────────────────────────
// CRON SCHEDULE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Starts the payment expiry cron job.
 * Runs every minute: '* * * * *'
 *
 * Errors inside a single run are caught and logged — they never crash the job
 * or prevent the next tick from running.
 */
function start() {
    console.log(`⏰ [PAYMENT JOB] Started — reconcile + expiry every minute, expiry threshold: ${EXPIRY_MINUTES} minutes`);

    cron.schedule(CRON_SCHEDULE, async () => {
        // 1. Reconcile: poll CamPay for still-PENDING payments and finalize any
        //    that resolved — payments never hang on a missed webhook / closed app.
        try {
            await runReconciliation();
        } catch (err) {
            console.error('❌ [PAYMENT RECONCILE] Unhandled error in cron run:', err.message);
        }
        // 2. Expire: only payments CamPay still reports as unresolved past the window.
        try {
            await runExpiryCheck();
        } catch (err) {
            console.error('❌ [PAYMENT EXPIRY JOB] Unhandled error in cron run:', err.message);
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
    start,
    runExpiryCheck,     // exported for manual runs and unit testing
    runReconciliation,  // exported for manual runs and unit testing
    EXPIRY_MINUTES,     // exported so tests can reference the constant
};