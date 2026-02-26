// src/models/RefreshToken.js
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    const RefreshToken = sequelize.define('RefreshToken', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true
        },
        account_uuid: {
            type: DataTypes.UUID,
            allowNull: false,
            references: {
                model: 'accounts',
                key: 'uuid'
            },
            onDelete: 'CASCADE',
            comment: 'User account this token belongs to'
        },
        token_hash: {
            type: DataTypes.STRING(64),
            allowNull: false,
            unique: true,
            comment: 'SHA-256 hash of the refresh token'
        },
        expires_at: {
            type: DataTypes.DATE,
            allowNull: false,
            comment: 'Token expiration date (1 year from creation)'
        },
        is_valid: {
            type: DataTypes.BOOLEAN,
            defaultValue: true,
            comment: 'Whether this token is still valid (not revoked)'
        },
        created_at: {
            type: DataTypes.DATE,
            defaultValue: DataTypes.NOW,
            comment: 'When this token was created'
        },
        last_used_at: {
            type: DataTypes.DATE,
            allowNull: true,
            comment: 'Last time this token was used to refresh'
        },
        user_agent: {
            type: DataTypes.STRING(500),
            allowNull: true,
            comment: 'Browser/device user agent for security tracking'
        },
        ip_address: {
            type: DataTypes.STRING(45),
            allowNull: true,
            comment: 'IP address where token was created'
        }
    }, {
        tableName: 'refresh_tokens',
        timestamps: false,
        indexes: [
            {
                fields: ['account_uuid'],
                name: 'idx_refresh_tokens_account'
            },
            {
                fields: ['token_hash'],
                name: 'idx_refresh_tokens_hash',
                unique: true
            },
            {
                fields: ['expires_at'],
                name: 'idx_refresh_tokens_expiry'
            },
            {
                fields: ['is_valid'],
                name: 'idx_refresh_tokens_valid'
            },
            {
                fields: ['account_uuid', 'is_valid'],
                name: 'idx_refresh_tokens_account_valid'
            }
        ]
    });

    // Association
    RefreshToken.associate = (models) => {
        RefreshToken.belongsTo(models.Account, {
            foreignKey: 'account_uuid',
            targetKey: 'uuid',
            as: 'account'
        });
    };

    return RefreshToken;
};