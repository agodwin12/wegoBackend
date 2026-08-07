const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const VerificationCode = sequelize.define(
    'verification_codes',
    {
        id: {
            type: DataTypes.BIGINT.UNSIGNED,
            primaryKey: true,
            autoIncrement: true
        },

        // ✅ FIXED: Removed references to allow pending signups
        // This UUID can reference either accounts.uuid OR pending_signups.uuid
        account_uuid: {
            type: DataTypes.CHAR(36),
            allowNull: false,
            // ❌ REMOVED: references, onDelete, onUpdate
            // These create the foreign key constraint that's causing the error
        },

        channel: {
            type: DataTypes.ENUM('SMS', 'EMAIL'),
            allowNull: false
        },

        target: {
            type: DataTypes.STRING(190),
            allowNull: false
        },

        code_hash: {
            type: DataTypes.STRING(255),
            allowNull: false
        },

        purpose: {
            type: DataTypes.ENUM(
                'PHONE_VERIFY',
                'EMAIL_VERIFY',
                'PASSWORD_RESET',
                'MFA'
            ),
            allowNull: false,
        },

        attempts: {
            type: DataTypes.INTEGER.UNSIGNED,
            defaultValue: 0
        },

        max_attempts: {
            type: DataTypes.INTEGER.UNSIGNED,
            defaultValue: 5
        },

        expires_at: {
            type: DataTypes.DATE,
            allowNull: false
        },

        consumed_at: {
            type: DataTypes.DATE,
            allowNull: true
        },
    },
    {
        tableName: 'verification_codes',
        timestamps: true, // Adds createdAt and updatedAt
        indexes: [
            {
                fields: ['account_uuid', 'purpose', 'expires_at']
            },
            {
                fields: ['target']
            },
            {
                fields: ['expires_at']
            }
        ],
    }
);

// Associations (Account.hasMany / VerificationCode.belongsTo) are wired in
// src/models/index.js with constraints: false, since account_uuid must be
// able to point at a not-yet-created account during a pending signup.

module.exports = VerificationCode;