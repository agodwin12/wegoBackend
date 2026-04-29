// src/models/delivery/DeliveryWalletTransaction.js
//
// ═══════════════════════════════════════════════════════════════════════════════
// DELIVERY WALLET TRANSACTION — v2
// ═══════════════════════════════════════════════════════════════════════════════
//
// Immutable ledger of every balance movement on a DeliveryWallet.
// Every credit and debit, regardless of source, creates a row here.
//
// New transaction types added in v2 (pre-paid wallet model):
//   top_up_credit       — wallet loaded from a confirmed WalletTopUp request
//   commission_reserve  — commission locked when driver accepts a job
//   commission_release  — lock released when delivery cancelled (not driver fault)
//
// SQL migration needed for new ENUM values:
//   ALTER TABLE delivery_wallet_transactions
//     MODIFY COLUMN type ENUM(
//       'delivery_earning','cash_collected','commission_deduction',
//       'cash_commission_owed','cash_commission_paid',
//       'withdrawal','withdrawal_reversal',
//       'adjustment_credit','adjustment_debit',
//       'top_up_credit','commission_reserve','commission_release'
//     ) NOT NULL;
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const { DataTypes, Model } = require('sequelize');

module.exports = (sequelize) => {

    class DeliveryWalletTransaction extends Model {

        // ─── Computed getters ─────────────────────────────────────────────────

        get isCredit() {
            return [
                'delivery_earning',
                'cash_collected',
                'cash_commission_paid',
                'withdrawal_reversal',
                'adjustment_credit',
                'top_up_credit',        // ← NEW
                'commission_release',   // ← NEW (reversal of a reserve)
            ].includes(this.type);
        }

        get isDebit() {
            return [
                'commission_deduction',
                'cash_commission_owed',
                'withdrawal',
                'adjustment_debit',
                'commission_reserve',   // ← NEW (reduces available balance, not balance)
            ].includes(this.type);
        }

        get typeLabel() {
            const labels = {
                // Pre-existing
                delivery_earning:     'Delivery Earning',
                cash_collected:       'Cash Collected',
                commission_deduction: 'WEGO Commission',
                cash_commission_owed: 'Cash Commission Due',
                cash_commission_paid: 'Cash Commission Settled',
                withdrawal:           'Withdrawal',
                withdrawal_reversal:  'Withdrawal Reversed',
                adjustment_credit:    'Manual Credit',
                adjustment_debit:     'Manual Debit',
                // New in v2
                top_up_credit:        'Wallet Top-Up',
                commission_reserve:   'Commission Reserved',
                commission_release:   'Commission Released',
            };
            return labels[this.type] || this.type;
        }

        // ─── Associations ─────────────────────────────────────────────────────

        static associate(models) {
            DeliveryWalletTransaction.belongsTo(models.DeliveryWallet, {
                foreignKey: 'wallet_id',
                as:         'wallet',
            });

            DeliveryWalletTransaction.belongsTo(models.Delivery, {
                foreignKey: 'delivery_id',
                as:         'delivery',
            });

            if (models.Employee) {
                DeliveryWalletTransaction.belongsTo(models.Employee, {
                    foreignKey: 'created_by_employee_id',
                    as:         'createdByEmployee',
                });
            }
        }
    }

    DeliveryWalletTransaction.init(
        {
            id: {
                type:          DataTypes.INTEGER.UNSIGNED,
                autoIncrement: true,
                primaryKey:    true,
            },

            wallet_id: {
                type:      DataTypes.INTEGER.UNSIGNED,
                allowNull: false,
                // No FK constraint — table created via raw SQL (your pattern)
            },

            delivery_id: {
                type:      DataTypes.INTEGER.UNSIGNED,
                allowNull: true,
            },

            type: {
                type: DataTypes.ENUM(
                    // ── Pre-paid top-up ──────────────────────────────
                    'top_up_credit',        // wallet loaded from confirmed top-up

                    // ── Commission lifecycle ─────────────────────────
                    'commission_reserve',   // locked on accept
                    'commission_release',   // released on system/sender cancel
                    'commission_deduction', // confirmed on delivery OR driver penalty cancel

                    // ── Cash delivery flows ──────────────────────────
                    'cash_collected',       // driver physically received cash
                    'cash_commission_owed', // driver owes WEGO their cut
                    'cash_commission_paid', // driver settled their cash debt

                    // ── Earnings (digital payment deliveries) ────────
                    'delivery_earning',     // driver_payout credited post-delivery

                    // ── Withdrawals ──────────────────────────────────
                    'withdrawal',           // cashout processed
                    'withdrawal_reversal',  // cashout rejected/reversed

                    // ── Manual adjustments ───────────────────────────
                    'adjustment_credit',    // admin manual credit
                    'adjustment_debit'      // admin manual debit
                ),
                allowNull: false,
            },

            payment_method: {
                type:      DataTypes.ENUM('mtn_mobile_money', 'orange_money', 'cash', 'system'),
                allowNull: true,
            },

            amount: {
                type:      DataTypes.DECIMAL(12, 2),
                allowNull: false,
                get() { return parseFloat(this.getDataValue('amount') || 0); },
            },

            // Snapshot of balance BEFORE this transaction was applied
            balance_before: {
                type:      DataTypes.DECIMAL(12, 2),
                allowNull: false,
                get() { return parseFloat(this.getDataValue('balance_before') || 0); },
            },

            // Snapshot of balance AFTER this transaction was applied
            balance_after: {
                type:      DataTypes.DECIMAL(12, 2),
                allowNull: false,
                get() { return parseFloat(this.getDataValue('balance_after') || 0); },
            },

            notes: {
                type:      DataTypes.STRING(500),
                allowNull: true,
            },

            // For top_up_credit — links back to the top-up request
            topup_id: {
                type:      DataTypes.INTEGER.UNSIGNED,
                allowNull: true,
            },

            // For admin adjustments — who did it
            created_by_employee_id: {
                type:      DataTypes.INTEGER.UNSIGNED,
                allowNull: true,
            },
        },
        {
            sequelize,
            modelName:   'DeliveryWalletTransaction',
            tableName:   'delivery_wallet_transactions',
            timestamps:  true,
            underscored: true,
            updatedAt:   false,  // transactions are immutable

            indexes: [
                { fields: ['wallet_id', 'created_at'] },
                { fields: ['delivery_id'] },
                { fields: ['type'] },
            ],
        }
    );

    return DeliveryWalletTransaction;
};