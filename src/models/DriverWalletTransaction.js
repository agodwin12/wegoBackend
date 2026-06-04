// src/models/DriverWalletTransaction.js
//
// ═══════════════════════════════════════════════════════════════════════
// DRIVER WALLET TRANSACTION — The Immutable Ledger
// ═══════════════════════════════════════════════════════════════════════
//
// Every single money movement for every driver is a row in this table.
// Rows are NEVER updated or deleted after creation. This is a pure
// append-only ledger — the financial source of truth for the platform.
//
// For each completed trip, the earnings engine writes multiple rows:
//
//   type=TRIP_FARE      amount=+5000   "Trip fare earned"
//   type=COMMISSION     amount=-500    "WEGO commission (10%)"
//   type=BONUS_TRIP     amount=+200    "Night shift bonus"
//   type=BONUS_QUEST    amount=+1000   "10-trip daily target bonus"
//                       ───────────
//                       net = +5700 XAF credited to driver balance
//
// When a driver tops up their pre-paid wallet:
//   type=TOP_UP         amount=+5000   "Wallet top-up via MTN MoMo"
//
// When WEGO pays the driver:
//   type=PAYOUT         amount=-5700   "Weekly payout via MTN MoMo"
//
// Admin corrections:
//   type=ADJUSTMENT     amount=+300    "Manual fare correction — Trip X"
//   type=ADJUSTMENT     amount=-200    "Penalty — late cancellation"
//
// Refund after dispute:
//   type=REFUND         amount=-3000   "Refund issued — dispute #D-2026-001"
//
// IMPORTANT: amount is always signed.
//   Positive = credit  (money coming INTO driver wallet)
//   Negative = debit   (money going OUT of driver wallet)
//
// ── Migration note ────────────────────────────────────────────────────
// Adding TOP_UP to the type ENUM requires a DB migration:
//
//   ALTER TABLE driver_wallet_transactions
//     MODIFY COLUMN type ENUM(
//       'TRIP_FARE','COMMISSION','BONUS_TRIP','BONUS_QUEST',
//       'ADJUSTMENT','REFUND','PAYOUT','TOP_UP'
//     ) NOT NULL;
//
//   ALTER TABLE driver_wallet_transactions
//     ADD COLUMN topUpMethod ENUM('CASH','MTN_MOMO','ORANGE_MONEY','BANK_TRANSFER') NULL
//       COMMENT 'Payment channel for TOP_UP. Null for all other types.',
//     ADD COLUMN topUpRef VARCHAR(200) NULL
//       COMMENT 'CamPay transaction reference for TOP_UP. Null for all other types.',
//     ADD COLUMN topUpStatus ENUM('PENDING','COMPLETED','FAILED') NULL
//       COMMENT 'CamPay confirmation status. Null for all other types.';
//
// ═══════════════════════════════════════════════════════════════════════

const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class DriverWalletTransaction extends Model {}

DriverWalletTransaction.init(
    {
        // ── Primary Key ───────────────────────────────────────────────
        id: {
            type:         DataTypes.CHAR(36),
            primaryKey:   true,
            defaultValue: DataTypes.UUIDV4,
            comment:      'UUID primary key',
        },

        // ── Owner ─────────────────────────────────────────────────────
        driverId: {
            type:       DataTypes.CHAR(36),
            allowNull:  false,
            field:      'driverId',
            references: { model: 'accounts', key: 'uuid' },
            comment:    'FK → accounts.uuid. The driver this transaction belongs to.',
        },

        walletId: {
            type:       DataTypes.CHAR(36),
            allowNull:  false,
            field:      'walletId',
            references: { model: 'driver_wallets', key: 'id' },
            comment:    'FK → driver_wallets.id. Denormalized for fast wallet-scoped queries.',
        },

        // ── Source references (all nullable — not every type has all) ──
        tripId: {
            type:      DataTypes.CHAR(36),
            allowNull: true,
            field:     'tripId',
            comment:   'FK → trips.id. Present for TRIP_FARE, COMMISSION, BONUS_TRIP. Null for PAYOUT, ADJUSTMENT, TOP_UP.',
        },

        receiptId: {
            type:      DataTypes.CHAR(36),
            allowNull: true,
            field:     'receiptId',
            comment:   'FK → trip_receipts.id. Links back to the receipt that generated this entry.',
        },

        ruleId: {
            type:      DataTypes.CHAR(36),
            allowNull: true,
            field:     'ruleId',
            comment:   'FK → earning_rules.id. Which rule triggered this entry. Null for PAYOUT/ADJUSTMENT/TOP_UP.',
        },

        bonusProgramId: {
            type:      DataTypes.CHAR(36),
            allowNull: true,
            field:     'bonusProgramId',
            comment:   'FK → bonus_programs.id. Present only for BONUS_QUEST entries.',
        },

        bonusAwardId: {
            type:      DataTypes.CHAR(36),
            allowNull: true,
            field:     'bonusAwardId',
            comment:   'FK → bonus_awards.id. Present only for BONUS_QUEST entries. Links to the idempotency record.',
        },

        // ── Transaction type ──────────────────────────────────────────
        type: {
            type:      DataTypes.ENUM(
                'TOP_UP',        // Pre-paid wallet credit via CamPay (positive)  ← NEW
                'TRIP_FARE',     // Gross fare from a completed trip (positive)
                'COMMISSION',    // WEGO commission deduction (negative)
                'BONUS_TRIP',    // Per-trip bonus: night, area, airport, etc. (positive)
                'BONUS_QUEST',   // Quest/milestone bonus: daily target, weekly target (positive)
                'ADJUSTMENT',    // Manual admin correction (positive or negative)
                'REFUND',        // Refund issued after dispute (negative)
                'PAYOUT'         // Driver payout: cash handover or MoMo transfer (negative)
            ),
            allowNull: false,
            field:     'type',
            comment:   'Transaction type. Determines sign convention and display label.',
        },

        // ── Amount ────────────────────────────────────────────────────
        amount: {
            type:      DataTypes.INTEGER,
            allowNull: false,
            field:     'amount',
            comment:   'Signed integer XAF. Positive = credit, Negative = debit. NEVER zero.',
        },

        // ── Running balance snapshot ──────────────────────────────────
        balanceAfter: {
            type:      DataTypes.INTEGER,
            allowNull: false,
            field:     'balanceAfter',
            comment:   'Wallet balance immediately AFTER this transaction was applied. Snapshot for audit — never recomputed.',
        },

        // ── Human-readable description ────────────────────────────────
        description: {
            type:      DataTypes.STRING(300),
            allowNull: false,
            field:     'description',
            comment:   'Human-readable label shown in driver earnings activity feed.',
        },

        // ── Idempotency reference ─────────────────────────────────────
        reference: {
            type:      DataTypes.STRING(100),
            allowNull: false,
            unique:    true,
            field:     'reference',
            comment:   'Unique idempotency key. Format: {type}:{id}. Prevents duplicate posting.',
            // Examples:
            //   "TOP_UP:campay-ref-abc123"         ← new
            //   "TRIP_FARE:trip-uuid-here"
            //   "COMMISSION:trip-uuid-here"
            //   "PAYOUT:payout-uuid-here"
        },

        // ── Extra metadata ────────────────────────────────────────────
        metadata: {
            type:      DataTypes.JSON,
            allowNull: true,
            field:     'metadata',
            comment:   'Arbitrary extra context. Never used for business logic — audit/display only.',
            // TOP_UP example:
            // { campayRef: "CP-123", phone: "+237670000000", operator: "MTN_MOMO", initiatedAt: "2026-05-26T..." }
        },

        // ── For PAYOUT type only ──────────────────────────────────────
        payoutMethod: {
            type:      DataTypes.ENUM('CASH', 'MTN_MOMO', 'ORANGE_MONEY', 'BANK_TRANSFER'),
            allowNull: true,
            field:     'payoutMethod',
            comment:   'Payout channel. Only populated for type=PAYOUT.',
        },

        payoutRef: {
            type:      DataTypes.STRING(200),
            allowNull: true,
            field:     'payoutRef',
            comment:   'External payment gateway reference. Only populated for type=PAYOUT.',
        },

        payoutStatus: {
            type:      DataTypes.ENUM('PENDING', 'COMPLETED', 'FAILED'),
            allowNull: true,
            field:     'payoutStatus',
            comment:   'Gateway confirmation status. Only populated for type=PAYOUT.',
        },

        // ── For TOP_UP type only ──────────────────────────────────────
        topUpMethod: {
            type:      DataTypes.ENUM('CASH', 'MTN_MOMO', 'ORANGE_MONEY', 'BANK_TRANSFER'),
            allowNull: true,
            field:     'topUpMethod',
            comment:   'Payment channel used for the top-up. Only populated for type=TOP_UP.',
        },

        topUpRef: {
            type:      DataTypes.STRING(200),
            allowNull: true,
            field:     'topUpRef',
            comment:   'CamPay transaction reference for this top-up. Only populated for type=TOP_UP.',
        },

        topUpStatus: {
            type:      DataTypes.ENUM('PENDING', 'COMPLETED', 'FAILED'),
            allowNull: true,
            field:     'topUpStatus',
            comment:   'CamPay confirmation status. PENDING until webhook fires. Only populated for type=TOP_UP.',
        },

        // ── For ADJUSTMENT type only ──────────────────────────────────
        adjustedBy: {
            type:      DataTypes.INTEGER,
            allowNull: true,
            field:     'adjustedBy',
            comment:   'FK → employees.id. Which admin created this manual adjustment.',
        },

        adjustmentNote: {
            type:      DataTypes.STRING(500),
            allowNull: true,
            field:     'adjustmentNote',
            comment:   'Admin note explaining the adjustment reason. Required for type=ADJUSTMENT.',
        },

        // ── Timestamps ────────────────────────────────────────────────
        createdAt: {
            type:      DataTypes.DATE,
            allowNull: false,
            field:     'createdAt',
        },


    },
    {
        sequelize,
        modelName:   'DriverWalletTransaction',
        tableName:   'driver_wallet_transactions',
        underscored: false,
        timestamps:  false,   // manual createdAt only — no updatedAt
        indexes: [
            { fields: ['driverId', 'createdAt'], name: 'dwt_driver_date' },
            { fields: ['walletId', 'createdAt'], name: 'dwt_wallet_date' },
            { fields: ['tripId'],                name: 'dwt_trip' },
            { fields: ['receiptId'],             name: 'dwt_receipt' },
            { fields: ['type'],                  name: 'dwt_type' },
            { unique: true, fields: ['reference'], name: 'dwt_reference_unique' },
            { fields: ['createdAt'],             name: 'dwt_created_at' },
            { fields: ['adjustedBy'],            name: 'dwt_adjusted_by' },
            // ── New: find pending top-ups quickly (for reconciliation) ──
            { fields: ['topUpStatus'],           name: 'dwt_topup_status' },
            { fields: ['topUpRef'],              name: 'dwt_topup_ref' },
        ],
    }
);

module.exports = DriverWalletTransaction;