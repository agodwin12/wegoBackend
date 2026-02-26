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

// ✅ FIXED: Association WITHOUT foreign key constraints
// This allows the model to work with both accounts and pending_signups
// The constraints: false prevents Sequelize from creating the foreign key
VerificationCode.belongsTo = function(Account) {

    return this.hasOne(Account, {
        foreignKey: 'uuid',
        sourceKey: 'account_uuid',
        constraints: false, // ✅ CRITICAL: No foreign key constraint!
        as: 'account'
    });
};

module.exports = VerificationCode;