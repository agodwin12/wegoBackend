// src/models/Account.js
const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

// Optional imports (kept for potential future lazy loading)
const PassengerProfile = require('./PassengerProfile');
const DriverProfile = require('./DriverProfile');

class Account extends Model {}

// ═══════════════════════════════════════════════════════════════════════
// MODEL DEFINITION
// ═══════════════════════════════════════════════════════════════════════
Account.init(
    {
        uuid: {
            type: DataTypes.CHAR(36),
            defaultValue: DataTypes.UUIDV4,
            allowNull: false,
            unique: true,
            primaryKey: true,
        },
        user_type: {
            type: DataTypes.ENUM('PASSENGER', 'DRIVER', 'PARTNER', 'ADMIN'),
            allowNull: false,
        },
        email: {
            type: DataTypes.STRING(190),
            unique: true,
            allowNull: true,
            validate: { isEmail: true },
        },
        phone_e164: {
            type: DataTypes.STRING(32),
            unique: true,
            allowNull: true,
        },
        phone_verified: {
            type: DataTypes.BOOLEAN,
            defaultValue: false,
        },
        email_verified: {
            type: DataTypes.BOOLEAN,
            defaultValue: false,
        },
        password_hash: {
            type: DataTypes.STRING(255),
            allowNull: false,
        },
        password_algo: {
            type: DataTypes.STRING(32),
            defaultValue: 'bcrypt',
            allowNull: false,
        },
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
        status: {
            type: DataTypes.ENUM('ACTIVE', 'PENDING', 'SUSPENDED', 'DELETED'),
            allowNull: false,
            defaultValue: 'PENDING',
        },
    },
    {
        sequelize,
        modelName: 'Account',
        tableName: 'accounts',
        timestamps: true,   // ✅ adds created_at / updated_at
        underscored: true,  // ✅ uses snake_case columns
    }
);

// ═══════════════════════════════════════════════════════════════════════
// RELATIONSHIPS
// (❌ none defined here to avoid alias duplication)
// All associations are centralized in src/models/index.js
// ═══════════════════════════════════════════════════════════════════════

module.exports = Account;
