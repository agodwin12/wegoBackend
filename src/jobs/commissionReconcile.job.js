// src/jobs/commissionReconcile.job.js
//
// ═══════════════════════════════════════════════════════════════════════════════
// DELIVERY COMMISSION RECONCILIATION SWEEP
// ═══════════════════════════════════════════════════════════════════════════════
//
// Safety net for the pre-paid commission lifecycle.
//
// When a delivery is PIN-verified, the controller marks it 'delivered' and then
// calls deliveryCommissionService.confirmCommission() FIRE-AND-FORGET (it must
// not block the agent's handoff on a wallet-lock/DB blip). If that confirm never
// lands — a transient deadlock, a lost DB connection, or the process crashing
// between the transition and the confirm — the agent's reserved_balance stays
// locked forever: releaseCommission only runs on cancel, and a delivered
// delivery is terminal, so nothing else ever finalizes the reservation. The
// platform loses the commission AND the agent's available balance is permanently
// reduced.
//
// This sweep closes that hole. Every few minutes it finds deliveries that are
// 'delivered' with a commission but NO terminal commission ledger row
// (deduction/release), and calls confirmCommission — which is idempotent, so a
// confirm racing the handler's confirm is a safe no-op. confirmCommission also
// finalizes regardless of wallet freeze/suspend, so a wallet an admin froze
// between accept and delivery no longer traps the reservation.
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const cron  = require('node-cron');
const { Op } = require('sequelize');
const { Delivery, DeliveryWalletTransaction } = require('../models');
const deliveryCommissionService = require('../services/delivery/deliveryCommission.service');

// ── Configuration ─────────────────────────────────────────────────────────────

const CRON_SCHEDULE  = '*/5 * * * *'; // every 5 minutes
// Only look back over recently-delivered deliveries so the scan stays cheap. The
// window is generous: the sweep runs every 5 min, so each orphan gets hundreds of
// chances before ageing out. A one-off historical backfill can call
// runReconciliation({ lookbackHours: <big> }) manually.
const LOOKBACK_HOURS = parseInt(process.env.COMMISSION_RECONCILE_LOOKBACK_HOURS || 168, 10); // 7 days
const BATCH_LIMIT    = parseInt(process.env.COMMISSION_RECONCILE_BATCH || 500, 10);
const TERMINAL_TYPES = ['commission_deduction', 'commission_release'];

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find delivered deliveries whose commission is still reserved (no terminal
 * ledger row) and confirm them idempotently.
 *
 * @param {object} [opts]
 * @param {number} [opts.lookbackHours] - override the default scan window.
 * @returns {Promise<{ checked: number, confirmed: number, errors: number }>}
 */
async function runReconciliation(opts = {}) {
    const lookbackHours = opts.lookbackHours || LOOKBACK_HOURS;
    const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

    // 1. Delivered deliveries that carried a commission, within the window.
    const delivered = await Delivery.findAll({
        where: {
            status:            'delivered',
            driver_id:         { [Op.ne]: null },
            commission_amount: { [Op.gt]: 0 },
            delivered_at:      { [Op.gte]: since },
        },
        attributes: ['id', 'driver_id', 'delivery_code', 'commission_amount'],
        order:      [['delivered_at', 'ASC']],
        limit:      BATCH_LIMIT,
    });

    if (delivered.length === 0) return { checked: 0, confirmed: 0, errors: 0 };

    // 2. One query: which of these already have a TERMINAL commission txn?
    const ids = delivered.map(d => d.id);
    const terminalRows = await DeliveryWalletTransaction.findAll({
        where:      { delivery_id: { [Op.in]: ids }, type: { [Op.in]: TERMINAL_TYPES } },
        attributes: ['delivery_id'],
    });
    const finalized = new Set(terminalRows.map(r => r.delivery_id));

    // 3. Orphans = delivered w/ commission but no terminal txn.
    const orphans = delivered.filter(d => !finalized.has(d.id));
    if (orphans.length === 0) return { checked: delivered.length, confirmed: 0, errors: 0 };

    console.log(
        `\n💸 [COMMISSION RECONCILE] ${orphans.length} delivered delivery(ies) with an ` +
        `orphaned commission reservation — confirming`
    );

    let confirmed = 0;
    let errors    = 0;

    for (const d of orphans) {
        try {
            const r = await deliveryCommissionService.confirmCommission(d.id, d.driver_id);
            // confirmCommission is idempotent; deductedAmount > 0 means WE finalized it
            // (as opposed to a concurrent confirm that already had).
            if (r && r.deductedAmount > 0) {
                confirmed++;
                console.log(
                    `  ✅ [RECONCILE] delivery ${d.delivery_code} — confirmed ` +
                    `${Number(d.commission_amount).toLocaleString()} XAF`
                );
            } else {
                console.log(
                    `  ℹ️  [RECONCILE] delivery ${d.delivery_code} — already finalized ` +
                    `(${r && r.finalizedAs ? r.finalizedAs : 'no-op'})`
                );
            }
        } catch (err) {
            errors++;
            console.error(`  ❌ [RECONCILE] delivery ${d.delivery_code}: ${err.message}`);
        }
    }

    if (confirmed > 0 || errors > 0) {
        console.log(
            `✅ [COMMISSION RECONCILE] Confirmed ${confirmed} | Errors ${errors} ` +
            `(checked ${delivered.length})\n`
        );
    }

    return { checked: delivered.length, confirmed, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// CRON SCHEDULE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Starts the commission reconciliation cron job (every 5 minutes).
 * Errors inside a single run are caught and logged — they never crash the job
 * or prevent the next tick from running.
 */
function start() {
    console.log(
        `⏰ [COMMISSION RECONCILE] Started — orphaned-reservation sweep every 5 min ` +
        `(lookback ${LOOKBACK_HOURS}h)`
    );

    cron.schedule(CRON_SCHEDULE, async () => {
        try {
            await runReconciliation();
        } catch (err) {
            console.error('❌ [COMMISSION RECONCILE] Unhandled error in cron run:', err.message);
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
    start,
    runReconciliation, // exported for manual backfill runs and testing
};
