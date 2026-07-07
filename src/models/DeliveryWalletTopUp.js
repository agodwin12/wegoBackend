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
//   cash             → Driver visits a WeGo office. Cashier creates the record,
//                      manager/admin confirms it. Manual backoffice flow.
//   mtn_mobile_money → CamPay collects automatically via USSD. No screenshot
//                      needed — webhook credits the wallet on confirmation.
//   orange_money     → Same CamPay flow as MTN, different operator.
//
// State machine:
//
//   MANUAL (cash):
//   pending  ──► under_review  ──► confirmed ──► credited
//                    └──────────────► rejected
//
//   CAMPAY (mtn_mobile_money / orange_money):
//   campay_pending ──► credited       (CamPay SUCCESSFUL webhook)
//                  └─► campay_failed  (CamPay FAILED webhook or initiation error)
//
//   pending        : cash request submitted, not yet reviewed
//   under_review   : employee has claimed and is verifying it
//   confirmed      : employee verified the payment — ready to credit wallet
//   credited       : wallet balance updated — terminal success state
//   rejected       : payment not verified (wrong amount, fake proof, etc.)
//   campay_pending : CamPay collection initiated, awaiting webhook confirmation
//   campay_failed  : CamPay payment failed or was cancelled by driver
//
// The actual wallet credit happens in walletTopUp.service.js:
//   Manual  → creditWallet()
//   CamPay  → creditWalletAutomatically()
// This model is only the request record + audit trail.
//
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const { DataTypes, Model } = require('sequelize');

module.exports = (sequelize) => {

    class DeliveryWalletTopUp extends Model {

        // ─── Computed getters ─────────────────────────────────────────────────

        /**
         * True if this cash request is still actionable by a backoffice employee.
         * CamPay requests are not employee-actionable — the webhook handles them.
         */
        get isActionable() {
            return ['pending', 'under_review'].includes(this.status);
        }

        /**
         * True if this request has reached a terminal state (success or failure).
         * Once terminal, no further transitions are allowed.
         */
        get isTerminal() {
            return ['credited', 'rejected', 'campay_failed'].includes(this.status);
        }

        /**
         * True if this was a CamPay-initiated top-up (not manual cash).
         */
        get isCampayFlow() {
            return ['mtn_mobile_money', 'orange_money'].includes(this.payment_channel);
        }

        /**
         * Human-readable channel label for display in backoffice and app.
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
         * Validates and applies a status transition for the MANUAL (cash) flow.
         * CamPay transitions (campay_pending → credited/campay_failed) are
         * handled directly in walletTopUp.service.js via topUp.update() because
         * they originate from the webhook, not from a controller action.
         *
         * Throws if the requested transition is not allowed from the current status.
         *
         * @param {'under_review'|'confirmed'|'credited'|'rejected'} newStatus
         * @param {object} [extraFields]  Additional fields to update alongside status
         */
        async transitionTo(newStatus, extraFields = {}) {
            const allowed = {
                // Manual cash flow
                pending:        ['under_review', 'rejected'],
                under_review:   ['confirmed', 'rejected'],
                confirmed:      ['credited'],
                // Terminal states — no further transitions
                credited:       [],
                rejected:       [],
                // CamPay states — managed directly by webhook service, not here
                campay_pending: [],
                campay_failed:  [],
            };

            if (!(allowed[this.status] || []).includes(newStatus)) {
                throw new Error(
                    `Invalid top-up status transition: ${this.status} → ${newStatus}. ` +
                    (this.isCampayFlow
                        ? 'CamPay top-ups are managed automatically by the payment webhook.'
                        : `Allowed from '${this.status}': [${(allowed[this.status] || []).join(', ') || 'none'}]`)
                );
            }

            const timestampMap = {
                under_review: { reviewed_at:  new Date() },
                confirmed:    { confirmed_at: new Date() },
                credited:     { credited_at:  new Date() },
                rejected:     { rejected_at:  new Date() },
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

            // The employee who reviewed/confirmed/rejected (manual flow only)
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

            // ── Human-readable reference code ─────────────────────────────────
            // Format: TU-YYYYMMDD-XXXXXX   e.g. TU-20250407-A3F9K2
            // Generated in the service layer before creation.
            // Shown on receipts and in the backoffice queue.
            topup_code: {
                type:      DataTypes.STRING(25),
                allowNull: false,
                unique:    true,
            },

            // ── Relationship keys (no FK constraints — matches project pattern) ─
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
                type:      DataTypes.ENUM('cash', 'mtn_mobile_money', 'orange_money'),
                allowNull: false,
            },

            // ── Amount ────────────────────────────────────────────────────────
            amount: {
                type:      DataTypes.DECIMAL(12, 2),
                allowNull: false,
                validate: {
                    // Min mirrors MIN_TOPUP_XAF (25 on the CamPay demo, 500 in prod).
                    min: { args: [parseInt(process.env.MIN_TOPUP_XAF || '25', 10)], msg: 'Top-up amount is below the minimum.' },
                    max: { args: [500000], msg: 'Maximum single top-up is 500,000 XAF' },
                },
                get() {
                    return parseFloat(this.getDataValue('amount') || 0);
                },
            },

            // ── CamPay correlation ────────────────────────────────────────────
            // Populated after campayService.initiateCollection() returns.
            // Used by the webhook to find this record when CamPay fires.
            // NULL for cash top-ups (manual flow — no CamPay involved).
            campay_ref: {
                type:      DataTypes.STRING(60),
                allowNull: true,
                comment:   'CamPay transaction reference. Populated after initiation. NULL for cash.',
            },

            // ── Payment proof (manual flow only) ──────────────────────────────
            // R2 URL of screenshot uploaded by driver for cash verification.
            // NULL for CamPay flows — no screenshot needed.
            proof_url: {
                type:      DataTypes.STRING(500),
                allowNull: true,
            },

            // ── Telco transaction reference (manual flow) ──────────────────────
            // Optional reference from the MoMo/OM SMS confirmation.
            // Only relevant for the old screenshot flow, not CamPay.
            payment_reference: {
                type:      DataTypes.STRING(100),
                allowNull: true,
            },

            // ── Sender phone (manual flow) ────────────────────────────────────
            // Phone number used for the manual transfer. Helps employee verify.
            // Not needed for CamPay — the phone is on the WegoPayment record.
            sender_phone: {
                type:      DataTypes.STRING(32),
                allowNull: true,
            },

            // ── Driver note ───────────────────────────────────────────────────
            driver_note: {
                type:      DataTypes.STRING(300),
                allowNull: true,
            },

            // ── Status ────────────────────────────────────────────────────────
            status: {
                type:         DataTypes.ENUM(
                    'pending',          // cash: submitted, awaiting review
                    'under_review',     // cash: employee claimed it
                    'confirmed',        // cash: employee verified — ready to credit
                    'credited',         // TERMINAL SUCCESS — wallet balance updated
                    'rejected',         // TERMINAL FAILURE — manual rejection
                    'campay_pending',   // CamPay: collection initiated, awaiting webhook
                    'campay_failed'     // TERMINAL FAILURE — CamPay declined or cancelled
                ),
                allowNull:    false,
                defaultValue: 'pending',
            },

            // ── Review metadata (manual flow) ─────────────────────────────────
            reviewed_by: {
                type:      DataTypes.INTEGER.UNSIGNED,   // Employee.id
                allowNull: true,
                comment:   'Employee who reviewed this request. NULL for CamPay top-ups.',
            },

            rejection_reason: {
                type:      DataTypes.STRING(500),
                allowNull: true,
                comment:   'Reason shown to driver on rejection or campay_failed.',
            },

            admin_note: {
                type:      DataTypes.STRING(500),
                allowNull: true,
                comment:   'Internal note from reviewing employee. Never shown to driver.',
            },

            // ── Balance snapshot ──────────────────────────────────────────────
            // Captured at the moment the wallet is credited for audit purposes.
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
                // Driver views their own history filtered by status
                { fields: ['driver_id', 'status'] },

                // Admin queue: oldest actionable items first (FIFO)
                { fields: ['status', 'created_at'] },

                // Unique code lookup (receipts, support)
                { unique: true, fields: ['topup_code'] },

                // Wallet audit: all top-ups credited to a specific wallet
                { fields: ['wallet_id'] },

                // Webhook correlation: find topup by campay_ref
                { fields: ['campay_ref'] },
            ],
        }
    );

    return DeliveryWalletTopUp;
};