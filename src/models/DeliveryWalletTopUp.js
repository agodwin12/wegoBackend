// src/models/delivery/DeliveryWalletTopUp.js
//
// ═══════════════════════════════════════════════════════════════════════════════
// DELIVERY WALLET TOP-UP REQUEST
// ═══════════════════════════════════════════════════════════════════════════════
//
// Represents a driver's request to reload their delivery wallet.
// The wallet must have a positive balance for the driver to accept jobs —
// this model is the gate through which all funds enter the system.
//
// Three funding channels:
//   cash          → Driver visits a WeGo office. A cashier creates the record
//                   and a manager/admin confirms it.
//   mtn_mobile_money → Driver sends MoMo to the WeGo number, uploads screenshot.
//                      An employee verifies and confirms.
//   orange_money  → Same flow as MTN, different telco.
//
// State machine:
//   pending  ──► under_review  ──► confirmed ──► credited
//                    └──────────────► rejected
//
//   pending      : request submitted, not yet reviewed
//   under_review : an employee has opened and is verifying it
//   confirmed    : employee verified the payment — ready to credit wallet
//   credited     : wallet balance updated — terminal success state
//   rejected     : payment not verified (wrong amount, fake proof, etc.)
//
// The actual wallet credit happens in walletTopUp.service.js → creditWallet().
// This model is only the request record + audit trail.
//
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const { DataTypes, Model } = require('sequelize');

module.exports = (sequelize) => {

    class DeliveryWalletTopUp extends Model {

        // ─── Computed getters ─────────────────────────────────────────────────

        /**
         * True if this request is still actionable by an employee.
         */
        get isActionable() {
            return ['pending', 'under_review'].includes(this.status);
        }

        /**
         * True if this request has reached a terminal state.
         */
        get isTerminal() {
            return ['credited', 'rejected'].includes(this.status);
        }

        /**
         * Human-readable channel label for display in backoffice.
         */
        get channelLabel() {
            const labels = {
                cash:             'Cash at Office',
                mtn_mobile_money: 'MTN MoMo',
                orange_money:     'Orange Money',
            };
            return labels[this.payment_channel] || this.payment_channel;
        }

        // ─── State machine ────────────────────────────────────────────────────

        /**
         * Validates and applies a status transition.
         * Throws if the transition is not allowed.
         *
         * @param {'under_review'|'confirmed'|'credited'|'rejected'} newStatus
         * @param {object} [extraFields] - Additional fields to update alongside status
         */
        async transitionTo(newStatus, extraFields = {}) {
            const allowed = {
                pending:      ['under_review', 'rejected'],
                under_review: ['confirmed', 'rejected'],
                confirmed:    ['credited'],
                credited:     [],
                rejected:     [],
            };

            if (!(allowed[this.status] || []).includes(newStatus)) {
                throw new Error(
                    `Invalid top-up status transition: ${this.status} → ${newStatus}`
                );
            }

            const timestampMap = {
                under_review: { reviewed_at: new Date() },
                confirmed:    { confirmed_at: new Date() },
                credited:     { credited_at: new Date() },
                rejected:     { rejected_at: new Date() },
            };

            await this.update({
                status: newStatus,
                ...(timestampMap[newStatus] || {}),
                ...extraFields,
            });

            return this;
        }

        // ─── Associations ─────────────────────────────────────────────────────

        static associate(models) {
            // The driver who submitted the request
            DeliveryWalletTopUp.belongsTo(models.Driver, {
                foreignKey: 'driver_id',
                targetKey:  'id',
                as:         'driver',
            });

            // The wallet that will be credited
            DeliveryWalletTopUp.belongsTo(models.DeliveryWallet, {
                foreignKey: 'wallet_id',
                as:         'wallet',
            });

            // The employee who reviewed/confirmed/rejected
            if (models.Employee) {
                DeliveryWalletTopUp.belongsTo(models.Employee, {
                    foreignKey: 'reviewed_by',
                    as:         'reviewedByEmployee',
                });
            }
        }
    }

    DeliveryWalletTopUp.init(
        {
            // ── Primary key ───────────────────────────────────────────────────
            id: {
                type:          DataTypes.INTEGER.UNSIGNED,
                autoIncrement: true,
                primaryKey:    true,
            },

            // ── Human-readable reference code (shown on receipts) ─────────────
            // Format: TU-YYYYMMDD-XXXXXX   e.g. TU-20250407-A3F9K2
            // Generated in the service layer before creation.
            topup_code: {
                type:      DataTypes.STRING(25),
                allowNull: false,
                unique:    true,
            },

            // ── Relationship keys (no FK constraints — matches your pattern) ───
            driver_id: {
                type:      DataTypes.STRING(36),   // matches Driver.id VARCHAR(36)
                allowNull: false,
            },

            wallet_id: {
                type:      DataTypes.INTEGER.UNSIGNED,
                allowNull: false,
            },

            // ── Funding channel ───────────────────────────────────────────────
            payment_channel: {
                type:     DataTypes.ENUM('cash', 'mtn_mobile_money', 'orange_money'),
                allowNull: false,
            },

            // ── Amount ────────────────────────────────────────────────────────
            amount: {
                type:     DataTypes.DECIMAL(12, 2),
                allowNull: false,
                validate: {
                    min: {
                        args: [500],
                        msg:  'Minimum top-up amount is 500 XAF',
                    },
                    max: {
                        args: [500000],
                        msg:  'Maximum single top-up is 500,000 XAF',
                    },
                },
                get() { return parseFloat(this.getDataValue('amount') || 0); },
            },

            // ── Payment proof ─────────────────────────────────────────────────
            // R2 URL for screenshot uploaded by driver (required for MTN/Orange).
            // Null for cash — cashier is the proof.
            proof_url: {
                type:      DataTypes.STRING(500),
                allowNull: true,
            },

            // ── Telco transaction reference ───────────────────────────────────
            // Optional: the reference number from the MoMo/OM SMS confirmation.
            // Helps employee verify against telco records.
            payment_reference: {
                type:      DataTypes.STRING(100),
                allowNull: true,
            },

            // ── Phone number used for the transfer ────────────────────────────
            // Required for MTN/Orange so employee can cross-check.
            sender_phone: {
                type:      DataTypes.STRING(32),
                allowNull: true,
            },

            // ── Driver note ───────────────────────────────────────────────────
            driver_note: {
                type:      DataTypes.STRING(300),
                allowNull: true,
            },

            // ── State machine ─────────────────────────────────────────────────
            status: {
                type:         DataTypes.ENUM(
                    'pending',
                    'under_review',
                    'confirmed',
                    'credited',
                    'rejected'
                ),
                allowNull:    false,
                defaultValue: 'pending',
            },

            // ── Review metadata ───────────────────────────────────────────────
            reviewed_by: {
                type:      DataTypes.INTEGER.UNSIGNED,  // Employee.id
                allowNull: true,
            },

            rejection_reason: {
                type:      DataTypes.STRING(500),
                allowNull: true,
            },

            admin_note: {
                type:      DataTypes.STRING(500),
                allowNull: true,
            },

            // ── Snapshot of balance before credit ─────────────────────────────
            // Stored at the moment of crediting for audit/dispute purposes.
            balance_before_credit: {
                type:      DataTypes.DECIMAL(12, 2),
                allowNull: true,
                get() {
                    const v = this.getDataValue('balance_before_credit');
                    return v !== null ? parseFloat(v) : null;
                },
            },

            balance_after_credit: {
                type:      DataTypes.DECIMAL(12, 2),
                allowNull: true,
                get() {
                    const v = this.getDataValue('balance_after_credit');
                    return v !== null ? parseFloat(v) : null;
                },
            },

            // ── Timeline timestamps ───────────────────────────────────────────
            reviewed_at: {
                type:      DataTypes.DATE,
                allowNull: true,
            },

            confirmed_at: {
                type:      DataTypes.DATE,
                allowNull: true,
            },

            credited_at: {
                type:      DataTypes.DATE,
                allowNull: true,
            },

            rejected_at: {
                type:      DataTypes.DATE,
                allowNull: true,
            },
        },
        {
            sequelize,
            modelName:   'DeliveryWalletTopUp',
            tableName:   'delivery_wallet_topups',
            timestamps:  true,
            underscored: true,

            indexes: [
                // Primary lookup: driver views their own history
                { fields: ['driver_id', 'status'] },

                // Admin queue: pending items first, then under_review
                { fields: ['status', 'created_at'] },

                // Unique code lookup
                { unique: true, fields: ['topup_code'] },

                // Wallet audit: all top-ups credited to a wallet
                { fields: ['wallet_id'] },
            ],
        }
    );

    return DeliveryWalletTopUp;
};