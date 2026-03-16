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
    DeliveryPayoutRequest,
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

        const driverPayout      = parseFloat(delivery.driver_payout      || 0);
        const commissionAmount  = parseFloat(delivery.commission_amount   || 0);
        const totalPrice        = parseFloat(delivery.total_price         || 0);
        const paymentMethod     = delivery.payment_method;
        const isCash            = paymentMethod === 'cash';

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

        const balanceBefore = parseFloat(wallet.balance);

        if (isCash) {
            // ── CASH PAYMENT FLOW ─────────────────────────────────────────────
            // Agent physically collected totalPrice from sender
            // They owe WEGO commissionAmount
            // Their wallet balance does not change (they hold cash)

            // 1. Log cash_collected
            await DeliveryWalletTransaction.create({
                wallet_id:      wallet.id,
                delivery_id:    deliveryId,
                type:           'cash_collected',
                payment_method: 'cash',
                amount:         totalPrice,
                balance_before: balanceBefore,
                balance_after:  balanceBefore, // balance unchanged for cash
                notes:          `Cash collected for delivery ${delivery.delivery_code}`,
            }, { transaction: t });

            // 2. Log cash_commission_owed (creates a debt)
            await DeliveryWalletTransaction.create({
                wallet_id:      wallet.id,
                delivery_id:    deliveryId,
                type:           'cash_commission_owed',
                payment_method: 'cash',
                amount:         commissionAmount,
                balance_before: balanceBefore,
                balance_after:  balanceBefore, // balance unchanged — this is a debt record
                notes:          `WEGO commission owed (cash) for ${delivery.delivery_code}`,
            }, { transaction: t });

            // 3. Update wallet totals
            await wallet.increment({
                total_cash_collected:  totalPrice,
                total_commission_owed: commissionAmount,
            }, { transaction: t });

            console.log(`💵 [DELIVERY EARNINGS] Cash delivery ${delivery.delivery_code}: collected ${totalPrice} XAF, owes ${commissionAmount} XAF commission`);

        } else {
            // ── DIGITAL PAYMENT FLOW (MTN / Orange Money) ─────────────────────
            // driver_payout goes to balance
            // commission_amount is already deducted (informational log)

            const balanceAfter = balanceBefore + driverPayout;

            // 1. Credit driver payout to balance
            await DeliveryWalletTransaction.create({
                wallet_id:      wallet.id,
                delivery_id:    deliveryId,
                type:           'delivery_earning',
                payment_method: paymentMethod,
                amount:         driverPayout,
                balance_before: balanceBefore,
                balance_after:  balanceAfter,
                notes:          `Earning for delivery ${delivery.delivery_code}`,
            }, { transaction: t });

            // 2. Log commission deduction (informational — already excluded from driver_payout)
            await DeliveryWalletTransaction.create({
                wallet_id:      wallet.id,
                delivery_id:    deliveryId,
                type:           'commission_deduction',
                payment_method: paymentMethod,
                amount:         commissionAmount,
                balance_before: balanceAfter,
                balance_after:  balanceAfter, // already excluded — not a double deduction
                notes:          `WEGO commission (${((commissionAmount / totalPrice) * 100).toFixed(1)}%) for ${delivery.delivery_code}`,
            }, { transaction: t });

            // 3. Update wallet
            await wallet.increment({
                balance:      driverPayout,
                total_earned: driverPayout,
            }, { transaction: t });

            console.log(`💳 [DELIVERY EARNINGS] Digital delivery ${delivery.delivery_code}: +${driverPayout} XAF to wallet (commission: ${commissionAmount} XAF)`);
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
// CASHOUT — AGENT REQUESTS WITHDRAWAL
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Agent submits a cashout request.
 * Locks the amount in pending_withdrawal until admin processes it.
 *
 * @param {string} driverId
 * @param {number} amount
 * @param {'mtn_mobile_money'|'orange_money'} paymentMethod
 * @param {string} phoneNumber - MTN/Orange number to pay to
 * @param {string} [agentNotes]
 */
async function requestCashout(driverId, amount, paymentMethod, phoneNumber, agentNotes) {
    const t = await sequelize.transaction();

    try {
        const wallet = await DeliveryWallet.findOne({ where: { driver_id: driverId }, transaction: t });

        if (!wallet) {
            throw new Error('Wallet not found. Complete a delivery first.');
        }

        if (wallet.status !== 'active') {
            throw new Error(`Wallet is ${wallet.status}. Contact support.`);
        }

        const available = wallet.balance - wallet.pending_withdrawal;

        if (amount <= 0) {
            throw new Error('Amount must be greater than 0');
        }

        if (amount > available) {
            throw new Error(`Insufficient balance. Available: ${available.toLocaleString()} XAF`);
        }

        // Minimum cashout: 1,000 XAF
        if (amount < 1000) {
            throw new Error('Minimum cashout amount is 1,000 XAF');
        }

        // Check no pending request already exists
        const existing = await DeliveryPayoutRequest.findOne({
            where: { driver_id: driverId, status: 'pending' },
            transaction: t,
        });

        if (existing) {
            throw new Error(`You already have a pending cashout request (${existing.payout_code})`);
        }

        // Lock amount in pending
        await wallet.increment({ pending_withdrawal: amount }, { transaction: t });

        // Create request
        const request = await DeliveryPayoutRequest.create({
            payout_code:    DeliveryPayoutRequest.generatePayoutCode(),
            driver_id:      driverId,
            wallet_id:      wallet.id,
            amount,
            payment_method: paymentMethod,
            phone_number:   phoneNumber,
            status:         'pending',
            agent_notes:    agentNotes || null,
        }, { transaction: t });

        await t.commit();

        console.log(`📤 [DELIVERY EARNINGS] Cashout requested: ${request.payout_code} — ${amount.toLocaleString()} XAF by driver ${driverId}`);
        return request;

    } catch (error) {
        await t.rollback();
        console.error('❌ [DELIVERY EARNINGS] requestCashout error:', error.message);
        throw error;
    }
}

/**
 * Agent cancels their own pending cashout request.
 * @param {string} driverId
 * @param {number} requestId
 */
async function cancelCashout(driverId, requestId) {
    const t = await sequelize.transaction();

    try {
        const request = await DeliveryPayoutRequest.findOne({
            where: { id: requestId, driver_id: driverId },
            transaction: t,
        });

        if (!request) throw new Error('Cashout request not found');
        if (!request.canBeCancelled()) throw new Error('This request cannot be cancelled');

        // Release the locked amount
        const wallet = await DeliveryWallet.findByPk(request.wallet_id, { transaction: t });
        await wallet.decrement({ pending_withdrawal: request.amount }, { transaction: t });

        await request.update({ status: 'cancelled' }, { transaction: t });

        await t.commit();
        return { success: true };

    } catch (error) {
        await t.rollback();
        throw error;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — PROCESS CASHOUT REQUEST
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Admin approves and completes a cashout request.
 * @param {number} requestId
 * @param {number} employeeId
 * @param {string} [paymentReference] - MTN/Orange transaction reference
 * @param {string} [adminNotes]
 */
async function approveCashout(requestId, employeeId, paymentReference, adminNotes) {
    const t = await sequelize.transaction();

    try {
        const request = await DeliveryPayoutRequest.findByPk(requestId, { transaction: t });
        if (!request) throw new Error('Cashout request not found');

        if (!['pending', 'processing'].includes(request.status)) {
            throw new Error(`Cannot approve a ${request.status} request`);
        }

        const wallet       = await DeliveryWallet.findByPk(request.wallet_id, { transaction: t });
        const balanceBefore = wallet.balance;
        const balanceAfter  = balanceBefore - request.amount;

        if (balanceAfter < 0) {
            throw new Error('Insufficient wallet balance to process this payout');
        }

        // Create withdrawal transaction
        const txn = await DeliveryWalletTransaction.create({
            wallet_id:             wallet.id,
            delivery_id:           null,
            type:                  'withdrawal',
            payment_method:        request.payment_method,
            amount:                request.amount,
            balance_before:        balanceBefore,
            balance_after:         balanceAfter,
            notes:                 `Cashout ${request.payout_code}${paymentReference ? ` — ref: ${paymentReference}` : ''}`,
            created_by_employee_id: employeeId,
        }, { transaction: t });

        // Deduct from wallet
        await wallet.update({
            balance:            balanceAfter,
            total_withdrawn:    wallet.total_withdrawn + request.amount,
            pending_withdrawal: Math.max(0, wallet.pending_withdrawal - request.amount),
        }, { transaction: t });

        // Mark request completed
        await request.update({
            status:            'completed',
            processed_by:      employeeId,
            processed_at:      new Date(),
            completed_at:      new Date(),
            payment_reference: paymentReference || null,
            admin_notes:       adminNotes || null,
            transaction_id:    txn.id,
        }, { transaction: t });

        await t.commit();

        console.log(`✅ [DELIVERY EARNINGS] Cashout approved: ${request.payout_code} — ${request.amount.toLocaleString()} XAF`);
        return { success: true, request, transaction: txn };

    } catch (error) {
        await t.rollback();
        console.error('❌ [DELIVERY EARNINGS] approveCashout error:', error.message);
        throw error;
    }
}

/**
 * Admin rejects a cashout request (releases the locked amount).
 * @param {number} requestId
 * @param {number} employeeId
 * @param {string} reason
 */
async function rejectCashout(requestId, employeeId, reason) {
    const t = await sequelize.transaction();

    try {
        const request = await DeliveryPayoutRequest.findByPk(requestId, { transaction: t });
        if (!request) throw new Error('Request not found');
        if (!['pending', 'processing'].includes(request.status)) {
            throw new Error(`Cannot reject a ${request.status} request`);
        }

        // Release locked amount
        const wallet = await DeliveryWallet.findByPk(request.wallet_id, { transaction: t });
        await wallet.decrement({ pending_withdrawal: request.amount }, { transaction: t });

        await request.update({
            status:           'rejected',
            rejected_by:      employeeId,
            rejection_reason: reason,
        }, { transaction: t });

        await t.commit();
        return { success: true };

    } catch (error) {
        await t.rollback();
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
            wallet_id:             wallet.id,
            delivery_id:           null,
            type:                  'cash_commission_paid',
            payment_method:        'cash',
            amount,
            balance_before:        balanceBefore,
            balance_after:         balanceBefore,
            notes:                 notes || `Cash commission settlement by agent`,
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
    requestCashout,
    cancelCashout,
    approveCashout,
    rejectCashout,
    settleCashCommission,
};