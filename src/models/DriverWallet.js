// src/models/DriverWallet.js
//
// ═══════════════════════════════════════════════════════════════════════
// DRIVER WALLET — One row per driver
// ═══════════════════════════════════════════════════════════════════════
//
// This is NOT a bank account. It is a virtual ledger balance that tracks
// everything a driver has earned minus what has been paid out.
//
// Design principle:
//   - balance is a CACHED running total (for fast reads)
//   - The source of truth is always driver_wallet_transactions (the ledger)
//   - balance is updated atomically inside the same DB transaction as
//     every wallet entry — they are NEVER out of sync
//   - If you ever suspect a drift, you can recompute:
//       SELECT SUM(amount) FROM driver_wallet_transactions WHERE driverId = ?
//     and that will always match wallet.balance
//
// Balance can technically go negative if an admin posts a manual PENALTY
// or REFUND adjustment that exceeds current balance. This is intentional —
// we never silently absorb losses.
//
// Lifecycle:
//   Created automatically when a driver account is first activated.
//   Never deleted — even if the driver is suspended.
//
// ═══════════════════════════════════════════════════════════════════════

const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class DriverWallet extends Model {}

DriverWallet.init(
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
            unique:     true,    // ← one wallet per driver, enforced at DB level
            field:      'driverId',
            references: { model: 'accounts', key: 'uuid' },
            onDelete:   'RESTRICT',
            comment:    'FK → accounts.uuid. UNIQUE: one wallet per driver.',
        },

        // ── Cached balance (XAF, integer) ─────────────────────────────
        balance: {
            type:         DataTypes.INTEGER,
            allowNull:    false,
            defaultValue: 0,
            field:        'balance',
            comment:      'Running total of all transactions. Updated atomically with every wallet entry. Integer XAF — no decimals.',
        },

        // ── Lifetime stats (denormalized for fast dashboard reads) ─────
        totalEarned: {
            type:         DataTypes.INTEGER,
            allowNull:    false,
            defaultValue: 0,
            field:        'totalEarned',
            comment:      'Cumulative sum of all TRIP_FARE + BONUS credits. Never decremented.',
        },

        totalCommission: {
            type:         DataTypes.INTEGER,
            allowNull:    false,
            defaultValue: 0,
            field:        'totalCommission',
            comment:      'Cumulative sum of all COMMISSION debits. For driver transparency.',
        },

        totalBonuses: {
            type:         DataTypes.INTEGER,
            allowNull:    false,
            defaultValue: 0,
            field:        'totalBonuses',
            comment:      'Cumulative sum of all BONUS_TRIP + BONUS_QUEST credits.',
        },

        totalPayouts: {
            type:         DataTypes.INTEGER,
            allowNull:    false,
            defaultValue: 0,
            field:        'totalPayouts',
            comment:      'Cumulative sum of all PAYOUT debits (cash handovers + MoMo transfers).',
        },

        // ── Payout info ───────────────────────────────────────────────
        lastPayoutAt: {
            type:      DataTypes.DATE,
            allowNull: true,
            field:     'lastPayoutAt',
            comment:   'Timestamp of the last PAYOUT transaction. For driver dashboard display.',
        },

        // ── Status ────────────────────────────────────────────────────
        status: {
            type:         DataTypes.ENUM('ACTIVE', 'FROZEN', 'SUSPENDED'),
            allowNull:    false,
            defaultValue: 'ACTIVE',
            field:        'status',
            comment:      'FROZEN: admin has paused payouts (e.g. fraud investigation). SUSPENDED: driver account suspended.',
        },

        frozenReason: {
            type:      DataTypes.STRING(300),
            allowNull: true,
            field:     'frozenReason',
            comment:   'Admin note when wallet was frozen. Null if ACTIVE.',
        },

        frozenAt: {
            type:      DataTypes.DATE,
            allowNull: true,
            field:     'frozenAt',
            comment:   'When the wallet was frozen.',
        },

        frozenBy: {
            type:      DataTypes.INTEGER,   // ← matches employees.id (int PK)
            allowNull: true,
            field:     'frozenBy',
            comment:   'FK → employees.id — which admin froze this wallet.',
        },

        // ── Currency (future-proofing for multi-country expansion) ────
        currency: {
            type:         DataTypes.STRING(10),
            allowNull:    false,
            defaultValue: 'XAF',
            field:        'currency',
            comment:      'ISO 4217 currency code. Always XAF for Cameroon.',
        },

        // ── Timestamps ────────────────────────────────────────────────
        createdAt: {
            type:      DataTypes.DATE,
            allowNull: false,
            field:     'createdAt',
        },

        updatedAt: {
            type:      DataTypes.DATE,
            allowNull: false,
            field:     'updatedAt',
        },
    },
    {
        sequelize,
        modelName:   'DriverWallet',
        tableName:   'driver_wallets',
        underscored: false,
        timestamps:  true,
        indexes: [
            // Primary lookup: find wallet by driver
            { unique: true, fields: ['driverId'], name: 'driver_wallets_driver_unique' },

            // Admin: filter wallets by status (find FROZEN wallets)
            { fields: ['status'], name: 'driver_wallets_status' },

            // Admin: sort by balance for payouts prioritization
            { fields: ['balance'], name: 'driver_wallets_balance' },
        ],
    }
);

module.exports = DriverWallet;