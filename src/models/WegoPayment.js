// src/models/WegoPayment.js
//
// ═══════════════════════════════════════════════════════════════════════════════
// WEGO PAYMENT MODEL
// ═══════════════════════════════════════════════════════════════════════════════
//
// Universal payment ledger for all WeGo verticals.
// Every real money movement WeGo initiates through CamPay gets one record here,
// regardless of which vertical triggered it. Single source of truth for payment
// audit, reconciliation, and dispute resolution.
//
// The existing `payments` table (trip-only, manual) is NOT touched.
// This table is greenfield — all CamPay-powered payments go here.
//
// Verticals:
//   trip             → passenger pays for a ride
//   delivery         → sender pays for a parcel delivery
//   service_request  → customer pays for a service listing ad plan
//   rental           → customer pays for a vehicle rental
//   listing_fee      → alias for service_request (same ServiceAdPayment resolution)
//   delivery_topup   → delivery agent reloads their pre-paid wallet via MoMo/Orange
//
// Two directions:
//   collect  → customer/agent pays WeGo  (triggered by passenger/sender/agent)
//   disburse → WeGo pays driver/agent    (triggered by admin approving cashout)
//
// Lifecycle (collect):
//   PENDING → webhook arrives    → SUCCESSFUL or FAILED
//   PENDING → no webhook in 5min → expiry job sets EXPIRED
//
// Lifecycle (disburse):
//   PENDING → CamPay responds synchronously → SUCCESSFUL or FAILED
//
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const { DataTypes, Model } = require('sequelize');

module.exports = (sequelize) => {

    class WegoPayment extends Model {

        // ── Computed: is this payment in a terminal state? ────────────────────
        get isResolved() {
            return ['SUCCESSFUL', 'FAILED', 'EXPIRED'].includes(this.status);
        }

        // ── Computed: did the payment succeed? ────────────────────────────────
        get isSuccessful() {
            return this.status === 'SUCCESSFUL';
        }

        static associate(models) {
            // Polymorphic associations via vertical + vertical_id.
            // No hard FK constraints because vertical_id points to different
            // tables depending on the vertical value:
            //   trip            → Trip.id (UUID)
            //   delivery        → Delivery.id (INT)
            //   service_request → ServiceAdPayment.id (INT)
            //   listing_fee     → ServiceAdPayment.id (INT)
            //   rental          → VehicleRental.id (UUID)
            //   delivery_topup  → DeliveryWalletTopUp.id (INT)
            //
            // The webhook controller resolves the correct record at runtime
            // using vertical + vertical_id together.

            if (models.Account) {
                WegoPayment.belongsTo(models.Account, {
                    foreignKey:  'initiated_by',
                    targetKey:   'uuid',
                    as:          'initiator',
                    constraints: false,
                });
            }
        }
    }

    WegoPayment.init(
        {
            // ── Primary Key ───────────────────────────────────────────────────
            id: {
                type:         DataTypes.UUID,
                primaryKey:   true,
                defaultValue: DataTypes.UUIDV4,
                comment:      'WeGo internal payment UUID',
            },

            // ── Vertical ─────────────────────────────────────────────────────
            // Which WeGo service triggered this payment.
            // NULL is allowed for disbursements (not tied to one vertical).
            vertical: {
                type:      DataTypes.ENUM(
                    'trip',
                    'delivery',
                    'service_request',
                    'rental',
                    'listing_fee',      // service listing ad plan payment
                    'delivery_topup'    // delivery agent wallet reload
                ),
                allowNull: true,
                comment:   'Which WeGo vertical triggered this payment. NULL for disbursements.',
            },

            // ── Vertical record ID ────────────────────────────────────────────
            // Stored as VARCHAR(36) to accommodate both INT IDs and UUID IDs
            // across different tables. Cast to the correct type when querying.
            vertical_id: {
                type:      DataTypes.STRING(36),
                allowNull: true,
                comment:   'PK of the vertical record this payment covers. See vertical comment for type.',
            },

            // ── CamPay references ─────────────────────────────────────────────
            // external_ref: we generate before calling CamPay (WEGO-{CODE}-{ID}-{UUID})
            // campay_ref:   CamPay returns this — used to correlate webhooks and poll
            external_ref: {
                type:      DataTypes.STRING(60),
                allowNull: false,
                unique:    true,
                comment:   'Our unique reference sent to CamPay. Format: WEGO-{VERTICAL_CODE}-{ID}-{SHORT_UUID}',
            },

            campay_ref: {
                type:      DataTypes.STRING(60),
                allowNull: true,
                comment:   "CamPay's transaction reference. Populated after initiation. Used for webhooks and polling.",
            },

            // ── Payment details ───────────────────────────────────────────────
            phone: {
                type:      DataTypes.STRING(15),
                allowNull: false,
                comment:   'Phone number charged (collect) or paid to (disburse). Format: 237xxxxxxxxx',
            },

            operator: {
                type:      DataTypes.ENUM('MTN', 'ORANGE'),
                allowNull: true,
                comment:   'Mobile operator detected by CamPay. Populated on response/webhook.',
            },

            amount: {
                type:      DataTypes.INTEGER,
                allowNull: false,
                comment:   'Amount in XAF. Integer only — CamPay rejects decimal amounts.',
            },

            currency: {
                type:         DataTypes.STRING(3),
                allowNull:    false,
                defaultValue: 'XAF',
                comment:      'Always XAF for Cameroon.',
            },

            // ── Direction ─────────────────────────────────────────────────────
            direction: {
                type:      DataTypes.ENUM('collect', 'disburse'),
                allowNull: false,
                comment:   'collect = someone pays WeGo. disburse = WeGo pays someone.',
            },

            // ── Status ────────────────────────────────────────────────────────
            status: {
                type:         DataTypes.ENUM('PENDING', 'SUCCESSFUL', 'FAILED', 'EXPIRED'),
                allowNull:    false,
                defaultValue: 'PENDING',
                comment: [
                    'PENDING    — awaiting customer PIN or CamPay processing',
                    'SUCCESSFUL — confirmed by CamPay webhook or sync response',
                    'FAILED     — CamPay rejected or customer cancelled',
                    'EXPIRED    — no webhook within timeout; expiry job set this',
                ].join(' | '),
            },

            // ── Failure details ───────────────────────────────────────────────
            failure_reason: {
                type:      DataTypes.STRING(300),
                allowNull: true,
                comment:   'Human-readable reason for FAILED status.',
            },

            campay_code: {
                type:      DataTypes.STRING(10),
                allowNull: true,
                comment:   'CamPay error code if failed: ER101, ER102, ER201, ER301.',
            },

            // ── Full CamPay API response (audit only) ─────────────────────────
            campay_response: {
                type:      DataTypes.JSON,
                allowNull: true,
                comment:   'Complete raw CamPay response. Never used for business logic — audit/support only.',
            },

            // ── Initiated by ──────────────────────────────────────────────────
            initiated_by: {
                type:      DataTypes.CHAR(36),
                allowNull: true,
                comment:   'Account UUID of the person who triggered this payment.',
            },

            // ── Notes ─────────────────────────────────────────────────────────
            notes: {
                type:      DataTypes.STRING(300),
                allowNull: true,
                comment:   'Internal notes. Used for disbursements to record payout request ref.',
            },

            // ── Timestamps ────────────────────────────────────────────────────
            initiated_at: {
                type:      DataTypes.DATE,
                allowNull: false,
                comment:   'When we called CamPay to initiate the payment.',
            },

            resolved_at: {
                type:      DataTypes.DATE,
                allowNull: true,
                comment:   'When the payment reached a terminal state (SUCCESSFUL / FAILED / EXPIRED).',
            },
        },
        {
            sequelize,
            modelName:   'WegoPayment',
            tableName:   'wego_payments',
            underscored: false,
            timestamps:  true,
            indexes: [
                {
                    unique: true,
                    fields: ['external_ref'],
                    name:   'wego_payments_external_ref_unique',
                },
                {
                    fields: ['campay_ref'],
                    name:   'wego_payments_campay_ref',
                },
                {
                    fields: ['vertical', 'vertical_id'],
                    name:   'wego_payments_vertical_id',
                },
                {
                    fields: ['status', 'initiated_at'],
                    name:   'wego_payments_status_initiated',
                },
                {
                    fields: ['initiated_by'],
                    name:   'wego_payments_initiated_by',
                },
            ],
        }
    );

    return WegoPayment;
};