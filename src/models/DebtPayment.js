// src/models/DebtPayment.js
//
// ═══════════════════════════════════════════════════════════════════════
// DEBT PAYMENT
// ═══════════════════════════════════════════════════════════════════════
//
// Represents a payment FROM a driver TO WEGO to settle their cash
// commission debt.
//
// How it works:
//   1. Driver submits proof of payment (MoMo/OM screenshot) via app
//      OR contacts WhatsApp agent who creates the record in backoffice
//   2. Accountant verifies the proof and confirms/rejects
//   3. On confirmation → DailyBalanceSheet.debtPaidAmount increases
//                      → DailyBalanceSheet.debtRemainingAmount decreases
//                      → consecutiveUnpaidDays resets if fully paid
//                      → driver unblocked if they were blocked
//
// Payment methods:
//   CASH   → driver paid an agent physically
//   MOMO   → driver sent MTN Mobile Money to WEGO number
//   OM     → driver sent Orange Money to WEGO number
//
// Lifecycle:
//   PENDING     → submitted, waiting for accountant verification
//   CONFIRMED   → accountant verified, debt reduced
//   REJECTED    → accountant rejected (wrong amount, fake proof, etc.)
//
// ═══════════════════════════════════════════════════════════════════════

'use strict';

const { DataTypes, Model } = require('sequelize');
const sequelize            = require('../config/database');

class DebtPayment extends Model {

    /**
     * Returns true if this payment has been waiting more than 6 hours
     * and is still PENDING. Accountants should verify faster than payouts
     * since blocking is at stake.
     */
    isOverdue() {
        if (this.status !== 'PENDING') return false;
        const deadline = new Date(this.createdAt);
        deadline.setHours(deadline.getHours() + 6);
        return new Date() > deadline;
    }
}

DebtPayment.init(
    {
        // ── Primary Key ───────────────────────────────────────────────
        id: {
            type:         DataTypes.CHAR(36),
            primaryKey:   true,
            defaultValue: DataTypes.UUIDV4,
        },

        // ── Reference number ──────────────────────────────────────────
        referenceNumber: {
            type:      DataTypes.STRING(30),
            allowNull: false,
            unique:    true,
            field:     'referenceNumber',
            comment:   'Human-readable reference e.g. DEBT-20260301-00042',
        },

        // ── Who is paying ─────────────────────────────────────────────
        driverId: {
            type:      DataTypes.CHAR(36),
            allowNull: false,
            field:     'driverId',
            references: { model: 'accounts', key: 'uuid' },
            comment:   'FK → accounts.uuid (the driver paying their debt)',
        },

        // ── Which balance sheet(s) this payment covers ────────────────
        balanceSheetId: {
            type:      DataTypes.CHAR(36),
            allowNull: true,
            field:     'balanceSheetId',
            references: { model: 'daily_balance_sheets', key: 'id' },
            comment:   'FK → daily_balance_sheets.id. The primary sheet being settled. Null if paying accumulated multi-day debt.',
        },

        // ── Amount ────────────────────────────────────────────────────
        amount: {
            type:      DataTypes.INTEGER,
            allowNull: false,
            field:     'amount',
            comment:   'Amount driver is paying to WEGO in XAF',
        },

        // ── Payment method ────────────────────────────────────────────
        paymentMethod: {
            type:      DataTypes.ENUM('CASH', 'MOMO', 'OM'),
            allowNull: false,
            field:     'paymentMethod',
            comment:   'How the driver paid WEGO',
        },

        // ── Transaction reference (from driver's MoMo/OM receipt) ──────
        driverTransactionRef: {
            type:      DataTypes.STRING(100),
            allowNull: true,
            field:     'driverTransactionRef',
            comment:   'Transaction reference from driver MoMo/OM receipt. Driver enters this manually.',
        },

        // ── Proof submitted by driver ─────────────────────────────────
        proofUrl: {
            type:      DataTypes.STRING(500),
            allowNull: true,
            field:     'proofUrl',
            comment:   'R2 URL of MoMo/OM screenshot uploaded by driver via app',
        },

        // ── How it was submitted ──────────────────────────────────────
        submittedVia: {
            type:         DataTypes.ENUM('APP', 'WHATSAPP_AGENT', 'BACKOFFICE'),
            allowNull:    false,
            defaultValue: 'APP',
            field:        'submittedVia',
            comment:      'APP = driver uploaded proof in app. WHATSAPP_AGENT = agent created record after WhatsApp contact. BACKOFFICE = accountant created directly.',
        },

        // ── Agent who handled WhatsApp submission ──────────────────────
        handledByEmployeeId: {
            type:      DataTypes.INTEGER,
            allowNull: true,
            field:     'handledByEmployeeId',
            references: { model: 'employees', key: 'id' },
            comment:   'FK → employees.id. Populated when submittedVia = WHATSAPP_AGENT or BACKOFFICE.',
        },

        // ── Driver note ───────────────────────────────────────────────
        driverNote: {
            type:      DataTypes.TEXT,
            allowNull: true,
            field:     'driverNote',
            comment:   'Optional note from driver (e.g. "paid via Orange Money to 699000000")',
        },

        // ── Status ────────────────────────────────────────────────────
        status: {
            type:         DataTypes.ENUM('PENDING', 'CONFIRMED', 'REJECTED'),
            allowNull:    false,
            defaultValue: 'PENDING',
            field:        'status',
        },

        // ── Accountant verification ───────────────────────────────────
        verifiedBy: {
            type:      DataTypes.INTEGER,
            allowNull: true,
            field:     'verifiedBy',
            references: { model: 'employees', key: 'id' },
            comment:   'FK → employees.id — accountant who confirmed or rejected',
        },

        verifiedAt: {
            type:      DataTypes.DATE,
            allowNull: true,
            field:     'verifiedAt',
        },

        // ── WEGO transaction reference (accountant enters after verifying) ─
        wegoTransactionRef: {
            type:      DataTypes.STRING(100),
            allowNull: true,
            field:     'wegoTransactionRef',
            comment:   'Reference accountant confirms on WEGO side (e.g. from WEGO MoMo account dashboard)',
        },

        // ── Rejection ─────────────────────────────────────────────────
        rejectionReason: {
            type:      DataTypes.TEXT,
            allowNull: true,
            field:     'rejectionReason',
            comment:   'Required when status → REJECTED. Visible to driver.',
        },

        rejectedBy: {
            type:      DataTypes.INTEGER,
            allowNull: true,
            field:     'rejectedBy',
            references: { model: 'employees', key: 'id' },
        },

        rejectedAt: {
            type:      DataTypes.DATE,
            allowNull: true,
            field:     'rejectedAt',
        },

        // ── Effect on debt (populated when CONFIRMED) ──────────────────
        debtBeforePayment: {
            type:      DataTypes.INTEGER,
            allowNull: true,
            field:     'debtBeforePayment',
            comment:   'Snapshot of debtRemainingAmount before this payment was applied. For audit.',
        },

        debtAfterPayment: {
            type:      DataTypes.INTEGER,
            allowNull: true,
            field:     'debtAfterPayment',
            comment:   'Snapshot of debtRemainingAmount after this payment was applied. For audit.',
        },

        // ── Did this payment trigger an unblock? ──────────────────────
        triggeredUnblock: {
            type:         DataTypes.BOOLEAN,
            allowNull:    false,
            defaultValue: false,
            field:        'triggeredUnblock',
            comment:      'True if confirming this payment caused the driver to be unblocked.',
        },

        // ── Accountant internal notes ─────────────────────────────────
        accountantNotes: {
            type:      DataTypes.TEXT,
            allowNull: true,
            field:     'accountantNotes',
            comment:   'Internal notes — not shown to driver',
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
        modelName:   'DebtPayment',
        tableName:   'debt_payments',
        underscored: false,
        timestamps:  true,

        hooks: {
            // Auto-generate reference number on creation
            beforeCreate: async (record) => {
                if (!record.referenceNumber) {
                    const now      = new Date();
                    const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
                    const random   = Math.floor(10000 + Math.random() * 90000);
                    record.referenceNumber = `DEBT-${datePart}-${random}`;
                }
            },
        },

        indexes: [
            // Accountant queue — all pending verifications
            { fields: ['status'],                name: 'debt_payments_status'      },
            // Driver payment history
            { fields: ['driverId'],              name: 'debt_payments_driver'      },
            // Link to balance sheet
            { fields: ['balanceSheetId'],        name: 'debt_payments_sheet'       },
            // Human-readable lookup
            { unique: true, fields: ['referenceNumber'], name: 'debt_payments_ref_unique' },
            // Find by driver transaction ref (for duplicate detection)
            { fields: ['driverTransactionRef'],  name: 'debt_payments_driver_txref'},
        ],
    }
);

module.exports = DebtPayment;