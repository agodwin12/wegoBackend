// src/models/PayoutRequest.js
//
// ═══════════════════════════════════════════════════════════════════════
// PAYOUT REQUEST
// ═══════════════════════════════════════════════════════════════════════
//
// Full employee audit trail:
//   initiatedByEmployeeId  → who created it (when BACKOFFICE-initiated)
//   processedBy            → who clicked "Start Processing"
//   confirmedBy            → who clicked "Mark as Paid" (may differ from processedBy)
//   rejectedBy             → who rejected it
//
// A different accountant may confirm a payout than the one who started
// processing it (e.g. shift change). Both are recorded separately.
//
// ═══════════════════════════════════════════════════════════════════════

'use strict';

const { DataTypes, Model } = require('sequelize');
const sequelize            = require('../config/database');

class PayoutRequest extends Model {

    /**
     * Returns true if this request has passed its 12-hour SLA deadline
     * and is still PENDING or PROCESSING.
     */
    isOverdue() {
        if (!['PENDING', 'PROCESSING'].includes(this.status)) return false;
        const deadline = new Date(this.createdAt);
        deadline.setHours(deadline.getHours() + 12);
        return new Date() > deadline;
    }

    /**
     * Returns the SLA deadline timestamp (createdAt + 12h)
     */
    getDeadline() {
        const deadline = new Date(this.createdAt);
        deadline.setHours(deadline.getHours() + 12);
        return deadline;
    }

    /**
     * Returns minutes remaining until SLA deadline.
     * Negative = already overdue.
     */
    minutesUntilDeadline() {
        const deadline = new Date(this.createdAt);
        deadline.setHours(deadline.getHours() + 12);
        return Math.round((deadline - new Date()) / 60000);
    }
}

PayoutRequest.init(
    {
        // ── Primary Key ───────────────────────────────────────────────
        id: {
            type:         DataTypes.CHAR(36),
            primaryKey:   true,
            defaultValue: DataTypes.UUIDV4,
        },

        // ── Human-readable reference ──────────────────────────────────
        referenceNumber: {
            type:      DataTypes.STRING(30),
            allowNull: false,
            unique:    true,
            field:     'referenceNumber',
            comment:   'e.g. PAY-20260301-42857',
        },

        // ── Who is being paid ─────────────────────────────────────────
        driverId: {
            type:       DataTypes.CHAR(36),
            allowNull:  false,
            field:      'driverId',
            references: { model: 'accounts', key: 'uuid' },
            comment:    'FK → accounts.uuid',
        },

        // ── Which balance sheet ───────────────────────────────────────
        balanceSheetId: {
            type:       DataTypes.CHAR(36),
            allowNull:  true,
            field:      'balanceSheetId',
            references: { model: 'daily_balance_sheets', key: 'id' },
        },

        // ── Amount ────────────────────────────────────────────────────
        amount: {
            type:      DataTypes.INTEGER,
            allowNull: false,
            field:     'amount',
            comment:   'XAF to pay driver',
        },

        // ── Payment method & destination ──────────────────────────────
        paymentMethod: {
            type:      DataTypes.ENUM('CASH', 'MOMO', 'OM'),
            allowNull: false,
            field:     'paymentMethod',
        },

        paymentPhone: {
            type:      DataTypes.STRING(20),
            allowNull: true,
            field:     'paymentPhone',
            comment:   'Phone for MOMO/OM. Null for CASH.',
        },

        // ── Who initiated ─────────────────────────────────────────────
        initiatedBy: {
            type:         DataTypes.ENUM('DRIVER', 'BACKOFFICE'),
            allowNull:    false,
            defaultValue: 'DRIVER',
            field:        'initiatedBy',
        },

        initiatedByEmployeeId: {
            type:       DataTypes.INTEGER,
            allowNull:  true,
            field:      'initiatedByEmployeeId',
            references: { model: 'employees', key: 'id' },
            comment:    'FK → employees.id. Populated when initiatedBy = BACKOFFICE.',
        },

        // ── Driver note ───────────────────────────────────────────────
        driverNote: {
            type:      DataTypes.TEXT,
            allowNull: true,
            field:     'driverNote',
        },

        // ── Status ────────────────────────────────────────────────────
        status: {
            type:         DataTypes.ENUM('PENDING', 'PROCESSING', 'PAID', 'REJECTED', 'CANCELLED'),
            allowNull:    false,
            defaultValue: 'PENDING',
            field:        'status',
        },

        // ── SLA ───────────────────────────────────────────────────────
        slaDeadline: {
            type:      DataTypes.DATE,
            allowNull: false,
            field:     'slaDeadline',
            comment:   'createdAt + 12 hours',
        },

        // ── AUDIT TRAIL — one field per employee action ───────────────

        // Who started processing (status → PROCESSING)
        processedBy: {
            type:       DataTypes.INTEGER,
            allowNull:  true,
            field:      'processedBy',
            references: { model: 'employees', key: 'id' },
            comment:    'Employee who clicked Start Processing',
        },
        processedAt: {
            type:      DataTypes.DATE,
            allowNull: true,
            field:     'processedAt',
        },

        // Who confirmed payment (status → PAID) — may differ from processedBy
        confirmedBy: {
            type:       DataTypes.INTEGER,
            allowNull:  true,
            field:      'confirmedBy',
            references: { model: 'employees', key: 'id' },
            comment:    'Employee who clicked Mark as Paid and uploaded proof',
        },
        confirmedAt: {
            type:      DataTypes.DATE,
            allowNull: true,
            field:     'confirmedAt',
        },

        // Who rejected it
        rejectedBy: {
            type:       DataTypes.INTEGER,
            allowNull:  true,
            field:      'rejectedBy',
            references: { model: 'employees', key: 'id' },
            comment:    'Employee who rejected this request',
        },
        rejectedAt: {
            type:      DataTypes.DATE,
            allowNull: true,
            field:     'rejectedAt',
        },

        // Who cancelled it
        cancelledBy: {
            type:       DataTypes.INTEGER,
            allowNull:  true,
            field:      'cancelledBy',
            references: { model: 'employees', key: 'id' },
            comment:    'Employee who cancelled this request (null if cancelled by driver)',
        },
        cancelledAt: {
            type:      DataTypes.DATE,
            allowNull: true,
            field:     'cancelledAt',
        },

        // ── Proof of payment ──────────────────────────────────────────
        transactionRef: {
            type:      DataTypes.STRING(100),
            allowNull: true,
            field:     'transactionRef',
            comment:   'MoMo/OM transaction ref entered by confirmedBy employee',
        },

        proofUrl: {
            type:      DataTypes.STRING(500),
            allowNull: true,
            field:     'proofUrl',
            comment:   'R2 URL of payment proof screenshot uploaded by confirmedBy employee',
        },

        paidAt: {
            type:      DataTypes.DATE,
            allowNull: true,
            field:     'paidAt',
        },

        // ── Rejection reason ──────────────────────────────────────────
        rejectionReason: {
            type:      DataTypes.TEXT,
            allowNull: true,
            field:     'rejectionReason',
            comment:   'Visible to driver',
        },

        // ── Internal notes ────────────────────────────────────────────
        accountantNotes: {
            type:      DataTypes.TEXT,
            allowNull: true,
            field:     'accountantNotes',
            comment:   'Internal only — not shown to driver',
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
        modelName:   'PayoutRequest',
        tableName:   'payout_requests',
        underscored: false,
        timestamps:  true,

        hooks: {
            beforeCreate: async (record) => {
                const now = new Date();
                // SLA = createdAt + 12 hours
                record.slaDeadline = new Date(now.getTime() + 12 * 60 * 60 * 1000);
                // Auto-generate reference number
                if (!record.referenceNumber) {
                    const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
                    const random   = Math.floor(10000 + Math.random() * 90000);
                    record.referenceNumber = `PAY-${datePart}-${random}`;
                }
            },
        },

        indexes: [
            { fields: ['status'],                name: 'payout_requests_status'     },
            { fields: ['driverId'],              name: 'payout_requests_driver'     },
            { fields: ['slaDeadline'],           name: 'payout_requests_sla'        },
            { fields: ['balanceSheetId'],        name: 'payout_requests_sheet'      },
            { fields: ['initiatedByEmployeeId'], name: 'payout_requests_initiated'  },
            { fields: ['processedBy'],           name: 'payout_requests_processed'  },
            { fields: ['confirmedBy'],           name: 'payout_requests_confirmed'  },
            { fields: ['rejectedBy'],            name: 'payout_requests_rejected'   },
            { unique: true, fields: ['referenceNumber'], name: 'payout_requests_ref_unique' },
        ],
    }
);

module.exports = PayoutRequest;