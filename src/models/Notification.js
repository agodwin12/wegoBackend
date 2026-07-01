// src/models/Notification.js
'use strict';

//
// ═══════════════════════════════════════════════════════════════════════
// NOTIFICATION — Per-user notification inbox row
// ═══════════════════════════════════════════════════════════════════════
//
// Every notification sent to a user creates one row here.
// This powers the in-app notifications inbox on Flutter side.
//
// Lifecycle:
//   - Created by NotificationService.send() for every notification type
//   - Marked is_read=true when user opens it in the inbox
//   - Auto-deleted by cleanup cron when expires_at < NOW() (7-day TTL)
//   - BroadcastMessage fan-out inserts rows here (one per target user)
//
// Deep-linking:
//   - `data` JSON field carries screen routing info for Flutter
//   - e.g. { "screen": "trip_detail", "trip_id": "123" }
//   - Flutter reads this on notification tap to navigate to the right screen
//
// ═══════════════════════════════════════════════════════════════════════

const { DataTypes, Model, Op } = require('sequelize');
const sequelize = require('../config/database');

// ── Notification type enum ────────────────────────────────────────────
// Keep this in sync with NotificationService and Flutter NotificationType
const NOTIFICATION_TYPES = [
    // Ride-Hailing (passenger)
    'RIDE_DRIVER_MATCHED',
    'RIDE_DRIVER_ARRIVED',
    'RIDE_CANCELLED',
    // Ride-Hailing (driver)
    'RIDE_TRIP_OFFER',
    'RIDE_OFFER_EXPIRED',
    'RIDE_PAYMENT_RECEIVED',

    // Delivery (sender)
    'DELIVERY_AGENT_ASSIGNED',
    'DELIVERY_PICKED_UP',
    'DELIVERY_CANCELLED',
    // Delivery (agent)
    'DELIVERY_OFFER',
    'DELIVERY_OFFER_EXPIRED',
    'DELIVERY_PAYMENT_RECEIVED',
    'DELIVERY_BONUS_EARNED',      // milestone/quest bonus credited to agent wallet

    // Services Marketplace (customer)
    'SERVICE_REQUEST_ACCEPTED',
    'SERVICE_REQUEST_REJECTED',
    'SERVICE_DISPUTE_RESOLVED',
    // Services Marketplace (provider)
    'SERVICE_NEW_REQUEST',        // a customer requested/contacted the provider
    'SERVICE_LISTING_APPROVED',   // moderator approved the post → now live
    'SERVICE_LISTING_REJECTED',   // moderator rejected the post (needs revision)

    // Wallet / Payments
    'WALLET_TOPUP_SUCCESS',
    'WALLET_TOPUP_FAILED',
    'WALLET_WITHDRAWAL_REQUESTED',
    'WALLET_WITHDRAWAL_COMPLETED',
    'WALLET_WITHDRAWAL_FAILED',

    // Car Rental
    'RENTAL_APPROVED',
    'RENTAL_EXPIRY_REMINDER',

    // Auth & Account
    'ACCOUNT_APPROVED',
    'ACCOUNT_SUSPENDED',
    'ACCOUNT_PASSWORD_CHANGED',
    'ACCOUNT_NEW_DEVICE_LOGIN',

    // Support
    'SUPPORT_TICKET_REPLY',
    'SUPPORT_TICKET_RESOLVED',

    // Backoffice Broadcast
    'BROADCAST',
];

class Notification extends Model {

    // ── Mark this notification as read ───────────────────────────────
    async markAsRead() {
        if (!this.is_read) {
            this.is_read = true;
            this.read_at = new Date();
            await this.save();
        }
        return this;
    }

    // ── Unread count for a user ───────────────────────────────────────
    static async unreadCount(accountUuid) {
        return Notification.count({
            where: {
                account_uuid: accountUuid,
                is_read:      false,
                expires_at:   { [Op.gt]: new Date() },
            },
        });
    }

    // ── Mark all notifications as read for a user ─────────────────────
    static async markAllRead(accountUuid) {
        return Notification.update(
            { is_read: true, read_at: new Date() },
            {
                where: {
                    account_uuid: accountUuid,
                    is_read:      false,
                },
            }
        );
    }
}

Notification.init(
    {
        // ─────────────────────────────────────────────────────────────
        // PRIMARY KEY
        // ─────────────────────────────────────────────────────────────

        id: {
            type:         DataTypes.CHAR(36),
            primaryKey:   true,
            defaultValue: DataTypes.UUIDV4,
        },

        // ─────────────────────────────────────────────────────────────
        // OWNER
        // ─────────────────────────────────────────────────────────────

        account_uuid: {
            type:       DataTypes.CHAR(36),
            allowNull:  false,
            references: { model: 'accounts', key: 'uuid' },
            onDelete:   'CASCADE',
            comment:    'FK → accounts.uuid. Row deleted when account is deleted.',
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
        // TYPE
        // ─────────────────────────────────────────────────────────────
        //
        // Used by Flutter to decide which screen to open on tap.
        // Must stay in sync with NOTIFICATION_TYPES and Flutter's
        // NotificationType enum.
        // ─────────────────────────────────────────────────────────────

        type: {
            type:      DataTypes.ENUM(...NOTIFICATION_TYPES),
            allowNull: false,
        },

        // ─────────────────────────────────────────────────────────────
        // DEEP-LINK PAYLOAD
        // ─────────────────────────────────────────────────────────────
        //
        // JSON passed to Flutter on notification tap for screen routing.
        // Examples:
        //   { "screen": "trip_detail",      "trip_id": "123" }
        //   { "screen": "delivery_detail",  "delivery_code": "WG-DEL-001" }
        //   { "screen": "wallet" }
        //   { "screen": "support_ticket",   "ticket_id": "45" }
        // ─────────────────────────────────────────────────────────────

        data: {
            type:         DataTypes.JSON,
            allowNull:    true,
            defaultValue: null,
        },

        // ─────────────────────────────────────────────────────────────
        // BROADCAST REFERENCE
        // ─────────────────────────────────────────────────────────────
        //
        // Set when this notification was generated by a backoffice
        // broadcast. NULL for all system-generated notifications.
        // ─────────────────────────────────────────────────────────────

        broadcast_id: {
            type:         DataTypes.INTEGER.UNSIGNED,
            allowNull:    true,
            defaultValue: null,
            references:   { model: 'broadcast_messages', key: 'id' },
            onDelete:     'SET NULL',
            comment:      'FK → broadcast_messages.id',
        },

        // ─────────────────────────────────────────────────────────────
        // READ STATE
        // ─────────────────────────────────────────────────────────────

        is_read: {
            type:         DataTypes.BOOLEAN,
            allowNull:    false,
            defaultValue: false,
        },

        read_at: {
            type:      DataTypes.DATE,
            allowNull: true,
        },

        // ─────────────────────────────────────────────────────────────
        // TTL
        // ─────────────────────────────────────────────────────────────
        //
        // Auto-set to created_at + 7 days by the beforeCreate hook.
        // Cleanup cron (notification_cleaner.js) deletes rows where
        // expires_at < NOW() daily at 02:00.
        // ─────────────────────────────────────────────────────────────

        expires_at: {
            type:         DataTypes.DATE,
            allowNull:    false,
            // 7-day inbox TTL. Previously this had no default, so every
            // NotificationService.send() failed the notNull check and no
            // notification was ever persisted to the inbox — only the FCM push
            // fired. This default restores the in-app inbox.
            defaultValue: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            comment:      'Auto-set to created_at + 7 days.',
        },
    },
    {
        sequelize,
        modelName:  'Notification',
        tableName:  'notifications',
        timestamps: true,
        // The notifications table has created_at but NO updated_at column, so
        // Sequelize's updated_at insert must be disabled (it was silently
        // breaking every inbox persist). read_at tracks the only mutation.
        updatedAt:  false,
        underscored: true,

        indexes: [
            // Inbox query: all notifications for a user, newest first
            { fields: ['account_uuid', 'created_at'] },
            // Unread count query
            { fields: ['account_uuid', 'is_read'] },
            // Cron cleanup query
            { fields: ['expires_at'] },
            // Broadcast delivery tracking
            { fields: ['broadcast_id'] },
        ],

        hooks: {
            // Auto-set expires_at = now + 7 days on insert
            beforeCreate(notification) {
                const now = new Date();
                notification.expires_at = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
            },
        },
    }
);

// ── Associations ──────────────────────────────────────────────────────
Notification.associate = (models) => {
    Notification.belongsTo(models.Account, {
        foreignKey: 'account_uuid',
        targetKey:  'uuid',
        as:         'account',
    });

    if (models.BroadcastMessage) {
        Notification.belongsTo(models.BroadcastMessage, {
            foreignKey: 'broadcast_id',
            as:         'broadcast',
        });
    }
};

module.exports = Notification;
module.exports.NOTIFICATION_TYPES = NOTIFICATION_TYPES;