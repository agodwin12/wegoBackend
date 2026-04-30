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
//   GET /api/driver/earnings/summary    → balance + period breakdowns
//   GET /api/driver/earnings/trips      → paginated trip receipts
//   GET /api/driver/earnings/activity   → wallet transaction ledger
//   GET /api/driver/earnings/quests     → active programs + progress
//
// ═══════════════════════════════════════════════════════════════════════

'use strict';

const { Op }         = require('sequelize');
const earningsEngine = require('../services/earningsEngineService');

const {
    TripReceipt,
    DriverWallet,
    DriverWalletTransaction,
    BonusProgram,
    BonusAward,
    EarningRule,
    Trip,
} = require('../models');

// ── All valid transaction types (kept in sync with DriverWalletTransaction ENUM) ──
// TOP_UP is first because it's now the most common entry for new drivers.
const ALL_TX_TYPES = [
    'TOP_UP',
    'TRIP_FARE',
    'COMMISSION',
    'BONUS_TRIP',
    'BONUS_QUEST',
    'ADJUSTMENT',
    'REFUND',
    'PAYOUT',
];

// ═══════════════════════════════════════════════════════════════════════
// GET /api/driver/earnings/summary
// ─────────────────────────────────────────────────────────────────────
// Returns the driver's wallet balance + today/week/month breakdowns.
// This is the main screen data for the earnings dashboard in the app.
// ═══════════════════════════════════════════════════════════════════════

exports.getSummary = async (req, res, next) => {
    try {
        const driverId = req.user.uuid; // ← always from JWT, never from body

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('💰 [EARNINGS] getSummary — Driver:', driverId);

        const summary = await earningsEngine.getWalletSummary(driverId);

        if (!summary) {
            // Driver has no wallet yet — return a clean zero state.
            // This is normal for new drivers who haven't topped up or completed a trip.
            console.log('ℹ️  [EARNINGS] No wallet found — returning empty summary');
            return res.status(200).json({
                success: true,
                data: {
                    balance:         0,
                    totalTopUps:     0,   // ← pre-paid credits ever deposited
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
                // ── Pre-paid top-up lifetime total ─────────────────────
                // Separate from totalEarned so the driver can see how much
                // they funded vs how much they actually earned from trips.
                totalTopUps:     summary.totalTopUps     ?? 0,
                lastTopUpAt:     summary.lastTopUpAt     ?? null,
                // ── Trip earnings ──────────────────────────────────────
                totalEarned:     summary.totalEarned,
                totalCommission: summary.totalCommission,
                totalBonuses:    summary.totalBonuses,
                totalPayouts:    summary.totalPayouts,
                currency:        summary.currency,
                walletStatus:    summary.status,
                lastPayoutAt:    summary.lastPayoutAt,
                // ── Period breakdowns ──────────────────────────────────
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
// Paginated list of trip receipts for the driver.
// Each receipt shows the full breakdown: fare, commission, bonuses, net.
// Used in the "Trips" tab of the earnings screen.
//
// Query params:
//   page    (default: 1)
//   limit   (default: 20, max: 50)
//   period  (today | week | month | all — default: week)
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
// Paginated wallet transaction ledger — every credit and debit.
// Used in the "Activity" tab of the earnings screen.
// Shows the driver exactly where every XAF came from or went.
//
// Query params:
//   page    (default: 1)
//   limit   (default: 30, max: 100)
//   type    (TOP_UP | TRIP_FARE | COMMISSION | BONUS_TRIP | BONUS_QUEST |
//            PAYOUT | ADJUSTMENT | REFUND | all — default: all)
//   period  (today | week | month | all — default: all)
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

        const where = { driverId };

        const dateFilter = _buildDateFilter(period);
        if (dateFilter) where.createdAt = dateFilter;

        // ── Type filter — now includes TOP_UP ─────────────────────────
        // ALL_TX_TYPES is the single source of truth for valid type names.
        // Using it here means adding a new type to the ENUM automatically
        // makes it filterable here without touching this code again.
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
            amount:       tx.amount,        // signed — positive = credit, negative = debit
            balanceAfter: tx.balanceAfter,
            description:  tx.description,
            tripId:       tx.tripId    || null,
            receiptId:    tx.receiptId || null,
            createdAt:    tx.createdAt,

            // ── PAYOUT-specific fields ─────────────────────────────────
            payoutMethod: tx.payoutMethod || null,
            payoutRef:    tx.payoutRef    || null,
            payoutStatus: tx.payoutStatus || null,

            // ── TOP_UP-specific fields ─────────────────────────────────
            // topUpMethod lets the activity feed show "MTN MoMo" / "Cash" etc.
            // alongside the top-up entry, matching how payoutMethod works for payouts.
            topUpMethod:  tx.topUpMethod  || null,
            topUpRef:     tx.topUpRef     || null,

            // ── Shared ────────────────────────────────────────────────
            metadata:     tx.metadata     || null,

            // ── UI helpers ────────────────────────────────────────────
            isCredit: tx.amount > 0,
            isDebit:  tx.amount < 0,
            label:    _txTypeLabel(tx.type),
        }));

        // ── Period aggregates (used for the summary bar in Flutter) ────
        const periodCredits = transactions
            .filter(tx => tx.amount > 0)
            .reduce((sum, tx) => sum + tx.amount, 0);
        const periodDebits  = transactions
            .filter(tx => tx.amount < 0)
            .reduce((sum, tx) => sum + tx.amount, 0);

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
// ─────────────────────────────────────────────────────────────────────
// Returns active bonus programs + the driver's current progress toward
// each one. Used for the "Quests" card in the driver app dashboard.
//
// Each program in the response includes:
//   - program definition (name, target, reward, period)
//   - current progress (metric value)
//   - isCompleted (already earned this period)
//   - progressPercent (for the progress bar UI)
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
            return res.status(200).json({
                success: true,
                data:    { quests: [] },
            });
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

        return res.status(200).json({
            success: true,
            data:    { quests },
        });

    } catch (error) {
        console.error('❌ [EARNINGS] getQuests error:', error);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// PRIVATE HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Build a Sequelize date filter object for a period string.
 * Returns null if period is 'all'.
 */
function _buildDateFilter(period) {
    const now        = new Date();
    const today      = new Date(now); today.setUTCHours(0, 0, 0, 0);
    const tomorrow   = new Date(today); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

    // Monday of this week
    const weekStart  = new Date(today);
    const day        = weekStart.getUTCDay() || 7;
    weekStart.setUTCDate(weekStart.getUTCDate() - day + 1);

    // First day of this month
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    switch (period) {
        case 'today': return { [Op.gte]: today, [Op.lt]: tomorrow };
        case 'week':  return { [Op.gte]: weekStart };
        case 'month': return { [Op.gte]: monthStart };
        default:      return null; // 'all' — no date filter
    }
}

/**
 * Human-readable label for each transaction type.
 * Returned as the `label` field on every transaction row.
 * Flutter uses this directly in the activity feed tile heading.
 */
function _txTypeLabel(type) {
    const labels = {
        TOP_UP:      'Wallet Top-Up',    // ← pre-paid credit
        TRIP_FARE:   'Trip Fare',
        COMMISSION:  'WEGO Commission',
        BONUS_TRIP:  'Trip Bonus',
        BONUS_QUEST: 'Quest Bonus',
        ADJUSTMENT:  'Adjustment',
        REFUND:      'Refund',
        PAYOUT:      'Payout',
    };
    return labels[type] || type;
}