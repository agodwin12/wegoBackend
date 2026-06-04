// src/models/BroadcastMessage.js
'use strict';

//
// ═══════════════════════════════════════════════════════════════════════
// BROADCAST MESSAGE — Backoffice-initiated mass notifications
// ═══════════════════════════════════════════════════════════════════════
//
// Backoffice employees create broadcast messages targeting an account
// type (or ALL). Each broadcast fans out to one Notification row per
// matching active account.
//
// Status flow:
//   DRAFT ──► SCHEDULED ──► SENT
//                │
//                └──► CANCELLED  (only cancellable from SCHEDULED)
//
// Fan-out:
//   - Immediate (scheduled_at IS NULL or scheduled_at <= NOW()):
//       NotificationService.sendBroadcast() called directly from the
//       backoffice controller on creation.
//   - Scheduled (scheduled_at > NOW()):
//       notification_cleaner.js cron (every minute) picks it up when due
//       and calls NotificationService.sendBroadcast().
//
// Audit:
//   - BroadcastMessage rows are NEVER deleted — kept for audit trail.
//   - The Notification rows generated from a broadcast expire after 7 days.
//
// ═══════════════════════════════════════════════════════════════════════

const { DataTypes, Model, Op } = require('sequelize');
const sequelize = require('../config/database');

// ── Enums ─────────────────────────────────────────────────────────────
const BROADCAST_TARGET_TYPES = ['PASSENGER', 'DRIVER', 'DELIVERY_AGENT', 'ALL'];
const BROADCAST_STATUSES     = ['DRAFT', 'SCHEDULED', 'SENT', 'CANCELLED'];

class BroadcastMessage extends Model {

    // ── Due broadcasts for cron job ───────────────────────────────────
    static async getDue() {
        return BroadcastMessage.findAll({
            where: {
                status:       'SCHEDULED',
                scheduled_at: { [Op.lte]: new Date() },
            },
        });
    }

    // ── Can this broadcast still be cancelled? ────────────────────────
    get isCancellable() {
        return this.status === 'SCHEDULED';
    }

    // ── Is this broadcast immediate (no future schedule)? ────────────
    get isImmediate() {
        return !this.scheduled_at || new Date(this.scheduled_at) <= new Date();
    }
}

BroadcastMessage.init(
    {
        // ─────────────────────────────────────────────────────────────
        // PRIMARY KEY
        // ─────────────────────────────────────────────────────────────

        id: {
            type:          DataTypes.INTEGER.UNSIGNED,
            primaryKey:    true,
            autoIncrement: true,
        },

        // ─────────────────────────────────────────────────────────────
        // CONTENT
        // ─────────────────────────────────────────────────────────────

        title: {
            type:      DataTypes.STRING(255),
            allowNull: false,
        },

        body: {
            type:      DataTypes.TEXT,
            allowNull: false,
        },

        // ─────────────────────────────────────────────────────────────
        // TARGET
        // ─────────────────────────────────────────────────────────────
        //
        // Which account type receives this broadcast.
        // ALL = every active account regardless of type.
        // ─────────────────────────────────────────────────────────────

        target_type: {
            type:      DataTypes.ENUM(...BROADCAST_TARGET_TYPES),
            allowNull: false,
        },

        // ─────────────────────────────────────────────────────────────
        // DEEP-LINK PAYLOAD
        // ─────────────────────────────────────────────────────────────
        //
        // Optional JSON copied into each Notification.data on fan-out.
        // e.g. { "screen": "promotions" } or null
        // ─────────────────────────────────────────────────────────────

        data: {
            type:         DataTypes.JSON,
            allowNull:    true,
            defaultValue: null,
        },

        // ─────────────────────────────────────────────────────────────
        // STATUS
        // ─────────────────────────────────────────────────────────────

        status: {
            type:         DataTypes.ENUM(...BROADCAST_STATUSES),
            allowNull:    false,
            defaultValue: 'SCHEDULED',
            comment:      'DRAFT → SCHEDULED → SENT | CANCELLED',
        },

        // ─────────────────────────────────────────────────────────────
        // SCHEDULING
        // ─────────────────────────────────────────────────────────────
        //
        // NULL     → send immediately on creation
        // Future   → cron picks up when scheduled_at <= NOW()
        // ─────────────────────────────────────────────────────────────

        scheduled_at: {
            type:      DataTypes.DATE,
            allowNull: true,
            comment:   'NULL = immediate. Future datetime = scheduled delivery.',
        },

        // ─────────────────────────────────────────────────────────────
        // DELIVERY TRACKING
        // ─────────────────────────────────────────────────────────────

        sent_at: {
            type:      DataTypes.DATE,
            allowNull: true,
            comment:   'Set by NotificationService when fan-out completes.',
        },

        recipients_count: {
            type:         DataTypes.INTEGER.UNSIGNED,
            allowNull:    false,
            defaultValue: 0,
            comment:      'Number of Notification rows created during fan-out.',
        },

        // ─────────────────────────────────────────────────────────────
        // AUDIT
        // ─────────────────────────────────────────────────────────────

        created_by: {
            type:       DataTypes.INTEGER,
            allowNull:  false,
            references: { model: 'employees', key: 'id' },
            comment:    'FK → employees.id — employee who created this broadcast.',
        },

        cancelled_by: {
            type:       DataTypes.INTEGER,
            allowNull:  true,
            references: { model: 'employees', key: 'id' },
            comment:    'FK → employees.id — set when status = CANCELLED.',
        },

        cancelled_at: {
            type:      DataTypes.DATE,
            allowNull: true,
        },
    },
    {
        sequelize,
        modelName:   'BroadcastMessage',
        tableName:   'broadcast_messages',
        timestamps:  true,
        underscored: true,

        indexes: [
            // Cron query: due scheduled broadcasts
            { fields: ['status', 'scheduled_at'] },
            // Backoffice list by creator
            { fields: ['created_by'] },
            // Backoffice filter by target type
            { fields: ['target_type'] },
        ],
    }
);

// ── Associations ──────────────────────────────────────────────────────
BroadcastMessage.associate = (models) => {
    BroadcastMessage.belongsTo(models.Employee, {
        foreignKey: 'created_by',
        as:         'creator',
    });

    BroadcastMessage.belongsTo(models.Employee, {
        foreignKey: 'cancelled_by',
        as:         'canceller',
    });

    if (models.Notification) {
        BroadcastMessage.hasMany(models.Notification, {
            foreignKey: 'broadcast_id',
            as:         'notifications',
        });
    }
};

module.exports = BroadcastMessage;
module.exports.BROADCAST_TARGET_TYPES = BROADCAST_TARGET_TYPES;
module.exports.BROADCAST_STATUSES     = BROADCAST_STATUSES;