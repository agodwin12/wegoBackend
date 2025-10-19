const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const Account = require('./account');

const VerificationCode = sequelize.define(
    'verification_codes',
    {
        id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },

        // Use UUID to reference the Account table
        account_uuid: {
            type: DataTypes.CHAR(36),
            allowNull: false,
            references: {
                model: 'accounts',   // or Account if imported directly
                key: 'uuid',
            },
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE',
        },

        channel: { type: DataTypes.ENUM('SMS', 'EMAIL'), allowNull: false },
        target: { type: DataTypes.STRING(190), allowNull: false },

        code_hash: { type: DataTypes.STRING(255), allowNull: false },
        purpose: {
            type: DataTypes.ENUM(
                'PHONE_VERIFY',
                'EMAIL_VERIFY',
                'PASSWORD_RESET',
                'MFA'
            ),
            allowNull: false,
        },
        attempts: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },
        max_attempts: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 5 },
        expires_at: { type: DataTypes.DATE, allowNull: false },
        consumed_at: { type: DataTypes.DATE, allowNull: true },
    },
    {
        tableName: 'verification_codes',
        indexes: [{ fields: ['account_uuid', 'purpose', 'expires_at'] }],
    }
);

// Optional association (helps with includes)
VerificationCode.belongsTo(Account, {
    foreignKey: 'account_uuid',
    targetKey: 'uuid',
    onDelete: 'CASCADE',
});

module.exports = VerificationCode;
