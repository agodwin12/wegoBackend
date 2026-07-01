// src/services/delivery/deliveryBonusService.js
//
// ═══════════════════════════════════════════════════════════════════════════════
// DELIVERY BONUS / QUEST ENGINE
// ═══════════════════════════════════════════════════════════════════════════════
//
// The delivery-side twin of earningsEngineService's quest logic. After an agent
// completes a delivery we check every active DELIVERY / BOTH bonus program and,
// if the agent just crossed a milestone (e.g. "10 deliveries today"), we credit
// the reward straight into their DeliveryWallet and push-notify them.
//
// Idempotency: bonus_awards has UNIQUE(driverId, programId, periodKey). A retry
// or a race throws SequelizeUniqueConstraintError, which we swallow — the agent
// is never paid a milestone twice in the same period.
//
// Money model: this is a wallet TOP-UP (WeGo funds the reward). It mirrors how
// ride quests reload the driver wallet, exactly as the product requires.
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const { Op, fn, col } = require('sequelize');
const {
    sequelize,
    BonusProgram,
    BonusAward,
    Delivery,
    Driver,
    DeliveryWallet,
    DeliveryWalletTransaction,
} = require('../../models');

const getNotificationService = () => require('../NotificationService');

// ── Which program types measure count vs earnings ─────────────────────────────
const COUNT_TYPES    = ['DAILY_TRIPS', 'WEEKLY_TRIPS', 'MONTHLY_TRIPS', 'LIFETIME_TRIPS'];
const EARNINGS_TYPES = ['DAILY_EARNINGS', 'WEEKLY_EARNINGS', 'MONTHLY_EARNINGS'];

function periodStart(period, now = new Date()) {
    const d = new Date(now);
    if (period === 'DAILY')   { d.setUTCHours(0, 0, 0, 0); return d; }
    if (period === 'WEEKLY')  { const day = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() - day + 1); d.setUTCHours(0, 0, 0, 0); return d; }
    if (period === 'MONTHLY') { d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0); return d; }
    return new Date(0); // LIFETIME
}

async function loadActiveDeliveryPrograms() {
    const today = new Date().toISOString().split('T')[0];
    return BonusProgram.findAll({
        where: {
            isActive: true,
            vertical: { [Op.in]: ['DELIVERY', 'BOTH'] },
            [Op.and]: [
                { [Op.or]: [{ validFrom: null }, { validFrom: { [Op.lte]: today } }] },
                { [Op.or]: [{ validTo:   null }, { validTo:   { [Op.gte]: today } }] },
            ],
        },
    });
}

// Count the agent's metric for a program in its current period.
async function countMetric(program, driverId, transaction) {
    if (program.type === 'LIFETIME_TRIPS') {
        return Delivery.count({ where: { driver_id: driverId, status: 'delivered' }, transaction });
    }
    const start = periodStart(program.period);
    const base  = { driver_id: driverId, status: 'delivered', delivered_at: { [Op.gte]: start } };

    if (COUNT_TYPES.includes(program.type)) {
        return Delivery.count({ where: base, transaction });
    }
    if (EARNINGS_TYPES.includes(program.type)) {
        const sum = await Delivery.sum('driver_payout', { where: base, transaction });
        return Math.round(sum || 0);
    }
    return 0;
}

// Evaluate one program for one delivery; returns the award (or null).
// NOTE: bonus_awards.driverId FKs to accounts(uuid), so awards key on the
// agent's ACCOUNT uuid, while deliveries/wallet key on Driver.id.
async function evaluateProgram(program, delivery, accountUuid, wallet, transaction) {
    const periodKey = BonusProgram.getPeriodKey(program.period);

    const existing = await BonusAward.findOne({
        where: { driverId: accountUuid, programId: program.id, periodKey },
        transaction,
    });
    if (existing) return null;

    const metric = await countMetric(program, delivery.driver_id, transaction);
    if (metric < program.targetValue) return null;

    // Milestone hit — create the award (UNIQUE constraint = idempotency guard).
    const award = await BonusAward.create({
        driverId:      accountUuid,
        programId:     program.id,
        periodKey,
        awardedAmount: program.bonusAmount,
        metricAtAward: metric,
        awardedAt:     new Date(),
    }, { transaction });

    const balanceBefore = parseFloat(wallet.balance);
    const balanceAfter  = balanceBefore + program.bonusAmount;

    const txn = await DeliveryWalletTransaction.create({
        wallet_id:      wallet.id,
        delivery_id:    delivery.id,
        type:           'bonus_quest',
        payment_method: 'system',
        amount:         program.bonusAmount,
        balance_before: balanceBefore,
        balance_after:  balanceAfter,
        notes:          `${program.iconEmoji || '🏆'} ${program.name} — ${periodKey}`,
    }, { transaction });

    await wallet.increment(
        { balance: program.bonusAmount, total_bonuses: program.bonusAmount },
        { transaction }
    );
    await wallet.reload({ transaction });

    await BonusAward.update(
        { walletTransactionId: txn.id },
        { where: { id: award.id }, transaction }
    );

    return { program, awardedAmount: program.bonusAmount, metric, newBalance: balanceAfter };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC: evaluate + award all delivery bonus programs for a completed delivery
// Safe to call fire-and-forget. Never throws to the caller.
// ═══════════════════════════════════════════════════════════════════════════════
async function evaluateAndAward(deliveryId, io = null) {
    try {
        const programs = await loadActiveDeliveryPrograms();
        if (!programs.length) return [];

        const delivery = await Delivery.findByPk(deliveryId);
        if (!delivery || !delivery.driver_id) return [];

        // Awards key on the agent's account uuid (FK target); skip if unknown.
        const driver = await Driver.findByPk(delivery.driver_id, { attributes: ['id', 'userId'] });
        const agentUuid = driver?.userId;
        if (!agentUuid) return [];

        const awards = [];

        for (const program of programs) {
            const t = await sequelize.transaction();
            try {
                const wallet = await DeliveryWallet.findOne({
                    where: { driver_id: delivery.driver_id },
                    transaction: t,
                    lock: t.LOCK.UPDATE,
                });
                if (!wallet) { await t.rollback(); continue; }

                const result = await evaluateProgram(program, delivery, agentUuid, wallet, t);
                await t.commit();
                if (result) awards.push(result);
            } catch (err) {
                await t.rollback();
                if (err.name !== 'SequelizeUniqueConstraintError') {
                    console.error(`❌ [DELIVERY BONUS] program "${program.name}" failed:`, err.message);
                }
            }
        }

        // Notify the agent for each milestone hit (after commit).
        if (awards.length) {
            for (const a of awards) {
                console.log(`🏆 [DELIVERY BONUS] ${delivery.driver_id} earned ${a.awardedAmount} XAF (${a.program.name})`);
                if (agentUuid) {
                    getNotificationService().send({
                        accountUuid: agentUuid,
                        type:        'DELIVERY_BONUS_EARNED',
                        title:       `${a.program.iconEmoji || '🏆'} Bonus earned!`,
                        body:        `You hit "${a.program.name}" and earned ${a.awardedAmount} XAF — added to your wallet.`,
                        data:        { screen: 'delivery_wallet', amount: String(a.awardedAmount) },
                    }).catch(e => console.warn('⚠️  [DELIVERY BONUS] push failed:', e.message));
                }
                // Real-time wallet nudge if the agent is connected.
                if (io && agentUuid) {
                    io.to(`user:${agentUuid}`).emit('delivery:bonus_earned', {
                        program: a.program.name,
                        amount:  a.awardedAmount,
                        newBalance: a.newBalance,
                    });
                }
            }
        }

        return awards;
    } catch (err) {
        console.error('❌ [DELIVERY BONUS] evaluateAndAward error:', err.message);
        return [];
    }
}

module.exports = { evaluateAndAward };
