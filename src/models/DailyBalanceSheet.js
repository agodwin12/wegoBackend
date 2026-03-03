// src/models/DailyBalanceSheet.js
//
// ═══════════════════════════════════════════════════════════════════════
// DAILY BALANCE SHEET
// ═══════════════════════════════════════════════════════════════════════
//
// One row per driver per day. Generated automatically by the midnight
// cron job (balanceSheetCron.js). Immutable once status = CLOSED.
//
// Logic:
//   cash_trips_count      = number of CASH trips completed that day
//   cash_gross_fare       = sum of grossFare on CASH trips
//   cash_commission_owed  = sum of commissionAmount on CASH trips
//                           → driver collected this cash, owes commission to WEGO
//
//   digital_trips_count   = number of MOMO/OM trips completed that day
//   digital_earned        = sum of driverNet on MOMO/OM trips
//                           → WEGO collected this, owes it to driver
//
//   net_position          = digital_earned - cash_commission_owed
//                           positive → WEGO owes driver
//                           negative → driver owes WEGO
//
//   debt_carried_forward  = unpaid debt from previous days (populated by cron)
//   total_debt            = cash_commission_owed + debt_carried_forward
//
// ═══════════════════════════════════════════════════════════════════════

'use strict';

const { DataTypes, Model } = require('sequelize');
const sequelize            = require('../config/database');

class DailyBalanceSheet extends Model {}

DailyBalanceSheet.init(
    {
        // ── Primary Key ───────────────────────────────────────────────
        id: {
            type:         DataTypes.CHAR(36),
            primaryKey:   true,
            defaultValue: DataTypes.UUIDV4,
        },

        // ── Who & When ────────────────────────────────────────────────
        driverId: {
            type:      DataTypes.CHAR(36),
            allowNull: false,
            field:     'driverId',
            references: { model: 'accounts', key: 'uuid' },
            comment:   'FK → accounts.uuid',
        },

        sheetDate: {
            type:      DataTypes.DATEONLY,
            allowNull: false,
            field:     'sheetDate',
            comment:   'The calendar date this sheet covers (YYYY-MM-DD, Cameroon time)',
        },

        // ── CASH trip figures ─────────────────────────────────────────
        cashTripsCount: {
            type:         DataTypes.INTEGER,
            allowNull:    false,
            defaultValue: 0,
            field:        'cashTripsCount',
            comment:      'Number of CASH trips completed this day',
        },

        cashGrossFare: {
            type:         DataTypes.INTEGER,
            allowNull:    false,
            defaultValue: 0,
            field:        'cashGrossFare',
            comment:      'Total fare collected in cash by driver (XAF)',
        },

        cashCommissionOwed: {
            type:         DataTypes.INTEGER,
            allowNull:    false,
            defaultValue: 0,
            field:        'cashCommissionOwed',
            comment:      'Commission WEGO is owed on cash trips = sum(commissionAmount) for CASH receipts',
        },

        // ── DIGITAL trip figures (MOMO + OM) ──────────────────────────
        digitalTripsCount: {
            type:         DataTypes.INTEGER,
            allowNull:    false,
            defaultValue: 0,
            field:        'digitalTripsCount',
            comment:      'Number of MOMO/OM trips completed this day',
        },

        digitalEarned: {
            type:         DataTypes.INTEGER,
            allowNull:    false,
            defaultValue: 0,
            field:        'digitalEarned',
            comment:      'Total driverNet WEGO owes driver from digital trips (XAF)',
        },

        // ── Debt tracking ─────────────────────────────────────────────
        debtCarriedForward: {
            type:         DataTypes.INTEGER,
            allowNull:    false,
            defaultValue: 0,
            field:        'debtCarriedForward',
            comment:      'Unpaid cash commission debt rolled over from previous days',
        },

        totalDebt: {
            type:         DataTypes.INTEGER,
            allowNull:    false,
            defaultValue: 0,
            field:        'totalDebt',
            comment:      'cashCommissionOwed + debtCarriedForward — total driver owes WEGO today',
        },

        // ── Net position ──────────────────────────────────────────────
        netPosition: {
            type:      DataTypes.INTEGER,
            allowNull: false,
            field:     'netPosition',
            comment:   'digitalEarned - totalDebt. Positive = WEGO owes driver. Negative = driver owes WEGO.',
        },

        // ── Payment tracking ──────────────────────────────────────────
        debtPaidAmount: {
            type:         DataTypes.INTEGER,
            allowNull:    false,
            defaultValue: 0,
            field:        'debtPaidAmount',
            comment:      'Amount driver has paid toward their debt today (confirmed by accountant)',
        },

        debtRemainingAmount: {
            type:         DataTypes.INTEGER,
            allowNull:    false,
            defaultValue: 0,
            field:        'debtRemainingAmount',
            comment:      'totalDebt - debtPaidAmount',
        },

        digitalPayoutAmount: {
            type:         DataTypes.INTEGER,
            allowNull:    false,
            defaultValue: 0,
            field:        'digitalPayoutAmount',
            comment:      'Amount paid out to driver from digital earnings (confirmed by accountant)',
        },

        digitalPayoutRemaining: {
            type:         DataTypes.INTEGER,
            allowNull:    false,
            defaultValue: 0,
            field:        'digitalPayoutRemaining',
            comment:      'digitalEarned - digitalPayoutAmount',
        },

        // ── Status ────────────────────────────────────────────────────
        status: {
            type:         DataTypes.ENUM('OPEN', 'CLOSED', 'DISPUTED'),
            allowNull:    false,
            defaultValue: 'OPEN',
            field:        'status',
            comment:      'OPEN = current day or awaiting settlement. CLOSED = fully settled. DISPUTED = accountant flagged.',
        },

        // ── Auto-block tracking ───────────────────────────────────────
        consecutiveUnpaidDays: {
            type:         DataTypes.INTEGER,
            allowNull:    false,
            defaultValue: 0,
            field:        'consecutiveUnpaidDays',
            comment:      'How many consecutive days this driver has unpaid debt. Reaches 2 → driver blocked.',
        },

        driverBlockedToday: {
            type:         DataTypes.BOOLEAN,
            allowNull:    false,
            defaultValue: false,
            field:        'driverBlockedToday',
            comment:      'True if the cron job blocked this driver today due to 2 consecutive unpaid days.',
        },

        // ── Notes ─────────────────────────────────────────────────────
        notes: {
            type:      DataTypes.TEXT,
            allowNull: true,
            field:     'notes',
            comment:   'Accountant notes for this sheet',
        },

        // ── Who closed it ─────────────────────────────────────────────
        closedBy: {
            type:      DataTypes.INTEGER,
            allowNull: true,
            field:     'closedBy',
            comment:   'FK → employees.id — who marked this sheet as CLOSED',
        },

        closedAt: {
            type:      DataTypes.DATE,
            allowNull: true,
            field:     'closedAt',
        },

        // ── Timestamps ────────────────────────────────────────────────
        createdAt: {
            type:  DataTypes.DATE,
            field: 'createdAt',
        },
        updatedAt: {
            type:  DataTypes.DATE,
            field: 'updatedAt',
        },
    },
    {
        sequelize,
        modelName:   'DailyBalanceSheet',
        tableName:   'daily_balance_sheets',
        underscored: false,
        timestamps:  true,
        indexes: [
            // Most common query: one sheet per driver per day
            {
                unique: true,
                fields: ['driverId', 'sheetDate'],
                name:   'daily_balance_sheets_driver_date_unique',
            },
            // Accountant views all open sheets
            { fields: ['status'],    name: 'daily_balance_sheets_status' },
            // Date-range reports
            { fields: ['sheetDate'], name: 'daily_balance_sheets_date'   },
            // Blocked driver tracking
            { fields: ['consecutiveUnpaidDays'], name: 'daily_balance_sheets_unpaid_days' },
        ],
    }
);

module.exports = DailyBalanceSheet;