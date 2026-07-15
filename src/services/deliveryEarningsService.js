// src/services/deliveryEarningsService.js
//
// Handles all delivery wallet operations:
// - Auto-create wallet for new delivery agents
// - Post earnings when delivery is completed
// - Handle cash vs digital payment flows
// - Process cashout requests

'use strict';

const { Op } = require('sequelize');
const {
    DeliveryWallet,
    DeliveryWalletTransaction,
    Delivery,
    sequelize,
} = require('../models');

// ═══════════════════════════════════════════════════════════════════════════════
// WALLET MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get or create a wallet for a driver.
 * Called automatically on first delivery completion.
 * @param {string} driverId - Driver.id (UUID)
 * @returns {DeliveryWallet}
 */
async function getOrCreateWallet(driverId) {
    const [wallet] = await DeliveryWallet.findOrCreate({
        where:    { driver_id: driverId },
        defaults: {
            driver_id:             driverId,
            balance:               0.00,
            total_earned:          0.00,
            total_cash_collected:  0.00,
            total_commission_owed: 0.00,
            total_commission_paid: 0.00,
            total_withdrawn:       0.00,
            pending_withdrawal:    0.00,
            status:                'active',
        },
    });
    return wallet;
}

/**
 * Get wallet for a driver (returns null if not found).
 * @param {string} driverId
 */
async function getWallet(driverId) {
    return DeliveryWallet.findOne({ where: { driver_id: driverId } });
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST EARNINGS WHEN DELIVERY IS COMPLETED
// Called from delivery.controller.js when status transitions to 'delivered'
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Post earnings for a completed delivery.
 * Handles both digital (MTN/Orange) and cash payment flows.
 *
 * Retries up to MAX_RETRIES times on optimistic lock conflict.
 * This prevents the race condition between confirmCommission and
 * postDeliveryEarnings both updating the wallet row simultaneously.
 *
 * Digital flow:
 *   1. Credit driver_payout → balance
 *   2. Log delivery_earning transaction
 *   3. Log commission_deduction transaction (informational)
 *
 * Cash flow:
 *   1. Log cash_collected transaction (agent physically has this money)
 *   2. Log cash_commission_owed transaction (agent owes WEGO their cut)
 *   3. balance does NOT increase — agent holds the cash
 *
 * @param {number} deliveryId
 * @param {object} [options]
 * @param {Transaction} [options.transaction] - Sequelize transaction to join
 */
async function postDeliveryEarnings(deliveryId, options = {}) {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 200;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await _postDeliveryEarningsOnce(deliveryId, options);
        } catch (error) {
            const isConflict =
                error.message?.includes('Record has changed since last read') ||
                error.name === 'OptimisticLockError' ||
                error.message?.includes('optimistic lock');

            if (isConflict && attempt < MAX_RETRIES) {
                console.warn(`⚠️ [DELIVERY EARNINGS] Optimistic lock conflict on attempt ${attempt}/${MAX_RETRIES} for delivery ${deliveryId} — retrying in ${RETRY_DELAY_MS * attempt}ms`);
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * attempt));
                continue;
            }

            // Not a lock conflict, or out of retries — rethrow
            throw error;
        }
    }
}

async function _postDeliveryEarningsOnce(deliveryId, options = {}) {
    const t = options.transaction || await sequelize.transaction();
    const ownTransaction = !options.transaction;

    try {
        // ── Fetch delivery ────────────────────────────────────────────────────
        const delivery = await Delivery.findByPk(deliveryId, { transaction: t });

        if (!delivery) {
            throw new Error(`Delivery ${deliveryId} not found`);
        }
        if (!delivery.driver_id) {
            throw new Error(`Delivery ${deliveryId} has no driver assigned`);
        }

        const driverPayout     = parseFloat(delivery.driver_payout     || 0);
        const commissionAmount = parseFloat(delivery.commission_amount  || 0);
        const totalPrice       = parseFloat(delivery.total_price        || 0);
        const paymentMethod    = delivery.payment_method;
        const isCash           = paymentMethod === 'cash';

        // ── Get or create wallet ──────────────────────────────────────────────
        const [wallet] = await DeliveryWallet.findOrCreate({
            where:    { driver_id: delivery.driver_id },
            defaults: {
                driver_id:             delivery.driver_id,
                balance:               0.00,
                total_earned:          0.00,
                total_cash_collected:  0.00,
                total_commission_owed: 0.00,
                total_commission_paid: 0.00,
                total_withdrawn:       0.00,
                pending_withdrawal:    0.00,
                status:                'active',
            },
            transaction: t,
        });

        if (wallet.status === 'frozen' || wallet.status === 'suspended') {
            console.warn(`⚠️ [DELIVERY EARNINGS] Wallet ${wallet.id} is ${wallet.status} — earnings still recorded but flagged`);
        }

        // ── Re-fetch wallet with fresh data to avoid stale reads ─────────────
        // This is the key fix — always read the latest version inside the
        // transaction rather than relying on the findOrCreate snapshot.
        await wallet.reload({ transaction: t });
        const balanceBefore = parseFloat(wallet.balance);

        if (isCash) {
            // ── CASH PAYMENT FLOW ─────────────────────────────────────────────
            await DeliveryWalletTransaction.create({
                wallet_id:      wallet.id,
                delivery_id:    deliveryId,
                type:           'cash_collected',
                payment_method: 'cash',
                amount:         totalPrice,
                balance_before: balanceBefore,
                balance_after:  balanceBefore,
                notes:          `Cash collected for delivery ${delivery.delivery_code}`,
            }, { transaction: t });

            await DeliveryWalletTransaction.create({
                wallet_id:      wallet.id,
                delivery_id:    deliveryId,
                type:           'cash_commission_owed',
                payment_method: 'cash',
                amount:         commissionAmount,
                balance_before: balanceBefore,
                balance_after:  balanceBefore,
                notes:          `WEGO commission owed (cash) for ${delivery.delivery_code}`,
            }, { transaction: t });

            await wallet.increment({
                total_cash_collected:  totalPrice,
                total_commission_owed: commissionAmount,
            }, { transaction: t });

            console.log(`💵 [DELIVERY EARNINGS] Cash delivery ${delivery.delivery_code}: collected ${totalPrice} XAF, owes ${commissionAmount} XAF commission`);

        } else {
            // ── DIGITAL PAYMENT FLOW (MTN / Orange Money) ─────────────────────
            // Money model: the agent collects the fare DIRECTLY from the
            // customer (their own MoMo/OM) — exactly like cash, and like
            // ride-hailing ("fares direct-to-driver"). WeGo never holds this
            // money, so the spendable wallet balance is NOT credited the payout.
            //
            // The ONLY balance change for a completed delivery is the WeGo
            // commission, taken from the pre-paid wallet by confirmCommission().
            // Here we just record the earning for the agent's history — with
            // balance unchanged — and update the lifetime gross-earnings stat.
            // (We do NOT write a commission_deduction row here; confirmCommission
            //  writes the authoritative, balance-changing one.)
            await DeliveryWalletTransaction.create({
                wallet_id:      wallet.id,
                delivery_id:    deliveryId,
                type:           'delivery_earning',
                payment_method: paymentMethod,
                amount:         driverPayout,
                balance_before: balanceBefore,
                balance_after:  balanceBefore,   // informational — paid directly, not via wallet
                notes:          `Earning collected directly for delivery ${delivery.delivery_code}`,
            }, { transaction: t });

            // Lifetime gross-earnings stat only — does NOT touch the spendable
            // balance (that money is in the agent's own MoMo, not the wallet).
            await wallet.increment({
                total_earned: driverPayout,
            }, { transaction: t });

            console.log(`💳 [DELIVERY EARNINGS] Digital delivery ${delivery.delivery_code}: agent collected ${driverPayout} XAF directly (WeGo commission ${commissionAmount} XAF taken from wallet)`);
        }

        if (ownTransaction) await t.commit();
        return { success: true, wallet };

    } catch (error) {
        if (ownTransaction) await t.rollback();
        console.error('❌ [DELIVERY EARNINGS] postDeliveryEarnings error:', error.message);
        throw error;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — SETTLE CASH COMMISSION
// Agent pays WEGO their commission from cash deliveries
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Record that an agent has paid their cash delivery commission to WEGO.
 * @param {string} driverId
 * @param {number} amount
 * @param {number} employeeId
 * @param {string} [notes]
 */
async function settleCashCommission(driverId, amount, employeeId, notes) {
    const t = await sequelize.transaction();

    try {
        const wallet = await DeliveryWallet.findOne({ where: { driver_id: driverId }, transaction: t });
        if (!wallet) throw new Error('Wallet not found');

        const outstanding = wallet.total_commission_owed - wallet.total_commission_paid;
        if (amount > outstanding) {
            throw new Error(`Amount exceeds outstanding commission (${outstanding.toLocaleString()} XAF)`);
        }

        const balanceBefore = wallet.balance;

        await DeliveryWalletTransaction.create({
            wallet_id:              wallet.id,
            delivery_id:            null,
            type:                   'cash_commission_paid',
            payment_method:         'cash',
            amount,
            balance_before:         balanceBefore,
            balance_after:          balanceBefore,
            notes:                  notes || `Cash commission settlement by agent`,
            created_by_employee_id: employeeId,
        }, { transaction: t });

        await wallet.increment({ total_commission_paid: amount }, { transaction: t });

        await t.commit();
        console.log(`💰 [DELIVERY EARNINGS] Cash commission settled: ${amount.toLocaleString()} XAF by driver ${driverId}`);
        return { success: true };

    } catch (error) {
        await t.rollback();
        throw error;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
    getOrCreateWallet,
    getWallet,
    postDeliveryEarnings,
    settleCashCommission,
};