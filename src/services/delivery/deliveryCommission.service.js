// src/services/delivery/deliveryCommission.service.js
//
// ═══════════════════════════════════════════════════════════════════════════════
// DELIVERY COMMISSION SERVICE
// ═══════════════════════════════════════════════════════════════════════════════
//
// Manages the pre-paid commission lifecycle for delivery agents.
//
// The commission model (pre-paid wallet):
//   Drivers reload their wallet BEFORE working.
//   When they ACCEPT a job, the commission fee is RESERVED (locked).
//   This prevents accepting jobs they cannot afford to service.
//
//   available_balance = balance - reserved_balance - pending_withdrawal
//
// Commission lifecycle:
//   1. reserveCommission(deliveryId, driverId)
//      → called inside acceptDelivery, BEFORE the DB status changes
//      → increments reserved_balance on the wallet
//      → writes a 'commission_reserve' transaction (pending)
//      → fails atomically if insufficient balance
//
//   2a. confirmCommission(deliveryId, driverId)
//       → called when delivery is marked 'delivered'
//       → moves reserved → confirmed deduction
//       → decrements balance + reserved_balance
//       → writes 'commission_deduction' transaction
//
//   2b. releaseCommission(deliveryId, driverId)
//       → called when delivery is cancelled by system, sender, or admin
//       → releases the lock: decrements reserved_balance only
//       → writes 'commission_release' transaction (driver keeps money)
//
//   2c. penaliseCommission(deliveryId, driverId)
//       → called when driver cancels an accepted delivery
//       → deducts from balance (driver loses the commission — penalty)
//       → decrements reserved_balance
//       → writes 'commission_deduction' + 'commission_penalty' note
//
// Minimum float:
//   COMMISSION_MINIMUM_FLOAT_XAF (env, default 0) — additional buffer
//   above the commission that must remain available. Useful if you want
//   drivers to always keep a reserve beyond the immediate job fee.
//
// All mutations use row-level SELECT FOR UPDATE locks (ACID).
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const { Op } = require('sequelize');
const {
    DeliveryWallet,
    DeliveryWalletTransaction,
    Delivery,
    sequelize,
} = require('../../models');

// Terminal commission ledger markers. The presence of either for a delivery
// means the commission lifecycle already finalized — used as the idempotency
// key by confirm/release and by the reconciliation sweep.
const TERMINAL_TXN_TYPES = ['commission_deduction', 'commission_release'];

// ─── Configuration ────────────────────────────────────────────────────────────

// Extra buffer the driver must have above the commission amount.
// Default 0 — change via env to require e.g. 500 XAF float at all times.
const MINIMUM_FLOAT_XAF = parseInt(process.env.COMMISSION_MINIMUM_FLOAT_XAF || 0, 10);

// ─── Internal helper ──────────────────────────────────────────────────────────

/**
 * Load and lock the wallet row in a transaction.
 * Throws structured errors if wallet is missing or inactive.
 *
 * @param {string} driverId
 * @param {import('sequelize').Transaction} transaction
 * @param {object} [opts]
 * @param {boolean} [opts.allowInactive] - skip the active-status gate. Finalization
 *   ops (confirm/release/penalise) pass this: the commission was reserved while the
 *   wallet was active, so freezing/suspending it afterwards must NOT block completing
 *   the lifecycle — otherwise the reserved_balance is orphaned forever. Only
 *   reserveCommission keeps the gate (don't let an inactive wallet take new jobs).
 * @param {boolean} [opts.allowMissing] - return null instead of throwing when the
 *   wallet row does not exist. Finalization uses this: wallets are never deleted, so
 *   a missing wallet means nothing was ever reserved (reserve blocks accept otherwise)
 *   → the caller treats it as a no-op rather than a hard 402.
 */
async function _lockWallet(driverId, transaction, opts = {}) {
    const wallet = await DeliveryWallet.findOne({
        where: { driver_id: driverId },
        lock:  transaction.LOCK.UPDATE,
        transaction,
    });

    if (!wallet) {
        if (opts.allowMissing) return null;
        const err = new Error('Wallet not found. Please top up your wallet to continue.');
        err.statusCode = 402;
        throw err;
    }

    if (wallet.status !== 'active' && !opts.allowInactive) {
        const err = new Error(
            wallet.status === 'frozen'
                ? 'Your wallet is frozen. Contact WeGo support to continue accepting deliveries.'
                : 'Your wallet has been suspended. Contact WeGo support.'
        );
        err.statusCode = 403;
        throw err;
    }

    return wallet;
}

/**
 * Has this delivery's commission already reached a terminal ledger state
 * (confirmed as a deduction, or released)? Used as the idempotency guard so
 * confirm/release and the reconciliation sweep never double-apply.
 *
 * MUST be called AFTER the wallet row is locked FOR UPDATE — that serialises a
 * racing finalization behind us, and (because a locking read does not open the
 * REPEATABLE READ snapshot) the first consistent read that follows the lock sees
 * the racing txn's committed ledger row.
 */
async function _findTerminalTxn(deliveryId, transaction) {
    return DeliveryWalletTransaction.findOne({
        where:      { delivery_id: deliveryId, type: { [Op.in]: TERMINAL_TXN_TYPES } },
        attributes: ['id', 'type'],
        transaction,
    });
}

/**
 * Load the Delivery record inside a transaction.
 */
async function _loadDelivery(deliveryId, transaction) {
    const delivery = await Delivery.findByPk(deliveryId, { transaction });
    if (!delivery) {
        const err = new Error(`Delivery #${deliveryId} not found`);
        err.statusCode = 404;
        throw err;
    }
    return delivery;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. RESERVE COMMISSION  —  called on acceptDelivery
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Lock the commission fee in the driver's wallet.
 * Must be called BEFORE the delivery status transitions to 'accepted'.
 *
 * If the driver cannot afford it, throws a 402 — the controller aborts
 * the accept and the delivery stays in 'searching' for other drivers.
 *
 * @param {number} deliveryId
 * @param {string} driverId   - Driver.id (VARCHAR 36)
 * @param {object} [opts]
 * @param {import('sequelize').Transaction} [opts.transaction] - join an existing txn
 * @returns {Promise<{wallet: DeliveryWallet, reservedAmount: number}>}
 */
async function reserveCommission(deliveryId, driverId, opts = {}) {
    const t        = opts.transaction || await sequelize.transaction();
    const ownTxn   = !opts.transaction;

    try {
        const delivery = await _loadDelivery(deliveryId, t);
        const commission = parseFloat(delivery.commission_amount || 0);

        if (commission <= 0) {
            // No commission configured — nothing to reserve, allow accept
            if (ownTxn) await t.commit();
            return { wallet: null, reservedAmount: 0 };
        }

        const wallet   = await _lockWallet(driverId, t);
        const required = commission + MINIMUM_FLOAT_XAF;

        const available = parseFloat(wallet.balance)
            - parseFloat(wallet.reserved_balance)
            - parseFloat(wallet.pending_withdrawal);

        if (available < required) {
            if (ownTxn) await t.rollback();
            const shortfall = required - available;
            const err = new Error(
                `Insufficient wallet balance. ` +
                `You need ${required.toLocaleString()} XAF available ` +
                `(commission: ${commission.toLocaleString()} XAF` +
                (MINIMUM_FLOAT_XAF > 0 ? ` + ${MINIMUM_FLOAT_XAF.toLocaleString()} XAF minimum float` : '') +
                `). ` +
                `Please top up ${shortfall.toLocaleString()} XAF to accept this delivery.`
            );
            err.statusCode  = 402;
            err.code        = 'INSUFFICIENT_WALLET_BALANCE';
            err.shortfall   = shortfall;
            err.required    = required;
            err.available   = available;
            throw err;
        }

        // Lock the amount
        await wallet.increment({ reserved_balance: commission }, { transaction: t });

        // Write pending reserve transaction for audit trail
        await DeliveryWalletTransaction.create({
            wallet_id:      wallet.id,
            delivery_id:    deliveryId,
            type:           'commission_reserve',
            payment_method: delivery.payment_method,
            amount:         commission,
            balance_before: parseFloat(wallet.balance),
            balance_after:  parseFloat(wallet.balance), // balance unchanged — only reserve moves
            notes:          `Commission reserved for delivery ${delivery.delivery_code}`,
        }, { transaction: t });

        if (ownTxn) await t.commit();

        console.log(
            `🔒 [COMMISSION] Reserved ${commission.toLocaleString()} XAF ` +
            `for delivery ${delivery.delivery_code} — driver ${driverId}`
        );

        return { wallet, reservedAmount: commission };

    } catch (error) {
        if (ownTxn) { try { await t.rollback(); } catch (_) {} }
        throw error;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2a. CONFIRM COMMISSION  —  called on delivery 'delivered'
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Finalize the commission deduction when the delivery completes.
 * Moves the reserved amount from the wallet permanently.
 *
 * @param {number} deliveryId
 * @param {string} driverId
 * @param {object} [opts]
 * @param {import('sequelize').Transaction} [opts.transaction]
 */
async function confirmCommission(deliveryId, driverId, opts = {}) {
    const t      = opts.transaction || await sequelize.transaction();
    const ownTxn = !opts.transaction;

    try {
        // Lock the wallet FIRST so the transaction's read snapshot is established
        // AFTER we hold the row lock — this is what makes the idempotency check
        // below correct against a concurrent confirm (the reconcile sweep can race
        // the PIN-verify handler, which does not share its Redis pin_lock).
        // allowInactive: finalizing an already-reserved commission must succeed even
        // if the wallet was frozen/suspended after accept. allowMissing: no wallet
        // ⇒ nothing was ever reserved ⇒ no-op.
        const wallet = await _lockWallet(driverId, t, { allowInactive: true, allowMissing: true });
        if (!wallet) {
            if (ownTxn) await t.commit();
            return { deductedAmount: 0, noWallet: true };
        }

        const delivery   = await _loadDelivery(deliveryId, t);
        const commission = parseFloat(delivery.commission_amount || 0);

        if (commission <= 0) {
            if (ownTxn) await t.commit();
            return { deductedAmount: 0 };
        }

        // Idempotency: if the commission already reached a terminal ledger state
        // (confirmed on a prior attempt, or released by a cancel), do nothing.
        // Safe under concurrency because we already hold the wallet row lock.
        const terminal = await _findTerminalTxn(deliveryId, t);
        if (terminal) {
            if (ownTxn) await t.commit();
            return { deductedAmount: 0, alreadyFinalized: true, finalizedAs: terminal.type };
        }

        const balanceBefore = parseFloat(wallet.balance);
        const balanceAfter  = Math.max(0, balanceBefore - commission);

        // Deduct from both balance and reserved_balance atomically
        await wallet.update({
            balance:          balanceAfter,
            reserved_balance: Math.max(0, parseFloat(wallet.reserved_balance) - commission),
            total_commission_paid: parseFloat(wallet.total_commission_paid) + commission,
        }, { transaction: t });

        await DeliveryWalletTransaction.create({
            wallet_id:      wallet.id,
            delivery_id:    deliveryId,
            type:           'commission_deduction',
            payment_method: delivery.payment_method,
            amount:         commission,
            balance_before: balanceBefore,
            balance_after:  balanceAfter,
            notes:          `Commission deducted for completed delivery ${delivery.delivery_code}`,
        }, { transaction: t });

        if (ownTxn) await t.commit();

        console.log(
            `✅ [COMMISSION] Confirmed ${commission.toLocaleString()} XAF deduction ` +
            `for delivery ${delivery.delivery_code}`
        );

        return { deductedAmount: commission, balanceBefore, balanceAfter };

    } catch (error) {
        if (ownTxn) { try { await t.rollback(); } catch (_) {} }
        throw error;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2b. RELEASE COMMISSION  —  called on system/sender/admin cancellation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Release the locked commission when the delivery is cancelled through
 * no fault of the driver (system timeout, sender cancel, admin cancel).
 * The driver's balance is untouched — only the lock is removed.
 *
 * @param {number} deliveryId
 * @param {string} driverId
 * @param {object} [opts]
 * @param {import('sequelize').Transaction} [opts.transaction]
 */
async function releaseCommission(deliveryId, driverId, opts = {}) {
    const t      = opts.transaction || await sequelize.transaction();
    const ownTxn = !opts.transaction;

    try {
        // Lock-first (see confirmCommission) so the idempotency check is race-safe.
        // allowInactive: a cancel must release the lock even if the wallet was frozen
        // after accept — otherwise the reserved_balance is orphaned exactly like the
        // confirm path. allowMissing: no wallet ⇒ nothing reserved ⇒ no-op.
        const wallet = await _lockWallet(driverId, t, { allowInactive: true, allowMissing: true });
        if (!wallet) {
            if (ownTxn) await t.commit();
            return { releasedAmount: 0, noWallet: true };
        }

        const delivery   = await _loadDelivery(deliveryId, t);
        const commission = parseFloat(delivery.commission_amount || 0);

        if (commission <= 0) {
            if (ownTxn) await t.commit();
            return { releasedAmount: 0 };
        }

        // Idempotency: never release twice (would wrongly free reserve still held by
        // other deliveries) and never release something already deducted.
        const terminal = await _findTerminalTxn(deliveryId, t);
        if (terminal) {
            if (ownTxn) await t.commit();
            return { releasedAmount: 0, alreadyFinalized: true, finalizedAs: terminal.type };
        }

        const balanceBefore = parseFloat(wallet.balance);

        // Release the reserved lock — balance stays the same
        await wallet.update({
            reserved_balance: Math.max(0, parseFloat(wallet.reserved_balance) - commission),
        }, { transaction: t });

        await DeliveryWalletTransaction.create({
            wallet_id:      wallet.id,
            delivery_id:    deliveryId,
            type:           'commission_release',
            payment_method: delivery.payment_method,
            amount:         commission,
            balance_before: balanceBefore,
            balance_after:  balanceBefore, // balance unchanged
            notes:          `Commission released — delivery ${delivery.delivery_code} cancelled (not driver fault)`,
        }, { transaction: t });

        if (ownTxn) await t.commit();

        console.log(
            `🔓 [COMMISSION] Released ${commission.toLocaleString()} XAF ` +
            `for cancelled delivery ${delivery.delivery_code}`
        );

        return { releasedAmount: commission };

    } catch (error) {
        if (ownTxn) { try { await t.rollback(); } catch (_) {} }
        throw error;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2c. PENALISE COMMISSION  —  called when driver cancels an accepted delivery
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Penalise the driver when THEY cancel an already-accepted delivery.
 * The reserved commission is deducted from their balance (they lose it).
 * This is the same financial outcome as confirming, but logged differently.
 *
 * @param {number} deliveryId
 * @param {string} driverId
 * @param {object} [opts]
 * @param {import('sequelize').Transaction} [opts.transaction]
 */
async function penaliseCommission(deliveryId, driverId, opts = {}) {
    const t      = opts.transaction || await sequelize.transaction();
    const ownTxn = !opts.transaction;

    try {
        const delivery   = await _loadDelivery(deliveryId, t);
        const commission = parseFloat(delivery.commission_amount || 0);

        if (commission <= 0) {
            if (ownTxn) await t.commit();
            return { penalisedAmount: 0 };
        }

        // allowInactive: a driver-cancel penalty on an already-reserved commission
        // must still apply even if the wallet was frozen/suspended after accept.
        const wallet        = await _lockWallet(driverId, t, { allowInactive: true });
        const balanceBefore = parseFloat(wallet.balance);
        const balanceAfter  = Math.max(0, balanceBefore - commission);

        await wallet.update({
            balance:          balanceAfter,
            reserved_balance: Math.max(0, parseFloat(wallet.reserved_balance) - commission),
            total_commission_paid: parseFloat(wallet.total_commission_paid) + commission,
        }, { transaction: t });

        await DeliveryWalletTransaction.create({
            wallet_id:      wallet.id,
            delivery_id:    deliveryId,
            type:           'commission_deduction',
            payment_method: delivery.payment_method,
            amount:         commission,
            balance_before: balanceBefore,
            balance_after:  balanceAfter,
            notes:          `Commission penalty — driver cancelled delivery ${delivery.delivery_code}`,
        }, { transaction: t });

        if (ownTxn) await t.commit();

        console.log(
            `⚠️  [COMMISSION] Penalty ${commission.toLocaleString()} XAF ` +
            `applied — driver cancelled ${delivery.delivery_code}`
        );

        return { penalisedAmount: commission, balanceBefore, balanceAfter };

    } catch (error) {
        if (ownTxn) { try { await t.rollback(); } catch (_) {} }
        throw error;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
    reserveCommission,
    confirmCommission,
    releaseCommission,
    penaliseCommission,
};