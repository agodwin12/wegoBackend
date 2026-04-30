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
// ── Pre-paid top-up (driver credits wallet before working) ───────────
//
//   type=TOP_UP         amount=+5000   "Wallet top-up via MTN MoMo"
//
// ── Per completed trip, the earnings engine writes multiple rows ──────
//
//   type=TRIP_FARE      amount=+5000   "Trip fare earned"
//   type=COMMISSION     amount=-500    "WEGO commission (10%)"
//   type=BONUS_TRIP     amount=+200    "Night shift bonus"
//   type=BONUS_QUEST    amount=+1000   "10-trip daily target bonus"
//                       ───────────
//                       net = +5700 XAF credited to driver balance
//
// ── When WEGO pays the driver ─────────────────────────────────────────
//
//   type=PAYOUT         amount=-5700   "Weekly payout via MTN MoMo"
//
// ── Admin corrections ─────────────────────────────────────────────────
//
//   type=ADJUSTMENT     amount=+300    "Manual fare correction — Trip X"
//   type=ADJUSTMENT     amount=-200    "Penalty — late cancellation"
//
// ── Refund after dispute ──────────────────────────────────────────────
//
//   type=REFUND         amount=-3000   "Refund issued — dispute #D-2026-001"
//
// ── Sign convention ───────────────────────────────────────────────────
//
//   Positive = credit  (money coming INTO driver wallet)
//   Negative = debit   (money going OUT of driver wallet)
//
// ── Reference format by type ──────────────────────────────────────────
//
//   TOP_UP:      "TOP_UP:{uuid}"
//   TRIP_FARE:   "TRIP_FARE:{tripId}"
//   COMMISSION:  "COMMISSION:{tripId}"
//   BONUS_TRIP:  "BONUS_TRIP:{ruleId}:{tripId}"
//   BONUS_QUEST: "BONUS_QUEST:{programId}:{date}"
//   PAYOUT:      "PAYOUT:{payoutId}"
//   ADJUSTMENT:  "ADJUSTMENT:{adminId}:{timestamp}"
//   REFUND:      "REFUND:{disputeId}"
//
// ⚠️  MIGRATION REQUIRED when adding TOP_UP:
//   ALTER TABLE driver_wallet_transactions
//     MODIFY COLUMN type ENUM(
//       'TRIP_FARE','COMMISSION','BONUS_TRIP','BONUS_QUEST',
//       'ADJUSTMENT','REFUND','PAYOUT','TOP_UP'
//     ) NOT NULL;
//   ALTER TABLE driver_wallet_transactions
//     ADD COLUMN topUpMethod ENUM('MTN_MOMO','ORANGE_MONEY','CASH','BANK_TRANSFER') NULL
//     AFTER payoutStatus;
//   ALTER TABLE driver_wallet_transactions
//     ADD COLUMN topUpRef VARCHAR(200) NULL AFTER topUpMethod;
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
            comment:   'FK → trips.id. Present for TRIP_FARE, COMMISSION, BONUS_TRIP. Null for TOP_UP, PAYOUT, ADJUSTMENT.',
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
            comment:   'FK → earning_rules.id. Which rule triggered this entry. Null for TOP_UP, PAYOUT, ADJUSTMENT.',
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
            type: DataTypes.ENUM(
                'TOP_UP',        // Driver pre-funds wallet via MoMo / cash (positive)
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
            comment:   'Unique idempotency key. Format: {TYPE}:{uuid}. Prevents duplicate posting.',
        },

        // ── Extra metadata ────────────────────────────────────────────
        metadata: {
            type:      DataTypes.JSON,
            allowNull: true,
            field:     'metadata',
            comment:   'Arbitrary extra context. Never used for business logic — audit/display only.',
            // Examples by type:
            // TOP_UP:       { method: "MTN_MOMO", phone: "+237670000000", ref: "TXN123", initiatedBy: "driver" | "admin" }
            // TRIP_FARE:    { grossFare: 5000, pickup: "Akwa", dropoff: "Bonamoussadi" }
            // COMMISSION:   { rate: 0.10, ruleId: "...", ruleName: "Standard 10%" }
            // BONUS_TRIP:   { ruleName: "Night Bonus", condition: "hour >= 22" }
            // BONUS_QUEST:  { programName: "10 Trips Daily", target: 10, achieved: 10, period: "2026-02-28" }
            // PAYOUT:       { method: "MTN_MOMO", phone: "+237670000000", ref: "TXN123" }
            // ADJUSTMENT:   { adminId: "...", adminName: "Jean Admin", note: "Manual correction" }
        },

        // ── For TOP_UP type only ──────────────────────────────────────
        topUpMethod: {
            type:      DataTypes.ENUM('MTN_MOMO', 'ORANGE_MONEY', 'CASH', 'BANK_TRANSFER'),
            allowNull: true,
            field:     'topUpMethod',
            comment:   'Payment channel used to fund the wallet. Only populated for type=TOP_UP.',
        },

        topUpRef: {
            type:      DataTypes.STRING(200),
            allowNull: true,
            field:     'topUpRef',
            comment:   'External payment gateway transaction reference. Only populated for type=TOP_UP.',
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

        // ── For ADJUSTMENT type only ──────────────────────────────────
        adjustedBy: {
            type:      DataTypes.INTEGER,   // ← matches employees.id (int PK)
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

        // NOTE: No updatedAt — this table is append-only.
        // If you need to correct an entry, post a new ADJUSTMENT row.
        // updatedAt is intentionally omitted.
    },
    {
        sequelize,
        modelName:   'DriverWalletTransaction',
        tableName:   'driver_wallet_transactions',
        underscored: false,
        timestamps:  false,   // manual createdAt only — no updatedAt (immutable ledger)
        indexes: [
            // Most common query: driver's transaction history, newest first
            { fields: ['driverId', 'createdAt'], name: 'dwt_driver_date' },

            // Wallet-scoped queries
            { fields: ['walletId', 'createdAt'], name: 'dwt_wallet_date' },

            // Trip-scoped: "show all entries for trip X"
            { fields: ['tripId'], name: 'dwt_trip' },

            // Receipt-scoped: "show all entries for receipt X"
            { fields: ['receiptId'], name: 'dwt_receipt' },

            // Type filter: "show all PAYOUT entries" (for payout reconciliation)
            // Also used to find all TOP_UP entries for reconciliation reports
            { fields: ['type'], name: 'dwt_type' },

            // Idempotency check (unique reference)
            { unique: true, fields: ['reference'], name: 'dwt_reference_unique' },

            // Date-range queries for admin reports
            { fields: ['createdAt'], name: 'dwt_created_at' },

            // Admin adjustment audit
            { fields: ['adjustedBy'], name: 'dwt_adjusted_by' },
        ],
    }
);

module.exports = DriverWalletTransaction;