// src/controllers/driverTopUp.controller.js
//
// ═══════════════════════════════════════════════════════════════════════
// DRIVER WALLET TOP-UP CONTROLLER
// ═══════════════════════════════════════════════════════════════════════
//
// Handles pre-paid wallet funding for drivers (ride + delivery modes).
// This is the Uber/Yango model: drivers must have balance covering the
// commission on an estimated fare before they can receive trip offers.
//
// Two actors can trigger a top-up:
//
//   1. Driver self-service  → POST /api/driver/wallet/topup
//      Driver initiates a MoMo payment from their app. The request is
//      recorded as PENDING. A webhook from the payment gateway later
//      confirms or fails it.
//
//   2. Admin manual credit  → POST /api/backoffice/driver-wallets/:driverId/topup
//      Backoffice operator manually credits a driver's wallet (cash
//      payment at an agency, correction, promo credit, etc.).
//      Admin top-ups are immediately CONFIRMED — no webhook needed.
//
// Transaction design:
//   - Every top-up writes one DriverWalletTransaction (type=TOP_UP)
//   - DriverWallet.balance and totalTopUps are updated atomically in the
//     same DB transaction — they can never be out of sync
//   - reference field is unique → idempotent: duplicate requests with
//     the same reference are silently ignored (returns the existing entry)
//   - Admin top-ups use reference format: TOP_UP:ADMIN:{adminId}:{uuid}
//   - Driver-initiated top-ups use: TOP_UP:DRIVER:{uuid}
//
// ═══════════════════════════════════════════════════════════════════════

'use strict';

const { v4: uuidv4 }  = require('uuid');
const { Op, literal } = require('sequelize');
const { sequelize, DriverWallet, DriverWalletTransaction, Account } = require('../models');
const campayService = require('../services/campay/campayService');

// ── Minimum and maximum top-up amounts ────────────────────────────────
// Default 25 to stay testable against the CamPay demo (max 25 XAF) and to match
// the delivery-agent + fleet top-up minimums. Raise for production via env.
const MIN_TOPUP_XAF = parseInt(process.env.MIN_TOPUP_XAF || '25',     10);
const MAX_TOPUP_XAF = parseInt(process.env.MAX_TOPUP_XAF || '500000', 10);

// ═══════════════════════════════════════════════════════════════════════
// DRIVER SELF-SERVICE TOP-UP
// POST /api/driver/wallet/topup
// ═══════════════════════════════════════════════════════════════════════
//
// Driver requests to top up their own wallet.
// Records the top-up as CONFIRMED immediately for CASH payments
// (driver pays at agency desk and agent confirms on the spot).
// For MoMo/Orange Money, the record is created and confirmed by
// the payment gateway webhook (to be implemented separately).
//
// Body:
//   amount        {number}  Amount in XAF (integer, min 500, max 500 000)
//   method        {string}  MTN_MOMO | ORANGE_MONEY | CASH
//   phone         {string}  Phone number for MoMo push (required for MoMo/Orange)
//   reference     {string?} Optional external ref (e.g. MoMo transaction ID)
//
// Response:
//   transaction   The wallet transaction record
//   wallet        Updated balance snapshot

exports.driverTopUp = async (req, res, next) => {
    const driverId = req.user.uuid;
    let pendingTxn = null;

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('💳 [TOP-UP] driverTopUp — Driver:', driverId);

    try {
        const { amount, method, phone } = req.body;

        // ── Validation ─────────────────────────────────────────────────
        const parsedAmount = parseInt(amount, 10);

        if (!parsedAmount || isNaN(parsedAmount) || parsedAmount <= 0) {
            return res.status(400).json({
                success: false,
                message: 'amount is required and must be a positive integer.',
                code:    'INVALID_AMOUNT',
            });
        }

        if (parsedAmount < MIN_TOPUP_XAF) {
            return res.status(400).json({
                success: false,
                message: `Minimum top-up amount is ${MIN_TOPUP_XAF} XAF.`,
                code:    'AMOUNT_TOO_LOW',
                data:    { minimum: MIN_TOPUP_XAF, currency: 'XAF' },
            });
        }

        if (parsedAmount > MAX_TOPUP_XAF) {
            return res.status(400).json({
                success: false,
                message: `Maximum top-up amount is ${MAX_TOPUP_XAF} XAF.`,
                code:    'AMOUNT_TOO_HIGH',
                data:    { maximum: MAX_TOPUP_XAF, currency: 'XAF' },
            });
        }

        const VALID_METHODS = ['MTN_MOMO', 'ORANGE_MONEY'];
        if (!method || !VALID_METHODS.includes(method)) {
            return res.status(400).json({
                success: false,
                message: 'method must be MTN_MOMO or ORANGE_MONEY. Cash top-ups are handled at an agency.',
                code:    'INVALID_METHOD',
            });
        }

        if (!phone) {
            return res.status(400).json({
                success: false,
                message: 'phone is required for mobile money top-ups.',
                code:    'PHONE_REQUIRED',
            });
        }

        // ── Ensure the wallet exists and is active ──────────────────────
        // We do NOT credit here — the wallet is credited only by the CamPay
        // webhook/reconciliation finalizer once the mobile-money charge SUCCEEDS.
        const [wallet] = await DriverWallet.findOrCreate({
            where:    { driverId },
            defaults: {
                id:              uuidv4(),
                driverId,
                balance:         0,
                totalTopUps:     0,
                totalEarned:     0,
                totalCommission: 0,
                totalBonuses:    0,
                totalPayouts:    0,
                status:          'ACTIVE',
                currency:        'XAF',
            },
        });

        if (wallet.status !== 'ACTIVE') {
            return res.status(403).json({
                success: false,
                message: wallet.status === 'FROZEN'
                    ? 'Your wallet is currently frozen. Please contact support.'
                    : 'Your wallet is suspended. Please contact support.',
                code:    `WALLET_${wallet.status}`,
            });
        }

        // ── Step 1: create a PENDING ledger row BEFORE calling CamPay ────
        // balanceAfter is a placeholder (current balance); it is finalised to
        // the real post-credit balance only when the collection SUCCEEDS.
        const currentBalance = parseInt(wallet.balance, 10) || 0;
        pendingTxn = await DriverWalletTransaction.create({
            id:           uuidv4(),
            driverId,
            walletId:     wallet.id,
            type:         'TOP_UP',
            amount:       parsedAmount,
            balanceAfter: currentBalance,               // placeholder until credited
            description:  `Wallet top-up via ${_methodLabel(method)} — ${parsedAmount.toLocaleString()} XAF`,
            reference:    `TOP_UP:DRIVER:${uuidv4()}`,
            topUpMethod:  method,
            topUpRef:     null,                         // set to campay_ref after initiation
            topUpStatus:  'PENDING',
            metadata: {
                method,
                phone,
                initiatedBy: 'driver',
                driverId,
            },
            createdAt: new Date(),
        });

        // ── Step 2: initiate the CamPay collection (charge the driver's phone) ──
        // Reuses the fleet_topup vertical: the finalizer credits a PENDING
        // DriverWalletTransaction by id regardless of who initiated it.
        let campayResult;
        try {
            campayResult = await campayService.initiateCollection({
                vertical:    'fleet_topup',
                verticalId:  pendingTxn.id,
                phone,
                initiatedBy: driverId,
            });
        } catch (campayErr) {
            await pendingTxn.update({
                topUpStatus: 'FAILED',
                description: `${pendingTxn.description} — CamPay init failed`,
            }).catch(() => {});
            console.error('❌ [TOP-UP] driverTopUp CamPay init failed:', campayErr.message);
            const clean = campayErr.message?.replace('[CAMPAY SERVICE] ', '')
                || 'Could not start the mobile money payment. Please try again.';
            return res.status(502).json({ success: false, message: clean, code: 'CAMPAY_INIT_FAILED' });
        }

        // Store the CamPay ref on the ledger row for traceability.
        await pendingTxn.update({ topUpRef: campayResult.campayRef }).catch(() => {});

        console.log(`✅ [TOP-UP] CamPay collection initiated — Driver: ${driverId} | ${parsedAmount} XAF | ref: ${campayResult.campayRef}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(201).json({
            success: true,
            pending: true,
            message: 'Check your phone and enter your Mobile Money PIN to confirm the top-up.',
            data: {
                transactionId: pendingTxn.id,
                paymentId:     campayResult.paymentId,
                campayRef:     campayResult.campayRef,
                ussdCode:      campayResult.ussdCode,
                operator:      campayResult.operator,
                amount:        parsedAmount,
                status:        'PENDING',
            },
        });

    } catch (error) {
        if (pendingTxn) { await pendingTxn.update({ topUpStatus: 'FAILED' }).catch(() => {}); }

        // Re-throw business errors (wallet frozen/suspended) with their status
        if (error.status) return res.status(error.status).json({
            success: false,
            message: error.message,
            code:    error.code,
        });

        console.error('❌ [TOP-UP] driverTopUp error:', error);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET DRIVER TOP-UP HISTORY
// GET /api/driver/wallet/topup/history
// ═══════════════════════════════════════════════════════════════════════
//
// Returns the driver's paginated list of past top-ups.
// Query params:
//   page    (default: 1)
//   limit   (default: 20, max: 50)
//   period  (today | week | month | all — default: all)

exports.getTopUpHistory = async (req, res, next) => {
    const driverId = req.user.uuid;

    try {
        console.log(`\n📋 [TOP-UP] getTopUpHistory — Driver: ${driverId}`);

        const page   = Math.max(parseInt(req.query.page  || '1',  10), 1);
        const limit  = Math.min(parseInt(req.query.limit || '20', 10), 50);
        const period = req.query.period || 'all';
        const offset = (page - 1) * limit;

        const where = { driverId, type: 'TOP_UP' };

        const dateFilter = _buildDateFilter(period);
        if (dateFilter) where.createdAt = dateFilter;

        const { count, rows: topUps } = await DriverWalletTransaction.findAndCountAll({
            where,
            order:  [['createdAt', 'DESC']],
            limit,
            offset,
        });

        const totalAmount = topUps.reduce((sum, t) => sum + t.amount, 0);

        console.log(`✅ [TOP-UP] ${count} top-ups found | Total: ${totalAmount} XAF`);

        return res.status(200).json({
            success: true,
            data: {
                topUps: topUps.map(_formatTransaction),
                period,
                summary: {
                    totalAmount,
                    count,
                    currency: 'XAF',
                },
                pagination: {
                    total:      count,
                    page,
                    limit,
                    totalPages: Math.ceil(count / limit),
                },
            },
        });

    } catch (error) {
        console.error('❌ [TOP-UP] getTopUpHistory error:', error);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// ADMIN MANUAL TOP-UP
// POST /api/backoffice/driver-wallets/:driverId/topup
// ═══════════════════════════════════════════════════════════════════════
//
// Backoffice operator manually credits a driver wallet.
// Use cases: cash payment at agency, correction, promotional credit.
// Admin top-ups are immediately confirmed — no webhook needed.
//
// Body:
//   amount  {number}  Amount in XAF
//   method  {string}  MTN_MOMO | ORANGE_MONEY | CASH | BANK_TRANSFER
//   note    {string}  Mandatory reason for the credit
//
// Auth: employee JWT (req.employee set by employeeAuth middleware)

exports.adminTopUp = async (req, res, next) => {
    const { driverId } = req.params;
    const adminId      = req.employee?.id;
    const adminName    = `${req.employee?.first_name || ''} ${req.employee?.last_name || ''}`.trim() || 'Admin';

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`💳 [TOP-UP] adminTopUp — Driver: ${driverId} | Admin: ${adminName} (#${adminId})`);

    try {
        const { amount, method, note } = req.body;

        // ── Validation ─────────────────────────────────────────────────
        const parsedAmount = parseInt(amount, 10);

        if (!parsedAmount || isNaN(parsedAmount) || parsedAmount <= 0) {
            return res.status(400).json({
                success: false,
                message: 'amount is required and must be a positive integer.',
                code:    'INVALID_AMOUNT',
            });
        }

        if (parsedAmount > MAX_TOPUP_XAF) {
            return res.status(400).json({
                success: false,
                message: `Maximum single top-up is ${MAX_TOPUP_XAF} XAF. Split into multiple credits if needed.`,
                code:    'AMOUNT_TOO_HIGH',
                data:    { maximum: MAX_TOPUP_XAF, currency: 'XAF' },
            });
        }

        const VALID_METHODS = ['MTN_MOMO', 'ORANGE_MONEY', 'CASH', 'BANK_TRANSFER'];
        if (!method || !VALID_METHODS.includes(method)) {
            return res.status(400).json({
                success: false,
                message: `method must be one of: ${VALID_METHODS.join(', ')}.`,
                code:    'INVALID_METHOD',
            });
        }

        if (!note || !note.trim()) {
            return res.status(400).json({
                success: false,
                message: 'note is required for admin top-ups. Explain the reason for the credit.',
                code:    'NOTE_REQUIRED',
            });
        }

        // ── Verify driver account exists ────────────────────────────────
        const driverAccount = await Account.findOne({
            where:      { uuid: driverId, user_type: { [Op.in]: ['DRIVER', 'DELIVERY_AGENT'] } },
            attributes: ['uuid', 'first_name', 'last_name', 'status'],
        });

        if (!driverAccount) {
            return res.status(404).json({
                success: false,
                message: 'Driver account not found.',
                code:    'DRIVER_NOT_FOUND',
            });
        }

        if (driverAccount.status === 'DELETED') {
            return res.status(403).json({
                success: false,
                message: 'Cannot top up a deleted account.',
                code:    'ACCOUNT_DELETED',
            });
        }

        const reference = `TOP_UP:ADMIN:${adminId}:${uuidv4()}`;

        // ── Execute inside a DB transaction ─────────────────────────────
        const result = await sequelize.transaction(async (t) => {

            const [wallet] = await DriverWallet.findOrCreate({
                where:    { driverId },
                defaults: {
                    id:              uuidv4(),
                    driverId,
                    balance:         0,
                    totalTopUps:     0,
                    totalEarned:     0,
                    totalCommission: 0,
                    totalBonuses:    0,
                    totalPayouts:    0,
                    status:          'ACTIVE',
                    currency:        'XAF',
                },
                transaction: t,
                lock:        true,
            });

            // Admin can top up FROZEN wallets — it's an intentional override.
            // SUSPENDED wallets are blocked even for admins (requires escalation).
            if (wallet.status === 'SUSPENDED') {
                const err = new Error('Wallet is suspended. Reinstate the driver account before crediting.');
                err.status = 403;
                err.code   = 'WALLET_SUSPENDED';
                throw err;
            }

            const newBalance = wallet.balance + parsedAmount;

            const transaction = await DriverWalletTransaction.create({
                id:           uuidv4(),
                driverId,
                walletId:     wallet.id,
                type:         'TOP_UP',
                amount:       parsedAmount,
                balanceAfter: newBalance,
                description:  `Admin wallet credit — ${parsedAmount.toLocaleString()} XAF (${note.trim()})`,
                reference,
                topUpMethod:  method,
                topUpRef:     null,
                metadata: {
                    method,
                    initiatedBy: 'admin',
                    adminId,
                    adminName,
                    note:        note.trim(),
                    driverName:  `${driverAccount.first_name} ${driverAccount.last_name}`.trim(),
                },
                createdAt: new Date(),
            }, { transaction: t });

            await DriverWallet.update(
                {
                    balance:     literal(`balance + ${parsedAmount}`),
                    totalTopUps: literal(`totalTopUps + ${parsedAmount}`),
                    lastTopUpAt: new Date(),
                },
                {
                    where:       { id: wallet.id },
                    transaction: t,
                }
            );

            const updatedWallet = await DriverWallet.findOne({
                where:       { id: wallet.id },
                transaction: t,
            });

            return { transaction, wallet: updatedWallet };
        });

        console.log(`✅ [TOP-UP] Admin credit success — Driver: ${driverId} | +${parsedAmount} XAF | Admin: ${adminName}`);
        console.log(`   New balance: ${result.wallet.balance} XAF`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(201).json({
            success: true,
            message: `Wallet credited successfully. New balance: ${result.wallet.balance.toLocaleString()} XAF`,
            data: {
                driver: {
                    uuid:  driverAccount.uuid,
                    name:  `${driverAccount.first_name} ${driverAccount.last_name}`.trim(),
                },
                transaction: _formatTransaction(result.transaction),
                wallet:      _formatWallet(result.wallet),
                creditedBy:  { adminId, adminName },
            },
        });

    } catch (error) {
        if (error.status) return res.status(error.status).json({
            success: false,
            message: error.message,
            code:    error.code,
        });

        console.error('❌ [TOP-UP] adminTopUp error:', error);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// PRIVATE HELPERS
// ═══════════════════════════════════════════════════════════════════════

function _methodLabel(method) {
    const labels = {
        MTN_MOMO:     'MTN MoMo',
        ORANGE_MONEY: 'Orange Money',
        CASH:         'Cash',
        BANK_TRANSFER:'Bank Transfer',
    };
    return labels[method] || method;
}

function _formatTransaction(tx) {
    return {
        id:           tx.id,
        type:         tx.type,
        amount:       tx.amount,
        balanceAfter: tx.balanceAfter,
        description:  tx.description,
        reference:    tx.reference,
        topUpMethod:  tx.topUpMethod  || null,
        topUpRef:     tx.topUpRef     || null,
        metadata:     tx.metadata     || null,
        createdAt:    tx.createdAt,
        label:        'Wallet Top-Up',
        isCredit:     true,
    };
}

function _formatWallet(wallet) {
    return {
        balance:         wallet.balance,
        totalTopUps:     wallet.totalTopUps,
        totalEarned:     wallet.totalEarned,
        totalCommission: wallet.totalCommission,
        totalBonuses:    wallet.totalBonuses,
        totalPayouts:    wallet.totalPayouts,
        currency:        wallet.currency,
        status:          wallet.status,
        lastTopUpAt:     wallet.lastTopUpAt,
    };
}

function _buildDateFilter(period) {
    const now        = new Date();
    const today      = new Date(now); today.setUTCHours(0, 0, 0, 0);
    const tomorrow   = new Date(today); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const weekStart  = new Date(today);
    const day        = weekStart.getUTCDay() || 7;
    weekStart.setUTCDate(weekStart.getUTCDate() - day + 1);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    switch (period) {
        case 'today': return { [Op.gte]: today, [Op.lt]: tomorrow };
        case 'week':  return { [Op.gte]: weekStart };
        case 'month': return { [Op.gte]: monthStart };
        default:      return null;
    }
}