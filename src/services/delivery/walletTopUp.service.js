// src/services/delivery/walletTopUp.service.js
//
// ═══════════════════════════════════════════════════════════════════════════════
// WALLET TOP-UP SERVICE
// ═══════════════════════════════════════════════════════════════════════════════
//
// All business logic for the driver wallet pre-paid top-up system.
// Controllers call these functions — no DB logic lives in controllers.
//
// CHANGELOG:
//   v2 — CamPay digital payment path added.
//        Cash channel unchanged (manual screenshot → backoffice review).
//        MTN/Orange channels now go through CamPay automatically:
//          initiateTopUpPayment() → creates topup record (campay_pending)
//                                 → calls campayService.initiateCollection()
//                                 → returns ussdCode to show on Flutter
//        campayWebhook calls creditWalletAutomatically() on SUCCESSFUL.
//        campayWebhook calls failTopUp() on FAILED.
//        creditWallet() remains the ACID single source of truth for balance
//        updates — called by both the backoffice flow and the webhook flow.
//
// Public API — cash (unchanged):
//   submitTopUp(driverId, payload)           → submit manual cash request
//   getDriverTopUps(driverId, opts)          → driver views their history
//   getTopUpById(topUpId, driverId?)         → single request detail
//   getPendingQueue(opts)                    → backoffice: list pending items
//   markUnderReview(topUpId, employeeId)     → employee claims it
//   confirmTopUp(topUpId, employeeId, note)  → employee verifies payment
//   creditWallet(topUpId, employeeId?)       → credit the balance (manual)
//   confirmAndCredit(topUpId, employeeId)    → one-shot approve + credit
//   rejectTopUp(topUpId, employeeId, reason) → employee rejects
//   getOrCreateWallet(driverId)              → ensures wallet exists
//
// Public API — CamPay digital (new):
//   initiateTopUpPayment(driverId, payload)  → start MTN/Orange CamPay flow
//   creditWalletAutomatically(topUpId)       → webhook: CamPay SUCCESSFUL
//   failTopUp(topUpId, reason)               → webhook: CamPay FAILED
//   getTopUpByCampayRef(campayRef)           → webhook: resolve topup by ref
//
// All wallet mutations use Sequelize ACID transactions with SELECT FOR UPDATE.
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const { Op }     = require('sequelize');
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

// campayService is required lazily inside initiateTopUpPayment to avoid
// circular dependency: campayService → models → (nothing that touches this file)
// but keeping require() at module level is fine here since models load first.
const campayService = require('../campay/campayService');

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_TOPUP_AMOUNT = 500;      // XAF
const MAX_TOPUP_AMOUNT = 500_000;  // XAF

// Channels that go through the manual backoffice review flow
const MANUAL_CHANNELS  = ['cash'];

// Channels that go through CamPay automatically
const CAMPAY_CHANNELS  = ['mtn_mobile_money', 'orange_money'];

const VALID_CHANNELS   = [...MANUAL_CHANNELS, ...CAMPAY_CHANNELS];

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
 * Resolve a Driver record from Driver.id (integer PK).
 * Throws a structured 404 if not found.
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

/**
 * Common input validation for all top-up submissions.
 * Returns parsedAmount on success, throws structured error on failure.
 */
function validateTopUpPayload(amount, payment_channel) {
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

    return parsedAmount;
}

// ═══════════════════════════════════════════════════════════════════════════════
// WALLET BOOTSTRAP
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get or create a DeliveryWallet for a driver.
 * Called internally before every top-up submission and by the delivery matching
 * service when a new delivery agent logs in for the first time.
 *
 * @param {string} driverId  Driver.id (VARCHAR 36)
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
// MANUAL (CASH) — unchanged backoffice screenshot flow
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Driver submits a cash top-up request for backoffice review.
 * Only for payment_channel = 'cash'.
 * MTN/Orange must use initiateTopUpPayment() instead.
 *
 * @param {string} driverId  Driver.id
 * @param {object} payload
 * @param {number}  payload.amount            XAF amount
 * @param {string}  payload.payment_channel   must be 'cash'
 * @param {string}  [payload.driver_note]     optional message to reviewer
 * @returns {Promise<DeliveryWalletTopUp>}
 */
async function submitTopUp(driverId, payload) {
    const {
        amount,
        payment_channel,
        driver_note = null,
    } = payload;

    const parsedAmount = validateTopUpPayload(amount, payment_channel);

    if (!MANUAL_CHANNELS.includes(payment_channel)) {
        const err = new Error(
            `submitTopUp() is for cash only. ` +
            `Use initiateTopUpPayment() for ${payment_channel}.`
        );
        err.statusCode = 400;
        throw err;
    }

    const t = await sequelize.transaction();

    try {
        await resolveDriver(driverId, t);
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

        // Idempotency: return existing pending cash request for same amount
        // submitted within the last 10 minutes instead of creating a duplicate.
        const recentCutoff = new Date(Date.now() - 10 * 60 * 1000);
        const duplicate = await DeliveryWalletTopUp.findOne({
            where: {
                driver_id:       driverId,
                amount:          parsedAmount,
                payment_channel: 'cash',
                status:          { [Op.in]: ['pending', 'under_review'] },
                created_at:      { [Op.gte]: recentCutoff },
            },
            transaction: t,
        });

        if (duplicate) {
            await t.rollback();
            console.log(`ℹ️  [TOP-UP] Duplicate cash submission — returning existing ${duplicate.topup_code}`);
            return { topUp: duplicate, isDuplicate: true };
        }

        const topUp = await DeliveryWalletTopUp.create({
            topup_code:      generateTopUpCode(),
            driver_id:       driverId,
            wallet_id:       wallet.id,
            payment_channel: 'cash',
            amount:          parsedAmount,
            driver_note,
            status:          'pending',
        }, { transaction: t });

        await t.commit();

        console.log(`✅ [TOP-UP] ${topUp.topup_code} submitted (cash) — ${parsedAmount} XAF`);
        return { topUp, isDuplicate: false };

    } catch (error) {
        try { await t.rollback(); } catch (_) {}
        throw error;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAMPAY DIGITAL — MTN MoMo / Orange Money
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initiate a CamPay-powered top-up for MTN MoMo or Orange Money.
 *
 * Flow:
 *   1. Validate amount and channel
 *   2. Ensure wallet exists
 *   3. Create DeliveryWalletTopUp record with status 'campay_pending'
 *      (locked in DB BEFORE calling CamPay — full audit trail even on failure)
 *   4. Call campayService.initiateCollection() with vertical='delivery_topup'
 *      and verticalId = topUp.id
 *   5. Store the campay_ref on the topup record for webhook correlation
 *   6. Return ussdCode + campayRef to the controller for Flutter to display
 *
 * The webhook will call creditWalletAutomatically() on SUCCESSFUL
 * or failTopUp() on FAILED.
 *
 * No screenshot needed — CamPay confirms the payment automatically.
 *
 * @param {string} driverId          Driver.id
 * @param {object} payload
 * @param {number}  payload.amount           XAF amount
 * @param {string}  payload.payment_channel  'mtn_mobile_money' | 'orange_money'
 * @param {string}  payload.phone            Phone to charge (driver's MoMo number)
 * @param {string}  payload.account_uuid     Account UUID (for campayService.initiatedBy)
 * @param {string}  [payload.driver_note]    Optional message
 * @returns {Promise<{ topUp, campayRef, ussdCode, paymentId }>}
 */
async function initiateTopUpPayment(driverId, payload) {
    const {
        amount,
        payment_channel,
        phone,
        account_uuid,
        driver_note = null,
    } = payload;

    // ── Validate ──────────────────────────────────────────────────────────────
    const parsedAmount = validateTopUpPayload(amount, payment_channel);

    if (!CAMPAY_CHANNELS.includes(payment_channel)) {
        const err = new Error(
            `initiateTopUpPayment() is for MTN/Orange only. Use submitTopUp() for cash.`
        );
        err.statusCode = 400;
        throw err;
    }
    if (!phone) {
        const err = new Error('phone is required for mobile money top-up');
        err.statusCode = 400;
        throw err;
    }
    if (!account_uuid) {
        const err = new Error('account_uuid is required');
        err.statusCode = 400;
        throw err;
    }

    // ── Step 1: ensure wallet exists and is active ────────────────────────────
    await resolveDriver(driverId);
    const wallet = await getOrCreateWallet(driverId);

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

    // ── Step 2: idempotency check — no duplicate campay_pending for same amount ─
    // Prevents double-charge if driver taps top-up button twice quickly.
    const recentCutoff = new Date(Date.now() - 10 * 60 * 1000);
    const existingPending = await DeliveryWalletTopUp.findOne({
        where: {
            driver_id:       driverId,
            amount:          parsedAmount,
            payment_channel,
            status:          'campay_pending',
            created_at:      { [Op.gte]: recentCutoff },
        },
    });

    if (existingPending && existingPending.campay_ref) {
        console.log(`ℹ️  [TOP-UP] Existing campay_pending found — returning ${existingPending.topup_code}`);
        return {
            topUp:     existingPending,
            campayRef: existingPending.campay_ref,
            ussdCode:  null,   // ussd code is one-time; driver already received it
            paymentId: null,
            isDuplicate: true,
        };
    }

    // ── Step 3: create top-up record BEFORE calling CamPay ───────────────────
    // If CamPay call fails we still have the record to show the driver their
    // attempt failed. campay_ref is null until step 4 succeeds.
    const topUp = await DeliveryWalletTopUp.create({
        topup_code:      generateTopUpCode(),
        driver_id:       driverId,
        wallet_id:       wallet.id,
        payment_channel,
        amount:          parsedAmount,
        driver_note,
        status:          'campay_pending',
    });

    console.log(`📝 [TOP-UP] ${topUp.topup_code} created (campay_pending) — ${parsedAmount} XAF via ${payment_channel}`);

    // ── Step 4: call CamPay ───────────────────────────────────────────────────
    let campayResult;
    try {
        campayResult = await campayService.initiateCollection({
            vertical:    'delivery_topup',
            verticalId:  topUp.id,
            phone,
            initiatedBy: account_uuid,
        });
    } catch (campayErr) {
        // Mark the top-up as failed immediately so the app can react.
        // Do NOT throw here yet — update the record first.
        await topUp.update({
            status:           'campay_failed',
            rejection_reason: campayErr.message,
        });

        console.error(`❌ [TOP-UP] CamPay initiation failed for ${topUp.topup_code}:`, campayErr.message);

        // Re-throw with the topup attached so the controller can return context.
        campayErr.topUp = topUp;
        throw campayErr;
    }

    // ── Step 5: store campay_ref for webhook correlation ──────────────────────
    await topUp.update({ campay_ref: campayResult.campayRef });

    console.log(
        `✅ [TOP-UP] ${topUp.topup_code} CamPay initiated — ` +
        `campay_ref: ${campayResult.campayRef} | ussd: ${campayResult.ussdCode || 'N/A'}`
    );

    return {
        topUp,
        campayRef:   campayResult.campayRef,
        ussdCode:    campayResult.ussdCode  || null,
        paymentId:   campayResult.paymentId || null,
        isDuplicate: false,
    };
}

/**
 * Called by campayWebhook when CamPay confirms a delivery_topup payment.
 * Atomically credits the driver's wallet balance.
 *
 * This is the ONLY path that credits the wallet for CamPay top-ups.
 * It reuses the same creditWallet() ACID logic as the manual flow —
 * the only difference is no employeeId (automated) and the status gate
 * accepts 'campay_pending' instead of 'confirmed'.
 *
 * @param {number} topUpId  DeliveryWalletTopUp.id
 * @returns {Promise<{ topUp, wallet, creditAmount, balanceBefore, balanceAfter }>}
 */
async function creditWalletAutomatically(topUpId) {
    const t = await sequelize.transaction();

    try {
        // ── Lock top-up row ───────────────────────────────────────────────────
        const topUp = await DeliveryWalletTopUp.findOne({
            where: { id: topUpId },
            lock:  t.LOCK.UPDATE,
            transaction: t,
        });

        if (!topUp) {
            await t.rollback();
            const err = new Error(`DeliveryWalletTopUp #${topUpId} not found`);
            err.statusCode = 404;
            throw err;
        }

        // Idempotency: if already credited (webhook fired twice), return safely.
        if (topUp.status === 'credited') {
            await t.rollback();
            console.log(`ℹ️  [TOP-UP] ${topUp.topup_code} already credited — skipping duplicate webhook`);
            const wallet = await DeliveryWallet.findOne({ where: { id: topUp.wallet_id } });
            return {
                topUp,
                wallet,
                creditAmount:  parseFloat(topUp.amount),
                balanceBefore: parseFloat(topUp.balance_before_credit),
                balanceAfter:  parseFloat(topUp.balance_after_credit),
                alreadyCredited: true,
            };
        }

        if (topUp.status !== 'campay_pending') {
            await t.rollback();
            const err = new Error(
                `Cannot auto-credit top-up ${topUp.topup_code} — ` +
                `expected status 'campay_pending', found '${topUp.status}'`
            );
            err.statusCode = 409;
            throw err;
        }

        // ── Lock wallet row ───────────────────────────────────────────────────
        const wallet = await DeliveryWallet.findOne({
            where: { id: topUp.wallet_id },
            lock:  t.LOCK.UPDATE,
            transaction: t,
        });

        if (!wallet) {
            await t.rollback();
            const err = new Error(`Wallet not found for top-up ${topUp.topup_code}`);
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

        // ── Update wallet ─────────────────────────────────────────────────────
        await wallet.increment(
            { balance: creditAmount, total_topped_up: creditAmount },
            { transaction: t }
        );

        // ── Immutable transaction ledger entry ────────────────────────────────
        await DeliveryWalletTransaction.create({
            wallet_id:              wallet.id,
            delivery_id:            null,
            type:                   'top_up_credit',
            payment_method:         topUp.payment_channel,
            amount:                 creditAmount,
            balance_before:         balanceBefore,
            balance_after:          balanceAfter,
            notes:                  `CamPay wallet top-up ${topUp.topup_code} confirmed`,
            created_by_employee_id: null,   // automated — no employee
        }, { transaction: t });

        // ── Update top-up record to credited ─────────────────────────────────
        // We bypass transitionTo() here because that method's allowed map doesn't
        // include campay_pending → credited. We update directly since this is the
        // only code path that takes this transition.
        await topUp.update({
            status:                'credited',
            credited_at:           new Date(),
            balance_before_credit: balanceBefore,
            balance_after_credit:  balanceAfter,
        }, { transaction: t });

        await t.commit();

        console.log(
            `💰 [TOP-UP] ${topUp.topup_code} auto-credited via CamPay — ` +
            `${creditAmount.toLocaleString()} XAF | ` +
            `balance: ${balanceBefore.toLocaleString()} → ${balanceAfter.toLocaleString()}`
        );

        return {
            topUp,
            wallet,
            creditAmount,
            balanceBefore,
            balanceAfter,
            alreadyCredited: false,
        };

    } catch (error) {
        try { await t.rollback(); } catch (_) {}
        throw error;
    }
}

/**
 * Called by campayWebhook when CamPay reports a delivery_topup payment as FAILED.
 * Marks the top-up as campay_failed so the driver can retry.
 *
 * @param {number} topUpId
 * @param {string} reason   Human-readable failure reason from CamPay
 * @returns {Promise<DeliveryWalletTopUp>}
 */
async function failTopUp(topUpId, reason) {
    const topUp = await DeliveryWalletTopUp.findByPk(topUpId);

    if (!topUp) {
        const err = new Error(`DeliveryWalletTopUp #${topUpId} not found`);
        err.statusCode = 404;
        throw err;
    }

    // Idempotency: if already failed, just return
    if (topUp.status === 'campay_failed') {
        console.log(`ℹ️  [TOP-UP] ${topUp.topup_code} already campay_failed — skipping`);
        return topUp;
    }

    if (topUp.status !== 'campay_pending') {
        const err = new Error(
            `Cannot fail top-up ${topUp.topup_code} — ` +
            `expected 'campay_pending', found '${topUp.status}'`
        );
        err.statusCode = 409;
        throw err;
    }

    await topUp.update({
        status:           'campay_failed',
        rejection_reason: reason || 'Payment failed or was cancelled by the customer.',
    });

    console.log(`❌ [TOP-UP] ${topUp.topup_code} marked campay_failed — ${reason}`);
    return topUp;
}

/**
 * Find a DeliveryWalletTopUp by campay_ref.
 * Used by the webhook controller to route incoming CamPay events.
 *
 * @param {string} campayRef   The campay_ref stored on WegoPayment and on the topup
 * @returns {Promise<DeliveryWalletTopUp|null>}
 */
async function getTopUpByCampayRef(campayRef) {
    return DeliveryWalletTopUp.findOne({
        where: { campay_ref: campayRef },
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// READ — driver history + detail
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * List a driver's own top-up history with pagination.
 *
 * @param {string} driverId
 * @param {object} opts
 * @param {number}  [opts.page=1]
 * @param {number}  [opts.limit=20]
 * @param {string}  [opts.status]   filter by status
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
            'proof_url', 'payment_reference', 'campay_ref',
            'driver_note', 'status', 'rejection_reason',
            'balance_before_credit', 'balance_after_credit',
            'created_at', 'confirmed_at', 'credited_at', 'rejected_at',
        ],
    });

    return { rows, count, page, limit };
}

/**
 * Get a single top-up by ID.
 * Pass driverId to scope to a specific driver (prevents cross-driver peeking).
 *
 * @param {number}  topUpId
 * @param {string}  [driverId]  if provided, scopes query to this driver only
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
// BACKOFFICE — QUEUE + REVIEW ACTIONS (cash / manual flow only)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * List top-up requests for the backoffice queue.
 * Defaults to pending + under_review, sorted oldest-first (FIFO).
 *
 * @param {object} opts
 * @param {string|string[]}  [opts.status]   default ['pending','under_review']
 * @param {string}           [opts.channel]  filter by payment_channel
 * @param {number}           [opts.page=1]
 * @param {number}           [opts.limit=30]
 */
async function getPendingQueue(opts = {}) {
    const page  = Math.max(1, parseInt(opts.page)  || 1);
    const limit = Math.min(100, parseInt(opts.limit) || 30);

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
            include: [{
                model:      Account,
                as:         'account',
                attributes: ['first_name', 'last_name', 'phone_e164', 'avatar_url'],
            }],
        },
        {
            model:      Employee,
            as:         'reviewedByEmployee',
            attributes: ['id', 'name', 'email'],
            required:   false,
        },
    ];

    const { rows, count } = await DeliveryWalletTopUp.findAndCountAll({
        where,
        include,
        order:  [['created_at', 'ASC']],   // FIFO — oldest first
        limit,
        offset: (page - 1) * limit,
    });

    // Summary stats for the dashboard banner
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
 * Employee claims a cash top-up for review (pending → under_review).
 * Prevents two employees working the same item simultaneously.
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

    console.log(`🔍 [TOP-UP] ${topUp.topup_code} under_review by employee #${employeeId}`);
    return topUp;
}

/**
 * Employee confirms the payment is valid (under_review → confirmed).
 * Does NOT yet credit the wallet — call creditWallet() after this.
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
        reviewed_by: employeeId,
        admin_note:  adminNote,
    });

    console.log(`✅ [TOP-UP] ${topUp.topup_code} confirmed by employee #${employeeId}`);
    return topUp;
}

/**
 * Credit the wallet for a manually-confirmed top-up (confirmed → credited).
 * This is the ONLY place wallet balance is incremented for manual top-ups.
 * Wrapped in a full ACID transaction with SELECT FOR UPDATE.
 *
 * @param {number}  topUpId
 * @param {number}  [employeeId]  required for manual flow; null for automated
 */
async function creditWallet(topUpId, employeeId = null) {
    const t = await sequelize.transaction();

    try {
        const topUp = await DeliveryWalletTopUp.findOne({
            where: { id: topUpId },
            lock:  t.LOCK.UPDATE,
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
            const err = new Error(
                `Top-up must be 'confirmed' to credit. Current: ${topUp.status}`
            );
            err.statusCode = 409;
            throw err;
        }

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

        await wallet.increment(
            { balance: creditAmount, total_topped_up: creditAmount },
            { transaction: t }
        );

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

        await topUp.transitionTo('credited', {
            balance_before_credit: balanceBefore,
            balance_after_credit:  balanceAfter,
        });

        await t.commit();

        console.log(
            `💰 [TOP-UP] ${topUp.topup_code} credited — ` +
            `${creditAmount.toLocaleString()} XAF | ` +
            `balance: ${balanceBefore.toLocaleString()} → ${balanceAfter.toLocaleString()}`
        );

        return { topUp, wallet, creditAmount, balanceBefore, balanceAfter };

    } catch (error) {
        try { await t.rollback(); } catch (_) {}
        throw error;
    }
}

/**
 * Convenience: confirm + credit in one call.
 * Use for roles with full approval rights (no two-step needed).
 */
async function confirmAndCredit(topUpId, employeeId, adminNote = null) {
    await confirmTopUp(topUpId, employeeId, adminNote);
    return creditWallet(topUpId, employeeId);
}

/**
 * Reject a top-up (wrong amount, fake proof, etc.).
 * Works on pending, under_review status only.
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
    // Wallet bootstrap
    getOrCreateWallet,

    // Cash (manual backoffice flow)
    submitTopUp,

    // CamPay digital flow
    initiateTopUpPayment,
    creditWalletAutomatically,
    failTopUp,
    getTopUpByCampayRef,

    // Read
    getDriverTopUps,
    getTopUpById,

    // Backoffice actions
    getPendingQueue,
    markUnderReview,
    confirmTopUp,
    creditWallet,
    confirmAndCredit,
    rejectTopUp,
};