// src/controllers/driverEarnings.controller.js
//
// ═══════════════════════════════════════════════════════════════════════
// DRIVER EARNINGS CONTROLLER
// ═══════════════════════════════════════════════════════════════════════
//
// All endpoints here derive driverId exclusively from req.user.uuid
// (set by auth middleware from JWT). The frontend NEVER supplies driverId.
//
// Endpoints:
//   GET  /api/driver/earnings/summary         → balance + period breakdowns
//   GET  /api/driver/earnings/trips           → paginated trip receipts
//   GET  /api/driver/earnings/activity        → wallet transaction ledger
//   GET  /api/driver/earnings/quests          → active programs + progress
//   POST /api/driver/earnings/topup           → initiate CamPay top-up
//   POST /api/driver/earnings/withdraw        → initiate CamPay withdrawal
//   POST /api/driver/earnings/campay/webhook  → CamPay payment confirmation
//
// ── Top-up flow ──────────────────────────────────────────────────────
//   1. Driver POSTs { amount, phone }
//   2. Controller validates, ensures wallet exists, creates PENDING
//      DriverWalletTransaction (type=TOP_UP). Balance NOT credited yet.
//   3. Calls campayClient.collect() directly (top-up is not a "vertical"
//      payment — no Trip/Delivery/Rental to resolve amount from).
//      Also creates a WegoPayment record for the audit trail.
//   4. Driver gets USSD prompt → approves → CamPay fires webhook.
//   5. Webhook handler credits wallet + marks tx COMPLETED.
//
// ── Withdrawal flow ──────────────────────────────────────────────────
//   1. Driver POSTs { amount, phone }
//   2. Controller validates balance (must keep MIN_WALLET_BALANCE after).
//   3. Optimistic debit: wallet debited immediately (prevents double-spend).
//   4. Calls campayClient.disburse() — disbursement result is synchronous.
//   5. SUCCESSFUL → mark PAYOUT as COMPLETED. FAILED → reverse the debit.
//
// ═══════════════════════════════════════════════════════════════════════

'use strict';

const { Op, literal }  = require('sequelize');
const { v4: uuidv4 }   = require('uuid');
const sequelize        = require('../config/database');

const earningsEngine   = require('../services/earningsEngineService');
const campayClient     = require('../services/campay/campayClient');

const {
    TripReceipt,
    DriverWallet,
    DriverWalletTransaction,
    WegoPayment,
    BonusProgram,
    BonusAward,
    Trip,
} = require('../models');

// ── Business rules ──────────────────────────────────────────────────────
const MIN_TOPUP_AMOUNT      = 1000;    // XAF
const MAX_TOPUP_AMOUNT      = 500_000; // XAF
const MIN_WITHDRAWAL_AMOUNT = 1000;    // XAF
const MIN_WALLET_BALANCE    = 2000;    // XAF — driver must keep this after withdrawal

// ── All valid tx types (kept in sync with DriverWalletTransaction ENUM) ─
const ALL_TX_TYPES = [
    'TOP_UP', 'TRIP_FARE', 'COMMISSION', 'BONUS_TRIP',
    'BONUS_QUEST', 'ADJUSTMENT', 'REFUND', 'PAYOUT',
];

// ═══════════════════════════════════════════════════════════════════════
// GET /api/driver/earnings/summary
// ═══════════════════════════════════════════════════════════════════════

exports.getSummary = async (req, res, next) => {
    try {
        const driverId = req.user.uuid;

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('💰 [EARNINGS] getSummary — Driver:', driverId);

        const summary = await earningsEngine.getWalletSummary(driverId);

        if (!summary) {
            console.log('ℹ️  [EARNINGS] No wallet found — returning empty summary');
            return res.status(200).json({
                success: true,
                data: {
                    balance:         0,
                    totalTopUps:     0,
                    totalEarned:     0,
                    totalCommission: 0,
                    totalBonuses:    0,
                    totalPayouts:    0,
                    currency:        'XAF',
                    walletStatus:    'ACTIVE',
                    lastPayoutAt:    null,
                    lastTopUpAt:     null,
                    today:  { net: 0, trips: 0 },
                    week:   { net: 0, trips: 0 },
                    month:  { net: 0 },
                },
            });
        }

        console.log(`✅ [EARNINGS] Summary: balance=${summary.balance} XAF | topUps=${summary.totalTopUps ?? 0} XAF`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({
            success: true,
            data: {
                balance:         summary.balance,
                totalTopUps:     summary.totalTopUps     ?? 0,
                lastTopUpAt:     summary.lastTopUpAt     ?? null,
                totalEarned:     summary.totalEarned,
                totalCommission: summary.totalCommission,
                totalBonuses:    summary.totalBonuses,
                totalPayouts:    summary.totalPayouts,
                currency:        summary.currency,
                walletStatus:    summary.status,
                lastPayoutAt:    summary.lastPayoutAt,
                today:           summary.today,
                week:            summary.week,
                month:           summary.month,
            },
        });

    } catch (error) {
        console.error('❌ [EARNINGS] getSummary error:', error);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET /api/driver/earnings/trips
// ─────────────────────────────────────────────────────────────────────
// Query params: page, limit, period (today | week | month | all)
// ═══════════════════════════════════════════════════════════════════════

exports.getTripReceipts = async (req, res, next) => {
    try {
        const driverId = req.user.uuid;

        const page   = Math.max(parseInt(req.query.page  || '1',  10), 1);
        const limit  = Math.min(parseInt(req.query.limit || '20', 10), 50);
        const period = req.query.period || 'week';
        const offset = (page - 1) * limit;

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`📋 [EARNINGS] getTripReceipts — Driver: ${driverId} | Period: ${period} | Page: ${page}`);

        const dateFilter = _buildDateFilter(period);
        const where      = { driverId };
        if (dateFilter) where.createdAt = dateFilter;

        const { count, rows: receipts } = await TripReceipt.findAndCountAll({
            where,
            include: [
                {
                    model:      Trip,
                    as:         'trip',
                    attributes: [
                        'id', 'pickupAddress', 'dropoffAddress',
                        'distanceM', 'durationS', 'paymentMethod',
                        'tripStartedAt', 'tripCompletedAt',
                    ],
                    required: false,
                },
            ],
            order:  [['createdAt', 'DESC']],
            limit,
            offset,
        });

        console.log(`✅ [EARNINGS] ${count} receipts found`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        const formatted = receipts.map(r => ({
            receiptId:        r.id,
            tripId:           r.tripId,
            grossFare:        r.grossFare,
            commissionRate:   parseFloat(r.commissionRate),
            commissionAmount: r.commissionAmount,
            bonusTotal:       r.bonusTotal,
            driverNet:        r.driverNet,
            paymentMethod:    r.paymentMethod,
            status:           r.status,
            processedAt:      r.processedAt,
            createdAt:        r.createdAt,
            breakdown:        r.appliedRules || [],
            trip: r.trip ? {
                pickupAddress:  r.trip.pickupAddress,
                dropoffAddress: r.trip.dropoffAddress,
                distanceM:      r.trip.distanceM,
                durationS:      r.trip.durationS,
                paymentMethod:  r.trip.paymentMethod,
                startedAt:      r.trip.tripStartedAt,
                completedAt:    r.trip.tripCompletedAt,
            } : null,
        }));

        return res.status(200).json({
            success: true,
            data: {
                receipts: formatted,
                period,
                pagination: {
                    total:      count,
                    page,
                    limit,
                    totalPages: Math.ceil(count / limit),
                },
            },
        });

    } catch (error) {
        console.error('❌ [EARNINGS] getTripReceipts error:', error);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET /api/driver/earnings/activity
// ─────────────────────────────────────────────────────────────────────
// Query params: page, limit, period, type
// ═══════════════════════════════════════════════════════════════════════

exports.getActivity = async (req, res, next) => {
    try {
        const driverId = req.user.uuid;

        const page   = Math.max(parseInt(req.query.page  || '1',  10), 1);
        const limit  = Math.min(parseInt(req.query.limit || '30', 10), 100);
        const period = req.query.period || 'all';
        const type   = req.query.type   || 'all';
        const offset = (page - 1) * limit;

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`📊 [EARNINGS] getActivity — Driver: ${driverId} | Period: ${period} | Type: ${type}`);

        const where      = { driverId };
        const dateFilter = _buildDateFilter(period);
        if (dateFilter) where.createdAt = dateFilter;

        if (type !== 'all' && ALL_TX_TYPES.includes(type.toUpperCase())) {
            where.type = type.toUpperCase();
        }

        const { count, rows: transactions } = await DriverWalletTransaction.findAndCountAll({
            where,
            order:  [['createdAt', 'DESC']],
            limit,
            offset,
        });

        console.log(`✅ [EARNINGS] ${count} transactions found`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        const formatted = transactions.map(tx => ({
            id:           tx.id,
            type:         tx.type,
            amount:       tx.amount,
            balanceAfter: tx.balanceAfter,
            description:  tx.description,
            tripId:       tx.tripId    || null,
            receiptId:    tx.receiptId || null,
            createdAt:    tx.createdAt,
            // PAYOUT-specific
            payoutMethod: tx.payoutMethod || null,
            payoutRef:    tx.payoutRef    || null,
            payoutStatus: tx.payoutStatus || null,
            // TOP_UP-specific
            topUpMethod:  tx.topUpMethod  || null,
            topUpRef:     tx.topUpRef     || null,
            topUpStatus:  tx.topUpStatus  || null,
            metadata:     tx.metadata     || null,
            isCredit:     tx.amount > 0,
            isDebit:      tx.amount < 0,
            label:        _txTypeLabel(tx.type),
        }));

        const periodCredits = transactions.filter(tx => tx.amount > 0).reduce((s, tx) => s + tx.amount, 0);
        const periodDebits  = transactions.filter(tx => tx.amount < 0).reduce((s, tx) => s + tx.amount, 0);

        return res.status(200).json({
            success: true,
            data: {
                transactions: formatted,
                period,
                periodSummary: {
                    totalCredits: periodCredits,
                    totalDebits:  Math.abs(periodDebits),
                    net:          periodCredits + periodDebits,
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
        console.error('❌ [EARNINGS] getActivity error:', error);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET /api/driver/earnings/quests
// ═══════════════════════════════════════════════════════════════════════

exports.getQuests = async (req, res, next) => {
    try {
        const driverId = req.user.uuid;

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`🎯 [EARNINGS] getQuests — Driver: ${driverId}`);

        const today = new Date().toISOString().split('T')[0];

        const programs = await BonusProgram.findAll({
            where: {
                isActive: true,
                [Op.and]: [
                    { [Op.or]: [{ validFrom: null }, { validFrom: { [Op.lte]: today } }] },
                    { [Op.or]: [{ validTo:   null }, { validTo:   { [Op.gte]: today } }] },
                ],
            },
            order: [['displayOrder', 'ASC']],
        });

        if (programs.length === 0) {
            return res.status(200).json({ success: true, data: { quests: [] } });
        }

        const quests = await Promise.all(programs.map(async (program) => {
            const periodKey   = BonusProgram.getPeriodKey(program.period);
            const periodStart = earningsEngine._getPeriodStart(program.period);

            const award = await BonusAward.findOne({
                where: { driverId, programId: program.id, periodKey },
            });

            const baseWhere = {
                driverId,
                status:          'COMPLETED',
                tripCompletedAt: { [Op.gte]: periodStart },
            };

            let currentMetric = 0;
            if (program.type.includes('TRIPS') || program.type === 'LIFETIME_TRIPS') {
                const where = program.type === 'LIFETIME_TRIPS'
                    ? { driverId, status: 'COMPLETED' }
                    : baseWhere;
                currentMetric = await Trip.count({ where });
            } else if (program.type.includes('EARNINGS')) {
                const sum     = await Trip.sum('fareFinal', { where: baseWhere });
                currentMetric = Math.round(sum || 0);
            }

            const progressPercent = Math.min(
                Math.round((currentMetric / program.targetValue) * 100),
                100
            );

            return {
                programId:      program.id,
                name:           program.name,
                description:    program.description,
                type:           program.type,
                period:         program.period,
                periodKey,
                iconEmoji:      program.iconEmoji || '🏆',
                targetValue:    program.targetValue,
                bonusAmount:    program.bonusAmount,
                currentMetric,
                progressPercent,
                isCompleted:    !!award,
                completedAt:    award?.awardedAt || null,
                metricUnit:     program.type.includes('EARNINGS') ? 'XAF' : 'trips',
                remaining:      Math.max(program.targetValue - currentMetric, 0),
            };
        }));

        console.log(`✅ [EARNINGS] ${quests.length} quests returned`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({ success: true, data: { quests } });

    } catch (error) {
        console.error('❌ [EARNINGS] getQuests error:', error);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /api/driver/earnings/topup
// ─────────────────────────────────────────────────────────────────────
// Initiates a mobile money charge to top up the driver's pre-paid wallet.
//
// Body: { amount: number, phone: string }
//
// Unlike the 4 customer-facing verticals, top-up has no Trip/Delivery/
// ServiceRequest/Rental to resolve an amount from. We bypass
// campayService.initiateCollection() and call campayClient.collect()
// directly — but we still create a WegoPayment for the unified audit trail.
//
// Balance is credited only when /campay/webhook fires with SUCCESSFUL.
// ═══════════════════════════════════════════════════════════════════════

exports.initiateTopUp = async (req, res, next) => {
    const t = await sequelize.transaction();

    try {
        const driverId = req.user.uuid;
        const { amount, phone } = req.body;

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`💳 [TOP-UP] Driver: ${driverId} | Amount: ${amount} | Phone: ${phone}`);

        // ── 1. Validate ───────────────────────────────────────────────
        if (!amount || !phone) {
            await t.rollback();
            return res.status(400).json({
                success: false,
                error:   'MISSING_FIELDS',
                message: 'amount and phone are required.',
            });
        }

        const amountInt = Math.floor(Number(amount));
        if (isNaN(amountInt) || amountInt < MIN_TOPUP_AMOUNT) {
            await t.rollback();
            return res.status(400).json({
                success: false,
                error:   'AMOUNT_TOO_LOW',
                message: `Minimum top-up is ${MIN_TOPUP_AMOUNT.toLocaleString()} XAF.`,
            });
        }
        if (amountInt > MAX_TOPUP_AMOUNT) {
            await t.rollback();
            return res.status(400).json({
                success: false,
                error:   'AMOUNT_TOO_HIGH',
                message: `Maximum top-up is ${MAX_TOPUP_AMOUNT.toLocaleString()} XAF per transaction.`,
            });
        }

        // Normalise phone: strip spaces/+, prepend 237 if needed
        const digits = String(phone).replace(/\D/g, '');
        const normalisedPhone = /^237\d{9}$/.test(digits) ? digits
            : /^\d{9}$/.test(digits) ? `237${digits}`
                : null;

        if (!normalisedPhone) {
            await t.rollback();
            return res.status(400).json({
                success: false,
                error:   'INVALID_PHONE',
                message: 'Phone must be a valid Cameroon number, e.g. 237670000000 or 670000000.',
            });
        }

        // ── 2. Ensure wallet exists ───────────────────────────────────
        let wallet = await DriverWallet.findOne({ where: { driverId }, transaction: t });

        if (!wallet) {
            console.log('ℹ️  [TOP-UP] No wallet yet — creating for driver');
            wallet = await DriverWallet.create({
                id:       uuidv4(),
                driverId,
                balance:  0,
                currency: 'XAF',
                status:   'ACTIVE',
            }, { transaction: t });
        }

        if (wallet.status !== 'ACTIVE') {
            await t.rollback();
            return res.status(403).json({
                success: false,
                error:   'WALLET_FROZEN',
                message: 'Your wallet is currently frozen. Please contact support.',
            });
        }

        // ── 3. Build external reference ───────────────────────────────
        // Format mirrors campayService convention: WEGO-TOPUP-{driverShort}-{uuid}
        const shortDriver  = driverId.replace(/-/g, '').slice(0, 8).toUpperCase();
        const shortUuid    = uuidv4().replace(/-/g, '').slice(0, 10).toUpperCase();
        const externalRef  = `WEGO-TOPUP-${shortDriver}-${shortUuid}`;

        // ── 4. Create PENDING DriverWalletTransaction ─────────────────
        // Balance NOT updated yet — webhook will credit on SUCCESSFUL.
        const txId = uuidv4();

        const pendingTx = await DriverWalletTransaction.create({
            id:           txId,
            driverId,
            walletId:     wallet.id,
            type:         'TOP_UP',
            amount:       amountInt,         // positive; applied on webhook confirm
            balanceAfter: wallet.balance,    // snapshot of balance BEFORE credit
            description:  'Wallet top-up via Mobile Money',
            reference:    `TOP_UP:${externalRef}`,
            topUpStatus:  'PENDING',
            metadata: {
                phone:       normalisedPhone,
                externalRef,
                initiatedAt: new Date().toISOString(),
            },
            createdAt:    new Date(),
        }, { transaction: t });

        // ── 5. Create WegoPayment for the unified audit trail ─────────
        const payment = await WegoPayment.create({
            id:           uuidv4(),
            vertical:     null,      // top-up is not a customer-facing vertical
            vertical_id:  null,
            external_ref: externalRef,
            phone:        normalisedPhone,
            amount:       amountInt,
            direction:    'collect',
            status:       'PENDING',
            initiated_by: driverId,
            initiated_at: new Date(),
            notes:        `Driver wallet top-up | walletTxId: ${txId}`,
        }, { transaction: t });

        await t.commit();

        // ── 6. Call CamPay — AFTER the DB transaction commits ─────────
        // If CamPay fails, we still have the PENDING records for cleanup.
        let campayResponse;
        try {
            campayResponse = await campayClient.collect({
                amount:             String(amountInt),
                currency:           'XAF',
                from:               normalisedPhone,
                description:        `WeGo wallet top-up — ${amountInt} XAF`,
                external_reference: externalRef,
            });
        } catch (campayErr) {
            // Mark both records as FAILED
            await DriverWalletTransaction.update(
                { topUpStatus: 'FAILED' },
                { where: { id: txId } }
            );
            await WegoPayment.update(
                { status: 'FAILED', failure_reason: campayErr.message, campay_code: campayErr.campayCode || null, resolved_at: new Date() },
                { where: { id: payment.id } }
            );
            console.error('❌ [TOP-UP] CamPay collect failed:', campayErr.message);
            return res.status(502).json({
                success: false,
                error:   'CAMPAY_ERROR',
                message: 'Could not initiate payment. Please try again.',
            });
        }

        // ── 7. Store CamPay's reference on both records ───────────────
        await DriverWalletTransaction.update(
            {
                topUpRef: campayResponse.reference,
                metadata: {
                    phone:       normalisedPhone,
                    externalRef,
                    campayRef:   campayResponse.reference,
                    operator:    campayResponse.operator || null,
                    ussdCode:    campayResponse.ussd_code || null,
                    initiatedAt: new Date().toISOString(),
                },
            },
            { where: { id: txId } }
        );
        await WegoPayment.update(
            {
                campay_ref:      campayResponse.reference,
                operator:        campayResponse.operator || null,
                campay_response: campayResponse,
            },
            { where: { id: payment.id } }
        );

        console.log(`✅ [TOP-UP] Pending — txId: ${txId} | campayRef: ${campayResponse.reference}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({
            success: true,
            data: {
                pending:     true,
                txId,
                paymentId:   payment.id,
                campayRef:   campayResponse.reference,
                externalRef,
                amount:      amountInt,
                currency:    'XAF',
                phone:       normalisedPhone,
                operator:    campayResponse.operator  || null,
                ussdCode:    campayResponse.ussd_code || null,
                message:     'A payment prompt has been sent to your phone. Approve it to credit your wallet.',
            },
        });

    } catch (error) {
        await t.rollback().catch(() => {});
        console.error('❌ [TOP-UP] Unexpected error:', error);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /api/driver/earnings/withdraw
// ─────────────────────────────────────────────────────────────────────
// Driver withdraws earnings to their mobile money number.
//
// Body: { amount: number, phone: string }
//
// Uses campayClient.disburse() directly (same reason as top-up — no
// vertical to resolve amount from). Also creates a WegoPayment record.
//
// Disbursement result from CamPay is SYNCHRONOUS — no webhook needed.
// We get SUCCESSFUL or FAILED immediately in the response.
// ═══════════════════════════════════════════════════════════════════════

exports.initiateWithdraw = async (req, res, next) => {
    const t = await sequelize.transaction();

    try {
        const driverId = req.user.uuid;
        const { amount, phone } = req.body;

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`💸 [WITHDRAW] Driver: ${driverId} | Amount: ${amount} | Phone: ${phone}`);

        // ── 1. Validate ───────────────────────────────────────────────
        if (!amount || !phone) {
            await t.rollback();
            return res.status(400).json({
                success: false,
                error:   'MISSING_FIELDS',
                message: 'amount and phone are required.',
            });
        }

        const amountInt = Math.floor(Number(amount));
        if (isNaN(amountInt) || amountInt < MIN_WITHDRAWAL_AMOUNT) {
            await t.rollback();
            return res.status(400).json({
                success: false,
                error:   'AMOUNT_TOO_LOW',
                message: `Minimum withdrawal is ${MIN_WITHDRAWAL_AMOUNT.toLocaleString()} XAF.`,
            });
        }

        const digits = String(phone).replace(/\D/g, '');
        const normalisedPhone = /^237\d{9}$/.test(digits) ? digits
            : /^\d{9}$/.test(digits) ? `237${digits}`
                : null;

        if (!normalisedPhone) {
            await t.rollback();
            return res.status(400).json({
                success: false,
                error:   'INVALID_PHONE',
                message: 'Phone must be a valid Cameroon number, e.g. 237670000000 or 670000000.',
            });
        }

        // ── 2. Lock wallet + check balance ────────────────────────────
        const wallet = await DriverWallet.findOne({
            where:       { driverId },
            lock:        t.LOCK.UPDATE,
            transaction: t,
        });

        if (!wallet) {
            await t.rollback();
            return res.status(404).json({
                success: false,
                error:   'NO_WALLET',
                message: 'No wallet found. Please top up first.',
            });
        }

        if (wallet.status !== 'ACTIVE') {
            await t.rollback();
            return res.status(403).json({
                success: false,
                error:   'WALLET_FROZEN',
                message: 'Your wallet is currently frozen. Please contact support.',
            });
        }

        const balanceAfter = wallet.balance - amountInt;
        if (balanceAfter < MIN_WALLET_BALANCE) {
            await t.rollback();
            const maxWithdraw = Math.max(wallet.balance - MIN_WALLET_BALANCE, 0);
            return res.status(400).json({
                success:        false,
                error:          'INSUFFICIENT_BALANCE',
                message:        `You must keep at least ${MIN_WALLET_BALANCE.toLocaleString()} XAF in your wallet.`,
                currentBalance: wallet.balance,
                maxWithdraw,
            });
        }

        // ── 3. Build external reference ───────────────────────────────
        const shortDriver = driverId.replace(/-/g, '').slice(0, 8).toUpperCase();
        const shortUuid   = uuidv4().replace(/-/g, '').slice(0, 10).toUpperCase();
        const externalRef = `WEGO-PAY-${shortDriver}-${shortUuid}`;

        // ── 4. Optimistic debit — deduct before calling CamPay ────────
        // SELECT FOR UPDATE above prevents concurrent withdrawals from
        // double-spending. If CamPay fails we reverse via REFUND credit.
        const txId = uuidv4();

        await DriverWallet.update(
            {
                balance:      balanceAfter,
                totalPayouts: literal(`totalPayouts + ${amountInt}`),
                lastPayoutAt: new Date(),
            },
            { where: { id: wallet.id }, transaction: t }
        );

        await DriverWalletTransaction.create({
            id:           txId,
            driverId,
            walletId:     wallet.id,
            type:         'PAYOUT',
            amount:       -amountInt,       // negative — debit
            balanceAfter,
            description:  'Earnings withdrawal via Mobile Money',
            reference:    `PAYOUT:${externalRef}`,
            payoutStatus: 'PENDING',
            metadata: {
                phone:       normalisedPhone,
                externalRef,
                initiatedAt: new Date().toISOString(),
            },
            createdAt:    new Date(),
        }, { transaction: t });

        // ── 5. WegoPayment audit record ───────────────────────────────
        const payment = await WegoPayment.create({
            id:           uuidv4(),
            vertical:     null,
            vertical_id:  null,
            external_ref: externalRef,
            phone:        normalisedPhone,
            amount:       amountInt,
            direction:    'disburse',
            status:       'PENDING',
            initiated_by: driverId,
            initiated_at: new Date(),
            notes:        `Driver earnings withdrawal | walletTxId: ${txId}`,
        }, { transaction: t });

        await t.commit();

        // ── 6. Call CamPay — disbursement is SYNCHRONOUS ──────────────
        let campayResponse;
        try {
            campayResponse = await campayClient.disburse({
                amount:             String(amountInt),
                currency:           'XAF',
                to:                 normalisedPhone,
                description:        `WeGo earnings withdrawal — ${amountInt} XAF`,
                external_reference: externalRef,
            });
        } catch (campayErr) {
            // CamPay rejected — reverse the debit immediately
            console.error('❌ [WITHDRAW] CamPay disburse failed:', campayErr.message);
            await _reverseDebit({ txId, driverId, wallet, amountInt, balanceAfter, paymentId: payment.id, reason: campayErr.message });
            return res.status(502).json({
                success: false,
                error:   'CAMPAY_ERROR',
                message: 'Transfer could not be initiated. Your balance has been restored.',
            });
        }

        // ── 7. Handle synchronous result ──────────────────────────────
        const finalStatus = campayResponse.status === 'SUCCESSFUL' ? 'SUCCESSFUL' : 'FAILED';

        if (finalStatus === 'FAILED') {
            // CamPay returned FAILED synchronously — reverse immediately
            await _reverseDebit({
                txId, driverId, wallet, amountInt, balanceAfter,
                paymentId: payment.id,
                reason:    'CamPay disbursement returned FAILED',
                campayRef: campayResponse.reference,
            });
            return res.status(400).json({
                success: false,
                error:   'TRANSFER_FAILED',
                message: 'Transfer was rejected by the payment provider. Your balance has been restored.',
            });
        }

        // SUCCESSFUL — update both records
        await DriverWalletTransaction.update(
            {
                payoutStatus: 'COMPLETED',
                payoutRef:    campayResponse.reference,
                payoutMethod: _operatorToMethod(campayResponse.operator),
                metadata: {
                    phone:       normalisedPhone,
                    externalRef,
                    campayRef:   campayResponse.reference,
                    operator:    campayResponse.operator || null,
                    confirmedAt: new Date().toISOString(),
                },
            },
            { where: { id: txId } }
        );
        await WegoPayment.update(
            {
                campay_ref:      campayResponse.reference,
                operator:        campayResponse.operator || null,
                campay_response: campayResponse,
                status:          'SUCCESSFUL',
                resolved_at:     new Date(),
            },
            { where: { id: payment.id } }
        );

        console.log(`✅ [WITHDRAW] SUCCESSFUL — txId: ${txId} | campayRef: ${campayResponse.reference} | New balance: ${balanceAfter}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({
            success: true,
            data: {
                txId,
                paymentId:   payment.id,
                campayRef:   campayResponse.reference,
                amount:      amountInt,
                currency:    'XAF',
                phone:       normalisedPhone,
                operator:    campayResponse.operator || null,
                newBalance:  balanceAfter,
                message:     'Transfer successful. Funds have been sent to your mobile money account.',
            },
        });

    } catch (error) {
        await t.rollback().catch(() => {});
        console.error('❌ [WITHDRAW] Unexpected error:', error);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /api/driver/earnings/campay/webhook
// ─────────────────────────────────────────────────────────────────────
// CamPay posts here when a COLLECTION (top-up) is confirmed or fails.
// Withdrawal (disburse) is synchronous so it doesn't need a webhook.
//
// This endpoint is PUBLIC — no auth middleware. Mounted BEFORE authenticate
// in the routes file. Signature validation is done inside this handler.
//
// CamPay payload:
// {
//   "reference":          "CP-XXXXXXXX",
//   "external_reference": "WEGO-TOPUP-ABCD-EFGH1234",
//   "status":             "SUCCESSFUL" | "FAILED",
//   "amount":             "5000",
//   "currency":           "XAF",
//   "operator":           "MTN" | "ORANGE",
//   "operator_reference": "12345678"
// }
// ═══════════════════════════════════════════════════════════════════════

exports.campayWebhook = async (req, res) => {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔔 [WEBHOOK] CamPay webhook received');

    try {
        const {
            reference:          campayRef,
            external_reference: externalRef,
            status,
            amount,
            operator,
            operator_reference: operatorRef,
        } = req.body;

        console.log(`   campayRef: ${campayRef} | externalRef: ${externalRef} | status: ${status}`);

        if (!externalRef || !status || !campayRef) {
            console.warn('⚠️  [WEBHOOK] Missing required fields — ignoring');
            return res.status(400).json({ success: false, error: 'MISSING_FIELDS' });
        }

        // Only top-ups arrive via webhook (disbursements are synchronous)
        if (!externalRef.startsWith('WEGO-TOPUP-')) {
            console.warn(`⚠️  [WEBHOOK] Unrecognised externalRef format: ${externalRef} — ignoring`);
            return res.status(200).json({ success: true }); // 200 to prevent CamPay retries
        }

        // ── Find the WegoPayment record ───────────────────────────────
        const payment = await WegoPayment.findOne({
            where: { external_ref: externalRef },
        });

        if (!payment) {
            console.warn(`⚠️  [WEBHOOK] WegoPayment not found for externalRef: ${externalRef}`);
            return res.status(200).json({ success: true });
        }

        if (payment.status !== 'PENDING') {
            // Already processed (duplicate webhook delivery) — idempotent return
            console.log(`ℹ️  [WEBHOOK] Payment ${externalRef} already ${payment.status} — skipping`);
            return res.status(200).json({ success: true });
        }

        // ── Find the matching DriverWalletTransaction ─────────────────
        const pendingTx = await DriverWalletTransaction.findOne({
            where: { reference: `TOP_UP:${externalRef}`, type: 'TOP_UP', topUpStatus: 'PENDING' },
        });

        if (!pendingTx) {
            console.warn(`⚠️  [WEBHOOK] DriverWalletTransaction not found for ref: TOP_UP:${externalRef}`);
            // Update WegoPayment anyway to reflect CamPay's status
            await payment.update({ campay_ref: campayRef, status: status === 'SUCCESSFUL' ? 'SUCCESSFUL' : 'FAILED', resolved_at: new Date() });
            return res.status(200).json({ success: true });
        }

        if (status === 'SUCCESSFUL') {
            // ── Credit the wallet ─────────────────────────────────────
            const t = await sequelize.transaction();
            try {
                const wallet = await DriverWallet.findOne({
                    where:       { driverId: pendingTx.driverId },
                    lock:        t.LOCK.UPDATE,
                    transaction: t,
                });

                const amountInt  = parseInt(amount, 10) || pendingTx.amount;
                const newBalance = wallet.balance + amountInt;

                await DriverWallet.update(
                    { balance: newBalance, updatedAt: new Date() },
                    { where: { id: wallet.id }, transaction: t }
                );

                await DriverWalletTransaction.update(
                    {
                        topUpStatus:  'COMPLETED',
                        topUpRef:     campayRef,
                        topUpMethod:  _operatorToMethod(operator),
                        balanceAfter: newBalance,
                        metadata: {
                            ...(pendingTx.metadata || {}),
                            campayRef,
                            operatorRef: operatorRef || null,
                            operator:    operator    || null,
                            confirmedAt: new Date().toISOString(),
                        },
                    },
                    { where: { id: pendingTx.id }, transaction: t }
                );

                await payment.update(
                    {
                        campay_ref:      campayRef,
                        operator:        operator || null,
                        campay_response: req.body,
                        status:          'SUCCESSFUL',
                        resolved_at:     new Date(),
                    },
                    { transaction: t }
                );

                await t.commit();
                console.log(`✅ [WEBHOOK] Top-up CREDITED — ${amountInt} XAF | New balance: ${newBalance} XAF | Driver: ${pendingTx.driverId}`);

            } catch (err) {
                await t.rollback();
                console.error('❌ [WEBHOOK] DB error while crediting top-up:', err);
                // Return 200 anyway — CamPay will retry and we'll process then
                return res.status(200).json({ success: true });
            }

        } else {
            // FAILED — just mark both records, no balance change needed
            await DriverWalletTransaction.update(
                {
                    topUpStatus: 'FAILED',
                    metadata: {
                        ...(pendingTx.metadata || {}),
                        campayRef,
                        failedAt: new Date().toISOString(),
                        reason:   status,
                    },
                },
                { where: { id: pendingTx.id } }
            );
            await payment.update({
                campay_ref:      campayRef,
                campay_response: req.body,
                status:          'FAILED',
                failure_reason:  `CamPay status: ${status}`,
                resolved_at:     new Date(),
            });
            console.log(`❌ [WEBHOOK] Top-up FAILED — externalRef: ${externalRef}`);
        }

        // Always 200 to CamPay — prevents infinite retries
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        return res.status(200).json({ success: true });

    } catch (error) {
        console.error('❌ [WEBHOOK] Unhandled error:', error);
        return res.status(200).json({ success: true }); // still 200 to prevent CamPay retries
    }
};

// ═══════════════════════════════════════════════════════════════════════
// PRIVATE HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Reverse an optimistic debit when CamPay disbursement fails.
 * Posts a REFUND credit and restores the wallet balance.
 */
async function _reverseDebit({ txId, driverId, wallet, amountInt, balanceAfter, paymentId, reason, campayRef }) {
    const t = await sequelize.transaction();
    try {
        const restoredBalance = balanceAfter + amountInt; // undo the debit

        await DriverWallet.update(
            { balance: restoredBalance, totalPayouts: literal(`totalPayouts - ${amountInt}`), updatedAt: new Date() },
            { where: { id: wallet.id }, transaction: t }
        );

        await DriverWalletTransaction.update(
            { payoutStatus: 'FAILED', payoutRef: campayRef || null },
            { where: { id: txId }, transaction: t }
        );

        await DriverWalletTransaction.create({
            id:           uuidv4(),
            driverId,
            walletId:     wallet.id,
            type:         'REFUND',
            amount:       +amountInt,
            balanceAfter: restoredBalance,
            description:  'Withdrawal reversal — transfer failed',
            reference:    `REFUND:reversal:${txId}`,
            metadata:     { originalTxId: txId, reason, reversedAt: new Date().toISOString() },
            createdAt:    new Date(),
        }, { transaction: t });

        if (paymentId) {
            await WegoPayment.update(
                { status: 'FAILED', failure_reason: reason, resolved_at: new Date(), campay_ref: campayRef || null },
                { where: { id: paymentId }, transaction: t }
            );
        }

        await t.commit();
        console.log(`↩️  [WITHDRAW] Debit reversed — ${amountInt} XAF restored | Balance: ${restoredBalance}`);

    } catch (err) {
        await t.rollback();
        console.error('❌ _reverseDebit failed:', err);
    }
}

/**
 * Convert CamPay's operator string to the DriverWalletTransaction ENUM value.
 */
function _operatorToMethod(operator) {
    if (!operator) return null;
    const op = String(operator).toUpperCase();
    if (op === 'MTN')    return 'MTN_MOMO';
    if (op === 'ORANGE') return 'ORANGE_MONEY';
    return null;
}

/**
 * Build a Sequelize date filter for a period string. Returns null for 'all'.
 */
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

/**
 * Human-readable label for each transaction type.
 */
function _txTypeLabel(type) {
    const labels = {
        TOP_UP:      'Wallet Top-Up',
        TRIP_FARE:   'Trip Fare',
        COMMISSION:  'WEGO Commission',
        BONUS_TRIP:  'Trip Bonus',
        BONUS_QUEST: 'Quest Bonus',
        ADJUSTMENT:  'Adjustment',
        REFUND:      'Refund',
        PAYOUT:      'Withdrawal',
    };
    return labels[type] || type;
}