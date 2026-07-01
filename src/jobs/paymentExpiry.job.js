// src/jobs/paymentExpiry.job.js


'use strict';

const cron           = require('node-cron');
const { Op }         = require('sequelize');
const { WegoPayment, Delivery } = require('../models');

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
    console.log(`⏰ [PAYMENT EXPIRY JOB] Started — checking every minute, expiry threshold: ${EXPIRY_MINUTES} minutes`);

    cron.schedule(CRON_SCHEDULE, async () => {
        try {
            await runExpiryCheck();
        } catch (err) {
            // Top-level catch — should never happen since runExpiryCheck handles
            // its own errors, but belt-and-suspenders for unexpected DB failures.
            console.error('❌ [PAYMENT EXPIRY JOB] Unhandled error in cron run:', err.message);
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
    start,
    runExpiryCheck, // exported for manual runs and unit testing
    EXPIRY_MINUTES, // exported so tests can reference the constant
};