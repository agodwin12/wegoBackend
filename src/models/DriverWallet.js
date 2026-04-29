// src/models/DriverWallet.js
'use strict';

const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class DriverWallet extends Model {}

DriverWallet.init(
    {
        id: {
            type:       DataTypes.CHAR(36),
            primaryKey: true,
            comment:    'UUID primary key',
        },

        driverId: {
            type:      DataTypes.CHAR(36),
            allowNull: false,
            unique:    true,
            comment:   'FK → accounts.uuid. UNIQUE: one wallet per driver.',
        },

        // ── Balances (integer XAF — no decimals) ──────────────────────────────

        balance: {
            type:         DataTypes.INTEGER,
            allowNull:    false,
            defaultValue: 0,
            comment:      'Running total of all transactions. Updated atomically with every wallet entry.',
        },

        totalEarned: {
            type:         DataTypes.INTEGER,
            allowNull:    false,
            defaultValue: 0,
            comment:      'Cumulative sum of all TRIP_FARE + BONUS credits. Never decremented.',
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

        // ── Payout tracking ───────────────────────────────────────────────────

        lastPayoutAt: {
            type:      DataTypes.DATE,
            allowNull: true,
            comment:   'Timestamp of the last PAYOUT transaction. For driver dashboard display.',
        },

        // ── Status ────────────────────────────────────────────────────────────

        status: {
            type:         DataTypes.ENUM('ACTIVE', 'FROZEN', 'SUSPENDED'),
            allowNull:    false,
            defaultValue: 'ACTIVE',
            comment:      'FROZEN: admin paused payouts. SUSPENDED: driver account suspended.',
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
            type:      DataTypes.INTEGER,
            allowNull: true,
            comment:   'FK → employees.id — which admin froze this wallet.',
        },

        // ── Currency ──────────────────────────────────────────────────────────

        currency: {
            type:         DataTypes.STRING(10),
            allowNull:    false,
            defaultValue: 'XAF',
            comment:      'ISO 4217 currency code. Always XAF for Cameroon.',
        },
    },
    {
        sequelize,
        modelName:  'DriverWallet',
        tableName:  'driver_wallets',
        timestamps: true,
        // DB uses camelCase column names — no underscored mapping
        underscored: false,
    }
);

module.exports = DriverWallet;