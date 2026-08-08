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
const campayService    = require('../services/campay/campayService');
// Reuse the primary CamPay webhook's JWT signature check — do not reinvent it.
const { _validateSignature } = require('./payment/campayWebhook.controller');

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
// Must match driverTopUp.controller.js's MIN_TOPUP_XAF — both endpoints write
// to the same DriverWallet/DriverWalletTransaction tables for the same feature.
const MIN_TOPUP_AMOUNT      = parseInt(process.env.MIN_TOPUP_XAF || '25', 10);    // XAF
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
            operator_reference: operatorRef,
        } = req.body;

        console.log(`   campayRef: ${campayRef} | externalRef: ${externalRef} | status: ${status}`);

        if (!externalRef || !status || !campayRef) {
            console.warn('⚠️  [WEBHOOK] Missing required fields — ignoring');
            return res.status(400).json({ success: false, error: 'MISSING_FIELDS' });
        }

        // ── Authenticate the webhook ───────────────────────────────────
        // Same JWT-in-payload check used by the primary CamPay webhook
        // (fails closed in production). Never trust an unsigned/mis-signed
        // request — this is what previously let anyone POST a fabricated
        // {status:'SUCCESSFUL'} straight to this endpoint and self-credit.
        if (!_validateSignature(req.body)) {
            console.error('🚨 [WEBHOOK] Rejected — invalid/missing signature. Possible spoofed request.');
            return res.status(200).json({ success: true }); // 200 so CamPay doesn't hammer retries
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
            return res.status(200).json({ success: true });
        }

        // ── Independent re-verification — never trust req.body.status/amount ──
        // Re-query CamPay's own status-check API for the authoritative outcome,
        // exactly like the primary webhook does. A forged webhook payload can no
        // longer credit a wallet: only what CamPay itself confirms is trusted.
        const reference = payment.campay_ref || campayRef;
        let authoritative;
        try {
            authoritative = await campayService.checkStatus(reference);
        } catch (err) {
            console.error(`❌ [WEBHOOK] Could not re-verify ${reference} with CamPay — NOT finalizing:`, err.message);
            return res.status(200).json({ success: true }); // leave PENDING; retry later
        }

        const campayStatus = authoritative.status;
        if (campayStatus === 'PENDING') {
            console.log(`ℹ️  [WEBHOOK] CamPay still reports ${reference} as PENDING — ignoring premature webhook.`);
            return res.status(200).json({ success: true });
        }

        const newStatus = campayStatus === 'SUCCESSFUL' ? 'SUCCESSFUL' : 'FAILED';
        const operator   = authoritative.operator || null;

        if (newStatus === 'SUCCESSFUL') {
            // ── Amount verification — only meaningful on success ───────────────
            const paidAmount = Math.round(Number(authoritative.amount));
            if (!Number.isFinite(paidAmount) || paidAmount !== pendingTx.amount) {
                console.error(
                    `🚨 [WEBHOOK] AMOUNT MISMATCH for ${externalRef} — ` +
                    `expected ${pendingTx.amount} XAF, CamPay reports ${authoritative.amount}. Refusing to credit.`
                );
                await DriverWalletTransaction.update(
                    { topUpStatus: 'FAILED', metadata: { ...(pendingTx.metadata || {}), reason: 'amount_mismatch' } },
                    { where: { id: pendingTx.id } }
                ).catch(() => {});
                await payment.update({
                    campay_ref:      reference,
                    campay_response: authoritative,
                    status:          'FAILED',
                    failure_reason:  `amount_mismatch: expected ${pendingTx.amount}, got ${authoritative.amount}`,
                    resolved_at:     new Date(),
                }).catch(() => {});
                return res.status(200).json({ success: true });
            }

            // ── Credit the wallet ─────────────────────────────────────
            // Stamp CamPay's authoritative response onto the in-memory payment
            // object — finalizeDriverTopUp() persists it itself via its own
            // locked/conditional WegoPayment claim (see that function).
            payment.campay_ref      = reference;
            payment.operator        = operator;
            payment.campay_response = authoritative;
            payment.resolved_at     = new Date();

            let result;
            try {
                result = await exports.finalizeDriverTopUp(payment, { operatorRef });
            } catch (err) {
                console.error('❌ [WEBHOOK] DB error while crediting top-up:', err);
                // Return 200 anyway — CamPay will retry and we'll process then
                return res.status(200).json({ success: true });
            }

            if (result.credited) {
                console.log(`✅ [WEBHOOK] Top-up CREDITED — ${result.amount} XAF | New balance: ${result.newBalance} XAF | Driver: ${result.driverId}`);
            } else {
                console.log(`ℹ️  [WEBHOOK] Top-up not credited (${result.reason}) for ${externalRef} — likely already finalized concurrently.`);
            }

        } else {
            // FAILED — just mark both records, no balance change needed
            await DriverWalletTransaction.update(
                {
                    topUpStatus: 'FAILED',
                    metadata: {
                        ...(pendingTx.metadata || {}),
                        campayRef:   reference,
                        failedAt:    new Date().toISOString(),
                        reason:      campayStatus,
                    },
                },
                { where: { id: pendingTx.id } }
            );
            await payment.update({
                campay_ref:      reference,
                campay_response: authoritative,
                status:          'FAILED',
                failure_reason:  `CamPay status: ${campayStatus}`,
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
// finalizeDriverTopUp(payment, opts)
// ─────────────────────────────────────────────────────────────────────
// The ONE place that actually credits a driver's wallet for a TOP_UP.
// Called from two places:
//   1. exports.campayWebhook (above) — the direct CamPay webhook delivery.
//   2. campayWebhook.controller.js's _finalizeFromPoll — the reconciliation
//      cron's backstop for a payment whose direct webhook never arrived, or
//      whose CamPay re-verification call transiently failed. Without this
//      shared path, such a payment would end up with WegoPayment.status =
//      'SUCCESSFUL' forever while the driver's wallet is never credited.
//
// `payment` must be a WegoPayment whose authoritative CamPay status is
// already known to be SUCCESSFUL — this function does not re-query CamPay
// itself; each caller is responsible for that independent verification.
//
// Fully ACID + idempotent, mirroring campayWebhook.controller.js's
// _finalizeFleetTopUp: the authoritative "already credited?" gate is a row
// lock + status recheck on the DriverWalletTransaction itself, so a
// duplicate/concurrent call — two webhook deliveries, or a webhook racing
// the poll finalizer — is always a safe no-op, never a double credit.
//
// @returns {{ credited: boolean, reason?: string, driverId?, amount?, newBalance?, txId? }}
// ═══════════════════════════════════════════════════════════════════════

exports.finalizeDriverTopUp = async function finalizeDriverTopUp(payment, opts = {}) {
    const pendingTx = await DriverWalletTransaction.findOne({
        where: { reference: `TOP_UP:${payment.external_ref}`, type: 'TOP_UP' },
    });

    if (!pendingTx) {
        console.warn(`⚠️  [TOPUP-FINALIZE] No DriverWalletTransaction found for payment ${payment.id} (${payment.external_ref})`);
        return { credited: false, reason: 'transaction-not-found' };
    }

    const t = await sequelize.transaction();
    try {
        // ── 1. Lock + recheck the pending transaction ──────────────────
        // The authoritative "has this already been credited" gate. Two
        // concurrent callers (duplicate webhook deliveries, or a webhook
        // racing the poll finalizer) both try to lock this same row; only
        // the first proceeds — the second, once unblocked, sees topUpStatus
        // no longer PENDING and safely no-ops.
        const lockedTx = await DriverWalletTransaction.findOne({
            where:       { id: pendingTx.id },
            lock:        t.LOCK.UPDATE,
            transaction: t,
        });

        if (!lockedTx || lockedTx.topUpStatus !== 'PENDING') {
            await t.rollback();
            console.log(`ℹ️  [TOPUP-FINALIZE] Transaction ${pendingTx.id} already ${lockedTx?.topUpStatus || 'missing'} — skipping duplicate.`);
            return { credited: false, reason: 'already-finalized' };
        }

        // ── 2. Conditionally claim the WegoPayment row ──────────────────
        // Accepts PENDING (direct-webhook path — not yet flipped) or
        // SUCCESSFUL (poll path — runReconciliation already flipped it,
        // atomically, before ever calling us; that's expected, not a
        // collision). Refuses a terminal FAILED/EXPIRED row outright —
        // crediting then would contradict our own bookkeeping about
        // whether this payment actually succeeded.
        const campayRef      = payment.campay_ref || lockedTx.topUpRef || null;
        const paymentUpdate  = {
            status:      'SUCCESSFUL',
            resolved_at: payment.resolved_at || new Date(),
        };
        if (campayRef)               paymentUpdate.campay_ref      = campayRef;
        if (payment.operator)        paymentUpdate.operator        = payment.operator;
        if (payment.campay_response) paymentUpdate.campay_response = payment.campay_response;

        const [payAffected] = await WegoPayment.update(paymentUpdate, {
            where:       { id: payment.id, status: { [Op.in]: ['PENDING', 'SUCCESSFUL'] } },
            transaction: t,
        });

        if (payAffected === 0) {
            await t.rollback();
            console.warn(`⚠️  [TOPUP-FINALIZE] WegoPayment ${payment.id} not in a finalizable state — refusing to credit.`);
            return { credited: false, reason: 'payment-not-finalizable' };
        }

        // ── 3. Credit the wallet ─────────────────────────────────────
        const wallet = await DriverWallet.findOne({
            where:       { id: lockedTx.walletId },
            lock:        t.LOCK.UPDATE,
            transaction: t,
        });

        if (!wallet) {
            await t.rollback();
            console.error(`❌ [TOPUP-FINALIZE] Wallet ${lockedTx.walletId} not found for transaction ${lockedTx.id}`);
            return { credited: false, reason: 'wallet-not-found' };
        }

        const amountInt  = parseInt(lockedTx.amount, 10);
        const newBalance = (parseInt(wallet.balance, 10) || 0) + amountInt;

        await DriverWallet.update(
            { balance: newBalance, updatedAt: new Date() },
            { where: { id: wallet.id }, transaction: t }
        );

        await DriverWalletTransaction.update(
            {
                topUpStatus:  'COMPLETED',
                topUpRef:     campayRef || lockedTx.topUpRef,
                topUpMethod:  _operatorToMethod(payment.operator) || lockedTx.topUpMethod,
                balanceAfter: newBalance,
                metadata: {
                    ...(lockedTx.metadata || {}),
                    campayRef:   campayRef || null,
                    operatorRef: opts.operatorRef || null,
                    operator:    payment.operator || null,
                    confirmedAt: new Date().toISOString(),
                },
            },
            { where: { id: lockedTx.id }, transaction: t }
        );

        await t.commit();

        console.log(`✅ [TOPUP-FINALIZE] Top-up CREDITED — ${amountInt} XAF | New balance: ${newBalance} XAF | Driver: ${lockedTx.driverId}`);

        return {
            credited: true,
            driverId: lockedTx.driverId,
            amount:   amountInt,
            newBalance,
            txId:     lockedTx.id,
        };

    } catch (err) {
        await t.rollback().catch(() => {});
        console.error('❌ [TOPUP-FINALIZE] DB error while crediting top-up:', err);
        throw err;
    }
};

// ═══════════════════════════════════════════════════════════════════════
// PRIVATE HELPERS
// ═══════════════════════════════════════════════════════════════════════


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