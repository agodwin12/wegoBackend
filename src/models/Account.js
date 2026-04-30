// src/models/Account.js
//
// ═══════════════════════════════════════════════════════════════════════
// ACCOUNT MODEL
// ═══════════════════════════════════════════════════════════════════════
//
// ⚠️  MIGRATION REQUIRED for active_mode:
//
//   ALTER TABLE accounts
//     ADD COLUMN active_mode ENUM('PASSENGER','DRIVER','DELIVERY_AGENT')
//     NULL AFTER user_type;
//
//   -- Backfill existing rows so every account has an active_mode
//   -- that matches their base user_type:
//   UPDATE accounts SET active_mode = 'PASSENGER'       WHERE user_type = 'PASSENGER';
//   UPDATE accounts SET active_mode = 'DRIVER'          WHERE user_type = 'DRIVER';
//   UPDATE accounts SET active_mode = 'DELIVERY_AGENT'  WHERE user_type = 'DELIVERY_AGENT';
//   -- PARTNER and ADMIN don't switch modes — leave them NULL.
//
// ═══════════════════════════════════════════════════════════════════════

const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

const PassengerProfile = require('./PassengerProfile');
const DriverProfile    = require('./DriverProfile');

class Account extends Model {}

Account.init(
    {
        // ── Primary key ───────────────────────────────────────────────
        uuid: {
            type:         DataTypes.CHAR(36),
            defaultValue: DataTypes.UUIDV4,
            allowNull:    false,
            unique:       true,
            primaryKey:   true,
        },

        // ── Base role — never changes after registration ───────────────
        // This is the permanent identity of the account.
        // Use active_mode to know what the user is *currently acting as*.
        user_type: {
            type:      DataTypes.ENUM('PASSENGER', 'DRIVER', 'PARTNER', 'ADMIN', 'DELIVERY_AGENT'),
            allowNull: false,
            comment:   'Permanent base role set at registration. Never changes.',
        },

        // ── Active mode — changes when user switches context ──────────
        //
        // This is the mode the user is currently operating in.
        // The JWT carries active_mode so every API call and socket event
        // knows which dashboard/capability set is currently active.
        //
        // Allowed transitions (enforced in switchMode controller):
        //   DRIVER          → PASSENGER          (always allowed)
        //   DRIVER          → DELIVERY_AGENT     (allowed — shared wallet)
        //   DELIVERY_AGENT  → PASSENGER          (always allowed)
        //   PASSENGER       → anything           (blocked — can't self-promote)
        //
        // NULL means the account never switched (PARTNER, ADMIN, etc.)
        // or was created before this column existed. Treat NULL as equal
        // to user_type when reading it.
        active_mode: {
            type:         DataTypes.ENUM('PASSENGER', 'DRIVER', 'DELIVERY_AGENT'),
            allowNull:    true,
            defaultValue: null,
            comment:      'Current operating mode. NULL = same as user_type. Updated by POST /api/auth/switch-mode.',
        },

        // ── Contact ───────────────────────────────────────────────────
        email: {
            type:      DataTypes.STRING(190),
            unique:    true,
            allowNull: true,
            validate:  { isEmail: true },
        },
        phone_e164: {
            type:      DataTypes.STRING(32),
            unique:    true,
            allowNull: true,
        },
        phone_verified: {
            type:         DataTypes.BOOLEAN,
            defaultValue: false,
        },
        email_verified: {
            type:         DataTypes.BOOLEAN,
            defaultValue: false,
        },

        // ── Auth ──────────────────────────────────────────────────────
        password_hash: {
            type:      DataTypes.STRING(255),
            allowNull: false,
        },
        password_algo: {
            type:         DataTypes.STRING(32),
            defaultValue: 'bcrypt',
            allowNull:    false,
        },

        // ── Personal info ─────────────────────────────────────────────
        civility: {
            type:      DataTypes.ENUM('M.', 'Mme', 'Mlle'),
            allowNull: true,
        },
        first_name: {
            type:      DataTypes.STRING(100),
            allowNull: true,
        },
        last_name: {
            type:      DataTypes.STRING(100),
            allowNull: true,
        },
        birth_date: {
            type:      DataTypes.DATEONLY,
            allowNull: true,
        },
        avatar_url: {
            type:      DataTypes.STRING(255),
            allowNull: true,
        },

        // ── Account status ────────────────────────────────────────────
        status: {
            type:         DataTypes.ENUM('ACTIVE', 'PENDING', 'SUSPENDED', 'DELETED'),
            allowNull:    false,
            defaultValue: 'PENDING',
        },

        // ── Location ──────────────────────────────────────────────────
        lastLatitude: {
            type:      DataTypes.DECIMAL(10, 7),
            allowNull: true,
            comment:   'Last known latitude',
            field:     'lastLatitude',
        },
        lastLongitude: {
            type:      DataTypes.DECIMAL(10, 7),
            allowNull: true,
            comment:   'Last known longitude',
            field:     'lastLongitude',
        },

        // ── Availability ──────────────────────────────────────────────
        isAvailable: {
            type:         DataTypes.BOOLEAN,
            defaultValue: false,
            comment:      'Is driver available for trips (online)',
            field:        'isAvailable',
        },
        lastSeenAt: {
            type:      DataTypes.DATE,
            allowNull: true,
            comment:   'Last time driver was seen online',
            field:     'lastSeenAt',
        },
    },
    {
        sequelize,
        modelName:   'Account',
        tableName:   'accounts',
        timestamps:  true,
        underscored: true,
        indexes: [
            // Fast lookup by active_mode for dispatch and socket routing
            { fields: ['active_mode'], name: 'accounts_active_mode' },
            // Combined: find all DRIVER accounts currently in PASSENGER mode
            { fields: ['user_type', 'active_mode'], name: 'accounts_type_mode' },
        ],
    }
);

module.exports = Account;