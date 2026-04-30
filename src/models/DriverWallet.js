// src/models/DriverWallet.js
//
// ═══════════════════════════════════════════════════════════════════════
// DRIVER WALLET — One row per driver
// ═══════════════════════════════════════════════════════════════════════
//
// Pre-paid working capital model (Uber/Yango style):
//   - Driver tops up wallet before going to work
//   - Trip dispatch checks balance covers commission on estimated fare
//   - Earnings engine credits TRIP_FARE and debits COMMISSION at completion
//   - Net result: balance grows with each trip completed
//
// Balance composition:
//   balance = totalTopUps + totalEarned - totalCommission - totalPayouts
//             + totalBonuses + manual adjustments
//
// Design principle:
//   - balance is a CACHED running total (for fast reads)
//   - Source of truth is always driver_wallet_transactions (the ledger)
//   - balance is updated atomically inside the same DB transaction as
//     every wallet entry — they are NEVER out of sync
//   - If you ever suspect drift, recompute:
//       SELECT SUM(amount) FROM driver_wallet_transactions WHERE driverId = ?
//     and it will always match wallet.balance
//
// ⚠️  MIGRATION REQUIRED for totalTopUps:
//   ALTER TABLE driver_wallets
//     ADD COLUMN totalTopUps INT NOT NULL DEFAULT 0
//     AFTER totalPayouts;
//
// ═══════════════════════════════════════════════════════════════════════

'use strict';

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
            type:      DataTypes.CHAR(36),
            allowNull: false,
            unique:    true,    // one wallet per driver, enforced at DB level
            comment:   'FK → accounts.uuid. UNIQUE: one wallet per driver.',
        },

        // ── Cached balance (XAF, integer) ─────────────────────────────
        balance: {
            type:         DataTypes.INTEGER,
            allowNull:    false,
            defaultValue: 0,
            comment:      'Running total of all transactions. Updated atomically with every wallet entry. Integer XAF — no decimals.',
        },

        // ── Lifetime stats (denormalized for fast dashboard reads) ─────
        totalTopUps: {
            type:         DataTypes.INTEGER,
            allowNull:    false,
            defaultValue: 0,
            comment:      'Cumulative sum of all TOP_UP credits. Tracks how much the driver has ever funded their wallet. Never decremented.',
        },

        totalEarned: {
            type:         DataTypes.INTEGER,
            allowNull:    false,
            defaultValue: 0,
            comment:      'Cumulative sum of all TRIP_FARE + BONUS credits. Never decremented. Does NOT include top-ups.',
        },

        totalCommission: {
            type:         DataTypes.INTEGER,
            allowNull:    false,
            defaultValue: 0,
            comment:      'Cumulative sum of all COMMISSION debits. For driver transparency.',
        },

        totalBonuses: {
            type:         DataTypes.INTEGER,
            allowNull:    false,
            defaultValue: 0,
            comment:      'Cumulative sum of all BONUS_TRIP + BONUS_QUEST credits.',
        },

        totalPayouts: {
            type:         DataTypes.INTEGER,
            allowNull:    false,
            defaultValue: 0,
            comment:      'Cumulative sum of all PAYOUT debits (cash handovers + MoMo transfers).',
        },

        // ── Payout tracking ───────────────────────────────────────────
        lastPayoutAt: {
            type:      DataTypes.DATE,
            allowNull: true,
            comment:   'Timestamp of the last PAYOUT transaction. For driver dashboard display.',
        },

        // ── Top-up tracking ───────────────────────────────────────────
        lastTopUpAt: {
            type:      DataTypes.DATE,
            allowNull: true,
            comment:   'Timestamp of the last TOP_UP transaction. For driver dashboard display.',
        },

        // ── Status ────────────────────────────────────────────────────
        status: {
            type:         DataTypes.ENUM('ACTIVE', 'FROZEN', 'SUSPENDED'),
            allowNull:    false,
            defaultValue: 'ACTIVE',
            comment:      'FROZEN: admin has paused payouts (e.g. fraud investigation). SUSPENDED: driver account suspended.',
        },

        frozenReason: {
            type:      DataTypes.STRING(300),
            allowNull: true,
            comment:   'Admin note when wallet was frozen. Null if ACTIVE.',
        },

        frozenAt: {
            type:      DataTypes.DATE,
            allowNull: true,
            comment:   'When the wallet was frozen.',
        },

        frozenBy: {
            type:      DataTypes.INTEGER,   // ← matches employees.id (int PK)
            allowNull: true,
            comment:   'FK → employees.id — which admin froze this wallet.',
        },

        // ── Currency ──────────────────────────────────────────────────
        currency: {
            type:         DataTypes.STRING(10),
            allowNull:    false,
            defaultValue: 'XAF',
            comment:      'ISO 4217 currency code. Always XAF for Cameroon.',
        },
    },
    {
        sequelize,
        modelName:   'DriverWallet',
        tableName:   'driver_wallets',
        timestamps:  true,
        underscored: false,   // DB uses camelCase column names — no underscored mapping
        indexes: [
            // Primary lookup: find wallet by driver
            { unique: true, fields: ['driverId'], name: 'driver_wallets_driver_unique' },

            // Admin: filter wallets by status (find FROZEN wallets)
            { fields: ['status'], name: 'driver_wallets_status' },

            // Admin: sort by balance for payout prioritisation
            { fields: ['balance'], name: 'driver_wallets_balance' },
        ],
    }
);

module.exports = DriverWallet;