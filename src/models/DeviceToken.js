// src/models/DeviceToken.js
'use strict';

//
// ═══════════════════════════════════════════════════════════════════════
// DEVICE TOKEN — FCM push token per device per account
// ═══════════════════════════════════════════════════════════════════════
//
// One row per physical device. A single account can have multiple rows
// if they log in from multiple devices (phone + tablet etc.).
//
// Lifecycle:
//   - Created / upserted when the Flutter app registers or refreshes
//     its FCM token (on login, on app open, on token refresh callback)
//   - is_active = false when:
//       a) user logs out from this device
//       b) FCM returns token-not-registered (stale token)
//       c) a newer token is registered for the same device_id
//   - NotificationService always queries is_active = true, ordered by
//     updated_at DESC so the freshest token is used
//
// Flutter side:
//   - Call POST /api/device-tokens on login and on
//     FirebaseMessaging.onTokenRefresh callback
//   - Call DELETE /api/device-tokens on logout
//
// ═══════════════════════════════════════════════════════════════════════

const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class DeviceToken extends Model {}

DeviceToken.init(
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
        // OWNER
        // ─────────────────────────────────────────────────────────────

        account_uuid: {
            type:       DataTypes.CHAR(36),
            allowNull:  false,
            references: { model: 'accounts', key: 'uuid' },
            onDelete:   'CASCADE',
            comment:    'FK → accounts.uuid. Tokens deleted when account is deleted.',
        },

        // ─────────────────────────────────────────────────────────────
        // DEVICE IDENTITY
        // ─────────────────────────────────────────────────────────────
        //
        // device_id: stable hardware/install identifier from Flutter.
        // Use package:device_info_plus to get:
        //   Android → androidInfo.id
        //   iOS     → iosInfo.identifierForVendor
        //
        // Used to upsert: same device_id + account = update token,
        // don't insert a duplicate row.
        // ─────────────────────────────────────────────────────────────

        device_id: {
            type:      DataTypes.STRING(255),
            allowNull: false,
            comment:   'Stable device identifier from Flutter device_info_plus.',
        },

        // ─────────────────────────────────────────────────────────────
        // FCM TOKEN
        // ─────────────────────────────────────────────────────────────

        fcm_token: {
            type:      DataTypes.TEXT,
            allowNull: false,
            comment:   'Firebase Cloud Messaging registration token.',
        },

        // ─────────────────────────────────────────────────────────────
        // PLATFORM
        // ─────────────────────────────────────────────────────────────

        platform: {
            type:      DataTypes.ENUM('android', 'ios'),
            allowNull: false,
            comment:   'Device OS — used for platform-specific FCM config.',
        },

        // ─────────────────────────────────────────────────────────────
        // STATUS
        // ─────────────────────────────────────────────────────────────
        //
        // Set to false on logout or when FCM reports the token as stale.
        // NotificationService only queries is_active = true tokens.
        // ─────────────────────────────────────────────────────────────

        is_active: {
            type:         DataTypes.BOOLEAN,
            allowNull:    false,
            defaultValue: true,
        },
    },
    {
        sequelize,
        modelName:   'DeviceToken',
        tableName:   'device_tokens',
        timestamps:  true,
        underscored: true,

        indexes: [
            // NotificationService lookup: active token for an account
            { fields: ['account_uuid', 'is_active'] },
            // Upsert lookup: same device re-registering
            {
                fields:  ['account_uuid', 'device_id'],
                unique:  true,
                name:    'device_tokens_account_device_unique',
            },
        ],
    }
);

// ── Associations ──────────────────────────────────────────────────────
DeviceToken.associate = (models) => {
    DeviceToken.belongsTo(models.Account, {
        foreignKey: 'account_uuid',
        targetKey:  'uuid',
        as:         'account',
    });
};

module.exports = DeviceToken;