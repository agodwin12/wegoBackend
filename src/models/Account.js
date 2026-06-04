// src/models/Account.js
'use strict';

//
// ═══════════════════════════════════════════════════════════════════════
// ACCOUNT MODEL
// ═══════════════════════════════════════════════════════════════════════
//
// Required DB migration for Google OAuth:
//
// ALTER TABLE accounts
//   ADD COLUMN google_id VARCHAR(255) NULL AFTER active_mode,
//   ADD COLUMN auth_provider ENUM('LOCAL', 'GOOGLE', 'LOCAL_GOOGLE')
//     NOT NULL DEFAULT 'LOCAL' AFTER google_id,
//   ADD COLUMN last_login_provider ENUM('LOCAL', 'GOOGLE')
//     NULL AFTER auth_provider,
//   ADD COLUMN google_avatar_url VARCHAR(500)
//     NULL AFTER last_login_provider;
//
// ALTER TABLE accounts
//   MODIFY COLUMN password_hash VARCHAR(255) NULL,
//   MODIFY COLUMN password_algo VARCHAR(32) NULL DEFAULT 'bcrypt';
//
// CREATE UNIQUE INDEX accounts_google_id_unique
//   ON accounts (google_id);
//
// CREATE INDEX accounts_auth_provider_idx
//   ON accounts (auth_provider);
//
// CREATE INDEX accounts_email_provider_idx
//   ON accounts (email, auth_provider);
//
// ═══════════════════════════════════════════════════════════════════════

const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class Account extends Model {}

Account.init(
    {
        // ─────────────────────────────────────────────────────────────
        // PRIMARY KEY
        // ─────────────────────────────────────────────────────────────

        uuid: {
            type: DataTypes.CHAR(36),
            defaultValue: DataTypes.UUIDV4,
            allowNull: false,
            unique: true,
            primaryKey: true,
        },

        // ─────────────────────────────────────────────────────────────
        // BASE ROLE
        // ─────────────────────────────────────────────────────────────
        //
        // user_type = permanent/base identity of the account.
        // active_mode = current operating mode.
        //
        // Google OAuth is allowed only for PASSENGER and DRIVER.
        // DELIVERY_AGENT accounts must remain internally/admin-created.
        // Enforcement is done in the Google auth service/controller.
        // ─────────────────────────────────────────────────────────────

        user_type: {
            type: DataTypes.ENUM(
                'PASSENGER',
                'DRIVER',
                'PARTNER',
                'ADMIN',
                'DELIVERY_AGENT'
            ),
            allowNull: false,
            comment: 'Permanent base role set at registration. Never changes.',
        },

        active_mode: {
            type: DataTypes.ENUM(
                'PASSENGER',
                'DRIVER',
                'DELIVERY_AGENT'
            ),
            allowNull: true,
            defaultValue: null,
            comment:
                'Current operating mode. NULL = same as user_type. Updated by switch-mode flow.',
        },

        // ─────────────────────────────────────────────────────────────
        // GOOGLE OAUTH
        // ─────────────────────────────────────────────────────────────
        //
        // google_id = Google subject claim, stable unique Google user id.
        //
        // auth_provider:
        //   LOCAL        → password account only
        //   GOOGLE       → Google-created account, no password required
        //   LOCAL_GOOGLE → local account later linked with Google
        //
        // last_login_provider helps analytics/security/debugging.
        // google_avatar_url keeps original Google avatar separate from
        // app avatar_url. You can copy it into avatar_url if desired.
        // ─────────────────────────────────────────────────────────────

        google_id: {
            type: DataTypes.STRING(255),
            allowNull: true,
            unique: true,
            comment: 'Google OAuth subject identifier.',
        },

        auth_provider: {
            type: DataTypes.ENUM('LOCAL', 'GOOGLE', 'LOCAL_GOOGLE'),
            allowNull: false,
            defaultValue: 'LOCAL',
            comment: 'Primary authentication provider for this account.',
        },

        last_login_provider: {
            type: DataTypes.ENUM('LOCAL', 'GOOGLE'),
            allowNull: true,
            defaultValue: null,
            comment: 'Provider used for the latest successful login.',
        },

        google_avatar_url: {
            type: DataTypes.STRING(500),
            allowNull: true,
            comment: 'Original profile picture URL returned by Google.',
        },

        // ─────────────────────────────────────────────────────────────
        // CONTACT
        // ─────────────────────────────────────────────────────────────

        email: {
            type: DataTypes.STRING(190),
            unique: true,
            allowNull: true,
            validate: {
                isEmail: true,
            },
        },

        phone_e164: {
            type: DataTypes.STRING(32),
            unique: true,
            allowNull: true,
        },

        phone_verified: {
            type: DataTypes.BOOLEAN,
            defaultValue: false,
            allowNull: false,
        },

        email_verified: {
            type: DataTypes.BOOLEAN,
            defaultValue: false,
            allowNull: false,
        },

        // ─────────────────────────────────────────────────────────────
        // AUTH
        // ─────────────────────────────────────────────────────────────
        //
        // password_hash is nullable because Google-only accounts do not
        // have a local password unless the user sets one later.
        //
        // Login service must handle:
        //   password_hash === null && auth_provider === 'GOOGLE'
        //   → ask user to continue with Google.
        // ─────────────────────────────────────────────────────────────

        password_hash: {
            type: DataTypes.STRING(255),
            allowNull: true,
        },

        password_algo: {
            type: DataTypes.STRING(32),
            defaultValue: 'bcrypt',
            allowNull: true,
        },

        // ─────────────────────────────────────────────────────────────
        // PERSONAL INFO
        // ─────────────────────────────────────────────────────────────

        civility: {
            type: DataTypes.ENUM('M.', 'Mme', 'Mlle'),
            allowNull: true,
        },

        first_name: {
            type: DataTypes.STRING(100),
            allowNull: true,
        },

        last_name: {
            type: DataTypes.STRING(100),
            allowNull: true,
        },

        birth_date: {
            type: DataTypes.DATEONLY,
            allowNull: true,
        },

        avatar_url: {
            type: DataTypes.STRING(255),
            allowNull: true,
        },

        // ─────────────────────────────────────────────────────────────
        // ACCOUNT STATUS
        // ─────────────────────────────────────────────────────────────
        //
        // PASSENGER Google account:
        //   status = ACTIVE
        //
        // DRIVER Google account:
        //   status = PENDING until profile/documents/admin approval flow
        //   is completed.
        // ─────────────────────────────────────────────────────────────

        status: {
            type: DataTypes.ENUM(
                'ACTIVE',
                'PENDING',
                'SUSPENDED',
                'DELETED'
            ),
            allowNull: false,
            defaultValue: 'PENDING',
        },

        // ─────────────────────────────────────────────────────────────
        // LOCATION
        // ─────────────────────────────────────────────────────────────

        lastLatitude: {
            type: DataTypes.DECIMAL(10, 7),
            allowNull: true,
            comment: 'Last known latitude',
            field: 'lastLatitude',
        },

        lastLongitude: {
            type: DataTypes.DECIMAL(10, 7),
            allowNull: true,
            comment: 'Last known longitude',
            field: 'lastLongitude',
        },

        // ─────────────────────────────────────────────────────────────
        // AVAILABILITY
        // ─────────────────────────────────────────────────────────────

        isAvailable: {
            type: DataTypes.BOOLEAN,
            defaultValue: false,
            allowNull: false,
            comment: 'Is driver available for trips online',
            field: 'isAvailable',
        },

        lastSeenAt: {
            type: DataTypes.DATE,
            allowNull: true,
            comment: 'Last time driver was seen online',
            field: 'lastSeenAt',
        },
    },
    {
        sequelize,
        modelName: 'Account',
        tableName: 'accounts',
        timestamps: true,
        underscored: true,

        indexes: [
            {
                fields: ['active_mode'],
                name: 'accounts_active_mode',
            },
            {
                fields: ['user_type', 'active_mode'],
                name: 'accounts_type_mode',
            },
            {
                fields: ['google_id'],
                name: 'accounts_google_id_unique',
                unique: true,
            },
            {
                fields: ['auth_provider'],
                name: 'accounts_auth_provider_idx',
            },
            {
                fields: ['email', 'auth_provider'],
                name: 'accounts_email_provider_idx',
            },
        ],
    }
);

module.exports = Account;