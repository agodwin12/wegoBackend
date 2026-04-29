// src/services/delivery/walletTopUp.service.js
//
// ═══════════════════════════════════════════════════════════════════════════════
// WALLET TOP-UP SERVICE
// ═══════════════════════════════════════════════════════════════════════════════
//
// All business logic for the driver wallet pre-paid top-up system.
// Controllers call these functions — no DB logic lives in controllers.
//
// Public API:
//   submitTopUp(driverId, payload)           → driver submits a reload request
//   getDriverTopUps(driverId, opts)          → driver views their history
//   getTopUpById(topUpId, driverId?)         → single request detail
//
//   getPendingQueue(opts)                    → backoffice: list pending items
//   markUnderReview(topUpId, employeeId)     → employee claims it
//   confirmTopUp(topUpId, employeeId, note)  → employee verifies payment
//   creditWallet(topUpId, employeeId)        → actually credit the balance
//   rejectTopUp(topUpId, employeeId, reason) → employee rejects
//
//   getOrCreateWallet(driverId)              → internal — ensures wallet exists
//
// All wallet mutations use Sequelize ACID transactions.
// All top-up codes are idempotent — duplicate submissions return existing record.
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const { Op }    = require('sequelize');
const { nanoid } = require('nanoid');

const {
    DeliveryWalletTopUp,
    DeliveryWallet,
    DeliveryWalletTransaction,
    Driver,
    Account,
    Employee,
    sequelize,
} = require('../../models');

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_TOPUP_AMOUNT  = 500;      // XAF
const MAX_TOPUP_AMOUNT  = 500_000;  // XAF
const VALID_CHANNELS    = ['cash', 'mtn_mobile_money', 'orange_money'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generate a unique, human-readable top-up code.
 * Format: TU-YYYYMMDD-XXXXXX   e.g. TU-20250407-A3F9K2
 */
function generateTopUpCode() {
    const now  = new Date();
    const date = now.toISOString().slice(0, 10).replace(/-/g, '');
    const rand = nanoid(6).toUpperCase().replace(/[^A-Z0-9]/g, '0').slice(0, 6);
    return `TU-${date}-${rand}`;
}

/**
 * Resolve a Driver record from a driver UUID (Driver.id).
 * Throws a structured error if not found.
 */
async function resolveDriver(driverId, transaction) {
    const driver = await Driver.findByPk(driverId, {
        attributes: ['id', 'userId', 'status', 'current_mode'],
        transaction,
    });
    if (!driver) {
        const err = new Error('Driver record not found');
        err.statusCode = 404;
        throw err;
    }
    return driver;
}

// ═══════════════════════════════════════════════════════════════════════════════
// WALLET BOOTSTRAP
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get or create a DeliveryWallet for a driver.
 * Called internally by submitTopUp and by the delivery matching service.
 *
 * @param {string} driverId - Driver.id (VARCHAR 36)
 * @param {object} [options]
 * @param {import('sequelize').Transaction} [options.transaction]
 * @returns {Promise<DeliveryWallet>}
 */
async function getOrCreateWallet(driverId, options = {}) {
    const [wallet] = await DeliveryWallet.findOrCreate({
        where:    { driver_id: driverId },
        defaults: {
            driver_id:             driverId,
            balance:               0.00,
            reserved_balance:      0.00,
            total_topped_up:       0.00,
            total_earned:          0.00,
            total_cash_collected:  0.00,
            total_commission_paid: 0.00,
            total_commission_owed: 0.00,
            total_withdrawn:       0.00,
            pending_withdrawal:    0.00,
            status:                'active',
        },
        transaction: options.transaction,
    });
    return wallet;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DRIVER-FACING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Driver submits a wallet top-up request.
 *
 * @param {string} driverId  - Driver.id
 * @param {object} payload
 * @param {number}  payload.amount           - XAF amount to top up
 * @param {string}  payload.payment_channel  - 'cash'|'mtn_mobile_money'|'orange_money'
 * @param {string}  [payload.proof_url]      - R2 URL of payment screenshot
 * @param {string}  [payload.payment_reference] - Telco reference number
 * @param {string}  [payload.sender_phone]   - Phone used for transfer
 * @param {string}  [payload.driver_note]    - Optional message
 * @returns {Promise<DeliveryWalletTopUp>}
 */
async function submitTopUp(driverId, payload) {
    const {
        amount,
        payment_channel,
        proof_url        = null,
        payment_reference = null,
        sender_phone     = null,
        driver_note      = null,
    } = payload;

    // ── Validation ────────────────────────────────────────────────────────────

    const parsedAmount = parseFloat(amount);

    if (!parsedAmount || isNaN(parsedAmount)) {
        const err = new Error('amount is required and must be a number');
        err.statusCode = 400;
        throw err;
    }
    if (parsedAmount < MIN_TOPUP_AMOUNT) {
        const err = new Error(`Minimum top-up amount is ${MIN_TOPUP_AMOUNT.toLocaleString()} XAF`);
        err.statusCode = 400;
        throw err;
    }
    if (parsedAmount > MAX_TOPUP_AMOUNT) {
        const err = new Error(`Maximum single top-up is ${MAX_TOPUP_AMOUNT.toLocaleString()} XAF`);
        err.statusCode = 400;
        throw err;
    }
    if (!VALID_CHANNELS.includes(payment_channel)) {
        const err = new Error(`payment_channel must be one of: ${VALID_CHANNELS.join(', ')}`);
        err.statusCode = 400;
        throw err;
    }

    // MTN and Orange require a proof screenshot
    if (['mtn_mobile_money', 'orange_money'].includes(payment_channel) && !proof_url) {
        const err = new Error('proof_url (payment screenshot) is required for MTN MoMo and Orange Money');
        err.statusCode = 400;
        throw err;
    }

    // ── Resolve driver & wallet inside a transaction ──────────────────────────

    const t = await sequelize.transaction();

    try {
        await resolveDriver(driverId, t);

        // Ensure wallet exists before creating the top-up request
        const wallet = await getOrCreateWallet(driverId, { transaction: t });

        if (wallet.status === 'suspended') {
            const err = new Error('Your wallet has been suspended. Please contact WeGo support.');
            err.statusCode = 403;
            throw err;
        }
        if (wallet.status === 'frozen') {
            const err = new Error('Your wallet is temporarily frozen. Please contact WeGo support.');
            err.statusCode = 403;
            throw err;
        }

        // Check for a duplicate pending request (same driver + same amount + same channel
        // submitted within the last 10 minutes). Returns existing instead of creating again.
        const recentCutoff = new Date(Date.now() - 10 * 60 * 1000);
        const duplicate = await DeliveryWalletTopUp.findOne({
            where: {
                driver_id:       driverId,
                amount:          parsedAmount,
                payment_channel,
                status:          { [Op.in]: ['pending', 'under_review'] },
                created_at:      { [Op.gte]: recentCutoff },
            },
            transaction: t,
        });

        if (duplicate) {
            await t.rollback();
            console.log(`ℹ️  [TOP-UP] Duplicate submission detected — returning existing ${duplicate.topup_code}`);
            return duplicate;
        }

        // ── Create the top-up request ─────────────────────────────────────────
        const topUp = await DeliveryWalletTopUp.create({
            topup_code:        generateTopUpCode(),
            driver_id:         driverId,
            wallet_id:         wallet.id,
            payment_channel,
            amount:            parsedAmount,
            proof_url,
            payment_reference,
            sender_phone,
            driver_note,
            status:            'pending',
        }, { transaction: t });

        await t.commit();

        console.log(`✅ [TOP-UP] ${topUp.topup_code} submitted — ${parsedAmount} XAF via ${payment_channel}`);
        return topUp;

    } catch (error) {
        await t.rollback();
        throw error;
    }
}

/**
 * List a driver's own top-up history with pagination.
 *
 * @param {string} driverId
 * @param {object} opts
 * @param {number}  [opts.page=1]
 * @param {number}  [opts.limit=20]
 * @param {string}  [opts.status]   - filter by status
 * @returns {Promise<{rows: DeliveryWalletTopUp[], count: number}>}
 */
async function getDriverTopUps(driverId, opts = {}) {
    const page  = Math.max(1, parseInt(opts.page)  || 1);
    const limit = Math.min(50, parseInt(opts.limit) || 20);

    const where = { driver_id: driverId };
    if (opts.status) where.status = opts.status;

    const { rows, count } = await DeliveryWalletTopUp.findAndCountAll({
        where,
        order:  [['created_at', 'DESC']],
        limit,
        offset: (page - 1) * limit,
        attributes: [
            'id', 'topup_code', 'payment_channel', 'amount',
            'proof_url', 'payment_reference', 'sender_phone',
            'driver_note', 'status', 'rejection_reason',
            'balance_before_credit', 'balance_after_credit',
            'created_at', 'confirmed_at', 'credited_at', 'rejected_at',
        ],
    });

    return { rows, count, page, limit };
}

/**
 * Get a single top-up by ID.
 * Pass driverId to scope to a specific driver (prevents other drivers peeking).
 *
 * @param {number}  topUpId
 * @param {string}  [driverId] - if provided, scopes query to this driver only
 */
async function getTopUpById(topUpId, driverId = null) {
    const where = { id: topUpId };
    if (driverId) where.driver_id = driverId;

    const topUp = await DeliveryWalletTopUp.findOne({
        where,
        include: [
            {
                model:      Driver,
                as:         'driver',
                attributes: ['id', 'userId', 'rating'],
            },
        ],
    });

    if (!topUp) {
        const err = new Error('Top-up request not found');
        err.statusCode = 404;
        throw err;
    }

    return topUp;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BACKOFFICE — QUEUE + REVIEW ACTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * List top-up requests for the backoffice queue.
 * Default: returns pending + under_review, sorted oldest-first (FIFO queue).
 *
 * @param {object} opts
 * @param {string|string[]}  [opts.status]   - default ['pending','under_review']
 * @param {string}           [opts.channel]  - filter by payment_channel
 * @param {number}           [opts.page=1]
 * @param {number}           [opts.limit=30]
 * @param {string}           [opts.search]   - search by topup_code or driver name
 */
async function getPendingQueue(opts = {}) {
    const page  = Math.max(1, parseInt(opts.page)  || 1);
    const limit = Math.min(100, parseInt(opts.limit) || 30);

    // Default: show actionable items
    const statusFilter = opts.status
        ? (Array.isArray(opts.status) ? opts.status : [opts.status])
        : ['pending', 'under_review'];

    const where = { status: { [Op.in]: statusFilter } };
    if (opts.channel) where.payment_channel = opts.channel;

    const include = [
        {
            model:      Driver,
            as:         'driver',
            attributes: ['id', 'userId', 'phone', 'rating'],
            include: [
                {
                    model:      Account,
                    foreignKey: 'uuid',
                    // We join on driver.userId = account.uuid
                    // Sequelize will handle this via the Driver→Account relationship
                    as:         'account',
                    attributes: ['first_name', 'last_name', 'phone_e164', 'avatar_url'],
                },
            ],
        },
    ];

    // Backoffice reviewer info
    include.push({
        model:      Employee,
        as:         'reviewedByEmployee',
        attributes: ['id', 'name', 'email'],
        required:   false,
    });

    const { rows, count } = await DeliveryWalletTopUp.findAndCountAll({
        where,
        include,
        // FIFO: oldest pending first so nothing sits forever
        order:  [['created_at', 'ASC']],
        limit,
        offset: (page - 1) * limit,
    });

    // Summary stats for dashboard banner
    const summary = await DeliveryWalletTopUp.findAll({
        where:      { status: { [Op.in]: ['pending', 'under_review'] } },
        attributes: [
            'status',
            [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
            [sequelize.fn('SUM',   sequelize.col('amount')), 'total_amount'],
        ],
        group: ['status'],
        raw:   true,
    });

    return { rows, count, page, limit, summary };
}

/**
 * Employee claims a top-up for review (moves pending → under_review).
 * Prevents two employees working the same item simultaneously.
 *
 * @param {number} topUpId
 * @param {number} employeeId
 */
async function markUnderReview(topUpId, employeeId) {
    const topUp = await DeliveryWalletTopUp.findByPk(topUpId);
    if (!topUp) {
        const err = new Error('Top-up request not found');
        err.statusCode = 404;
        throw err;
    }

    if (topUp.status !== 'pending') {
        const err = new Error(`Cannot review a top-up in status: ${topUp.status}`);
        err.statusCode = 409;
        throw err;
    }

    await topUp.transitionTo('under_review', {
        reviewed_by: employeeId,
        reviewed_at: new Date(),
    });

    console.log(`🔍 [TOP-UP] ${topUp.topup_code} marked under_review by employee #${employeeId}`);
    return topUp;
}

/**
 * Employee confirms the payment is valid — moves under_review → confirmed.
 * This does NOT yet credit the wallet. Call creditWallet() after this.
 *
 * Separating confirm from credit allows a two-step approval flow:
 * e.g. a support agent confirms, a manager does the final credit.
 * In single-role setups, call confirmTopUp() then creditWallet() back-to-back.
 *
 * @param {number} topUpId
 * @param {number} employeeId
 * @param {string} [adminNote]
 */
async function confirmTopUp(topUpId, employeeId, adminNote = null) {
    const topUp = await DeliveryWalletTopUp.findByPk(topUpId);
    if (!topUp) {
        const err = new Error('Top-up request not found');
        err.statusCode = 404;
        throw err;
    }

    if (!['pending', 'under_review'].includes(topUp.status)) {
        const err = new Error(`Cannot confirm a top-up in status: ${topUp.status}`);
        err.statusCode = 409;
        throw err;
    }

    await topUp.transitionTo('confirmed', {
        reviewed_by:  employeeId,
        admin_note:   adminNote,
    });

    console.log(`✅ [TOP-UP] ${topUp.topup_code} confirmed by employee #${employeeId}`);
    return topUp;
}

/**
 * Credits the wallet — moves confirmed → credited.
 * This is the ONLY place wallet balance is incremented for a top-up.
 * Wrapped in a full ACID transaction with before/after balance snapshots.
 *
 * @param {number} topUpId
 * @param {number} employeeId
 */
async function creditWallet(topUpId, employeeId) {
    const t = await sequelize.transaction();

    try {
        // ── Lock the top-up row ───────────────────────────────────────────────
        const topUp = await DeliveryWalletTopUp.findOne({
            where: { id: topUpId },
            lock:  t.LOCK.UPDATE,   // row-level lock — prevents double-credit races
            transaction: t,
        });

        if (!topUp) {
            await t.rollback();
            const err = new Error('Top-up request not found');
            err.statusCode = 404;
            throw err;
        }

        if (topUp.status !== 'confirmed') {
            await t.rollback();
            const err = new Error(`Top-up must be in 'confirmed' status to credit. Current: ${topUp.status}`);
            err.statusCode = 409;
            throw err;
        }

        // ── Lock the wallet row ───────────────────────────────────────────────
        const wallet = await DeliveryWallet.findOne({
            where: { id: topUp.wallet_id },
            lock:  t.LOCK.UPDATE,
            transaction: t,
        });

        if (!wallet) {
            await t.rollback();
            const err = new Error('Wallet not found for this top-up request');
            err.statusCode = 500;
            throw err;
        }

        if (wallet.status !== 'active') {
            await t.rollback();
            const err = new Error(`Cannot credit a wallet with status: ${wallet.status}`);
            err.statusCode = 403;
            throw err;
        }

        const balanceBefore = parseFloat(wallet.balance);
        const creditAmount  = parseFloat(topUp.amount);
        const balanceAfter  = balanceBefore + creditAmount;

        // ── Update wallet balance ─────────────────────────────────────────────
        await wallet.increment(
            { balance: creditAmount, total_topped_up: creditAmount },
            { transaction: t }
        );

        // ── Write immutable transaction ledger entry ──────────────────────────
        await DeliveryWalletTransaction.create({
            wallet_id:              wallet.id,
            delivery_id:            null,
            type:                   'top_up_credit',
            payment_method:         topUp.payment_channel,
            amount:                 creditAmount,
            balance_before:         balanceBefore,
            balance_after:          balanceAfter,
            notes:                  `Wallet top-up ${topUp.topup_code} credited`,
            created_by_employee_id: employeeId,
        }, { transaction: t });

        // ── Snapshot balances on the top-up record itself ─────────────────────
        await topUp.transitionTo('credited', {
            balance_before_credit: balanceBefore,
            balance_after_credit:  balanceAfter,
        });

        await t.commit();

        console.log(
            `💰 [TOP-UP] ${topUp.topup_code} credited — ` +
            `${creditAmount.toLocaleString()} XAF → wallet #${wallet.id} | ` +
            `balance: ${balanceBefore.toLocaleString()} → ${balanceAfter.toLocaleString()}`
        );

        return {
            topUp,
            wallet,
            creditAmount,
            balanceBefore,
            balanceAfter,
        };

    } catch (error) {
        // Only rollback if transaction is still open (transitionTo may have thrown
        // after commit — in that edge case rollback would error too)
        try { await t.rollback(); } catch (_) {}
        throw error;
    }
}

/**
 * Convenience: confirm + credit in one call.
 * Use this when your backoffice role does not need a two-step approval.
 *
 * @param {number} topUpId
 * @param {number} employeeId
 * @param {string} [adminNote]
 */
async function confirmAndCredit(topUpId, employeeId, adminNote = null) {
    await confirmTopUp(topUpId, employeeId, adminNote);
    return creditWallet(topUpId, employeeId);
}

/**
 * Employee rejects a top-up (fake proof, wrong amount, etc.).
 *
 * @param {number} topUpId
 * @param {number} employeeId
 * @param {string} reason     - required — shown to driver
 */
async function rejectTopUp(topUpId, employeeId, reason) {
    if (!reason || !reason.trim()) {
        const err = new Error('A rejection reason is required');
        err.statusCode = 400;
        throw err;
    }

    const topUp = await DeliveryWalletTopUp.findByPk(topUpId);
    if (!topUp) {
        const err = new Error('Top-up request not found');
        err.statusCode = 404;
        throw err;
    }

    if (topUp.isTerminal) {
        const err = new Error(`Cannot reject a top-up that is already ${topUp.status}`);
        err.statusCode = 409;
        throw err;
    }

    await topUp.transitionTo('rejected', {
        reviewed_by:      employeeId,
        rejection_reason: reason.trim(),
    });

    console.log(`❌ [TOP-UP] ${topUp.topup_code} rejected by employee #${employeeId}: ${reason}`);
    return topUp;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
    // Wallet bootstrap (used by matching service too)
    getOrCreateWallet,

    // Driver-facing
    submitTopUp,
    getDriverTopUps,
    getTopUpById,

    // Backoffice
    getPendingQueue,
    markUnderReview,
    confirmTopUp,
    creditWallet,
    confirmAndCredit,
    rejectTopUp,
};