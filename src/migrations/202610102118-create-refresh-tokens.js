// src/migrations/YYYYMMDDHHMMSS-create-refresh-tokens.js
'use strict';

module.exports = {
    up: async (queryInterface, Sequelize) => {
        await queryInterface.createTable('refresh_tokens', {
            id: {
                type: Sequelize.INTEGER,
                primaryKey: true,
                autoIncrement: true
            },
            account_uuid: {
                type: Sequelize.UUID,
                allowNull: false,
                references: {
                    model: 'accounts',
                    key: 'uuid'
                },
                onDelete: 'CASCADE',
                comment: 'User account this token belongs to'
            },
            token_hash: {
                type: Sequelize.STRING(64),
                allowNull: false,
                unique: true,
                comment: 'SHA-256 hash of the refresh token'
            },
            expires_at: {
                type: Sequelize.DATE,
                allowNull: false,
                comment: 'Token expiration date (1 year from creation)'
            },
            is_valid: {
                type: Sequelize.BOOLEAN,
                defaultValue: true,
                comment: 'Whether this token is still valid (not revoked)'
            },
            created_at: {
                type: Sequelize.DATE,
                defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
                comment: 'When this token was created'
            },
            last_used_at: {
                type: Sequelize.DATE,
                allowNull: true,
                comment: 'Last time this token was used to refresh'
            },
            user_agent: {
                type: Sequelize.STRING(500),
                allowNull: true,
                comment: 'Browser/device user agent for security tracking'
            },
            ip_address: {
                type: Sequelize.STRING(45),
                allowNull: true,
                comment: 'IP address where token was created'
            }
        });

        // Add indexes
        await queryInterface.addIndex('refresh_tokens', ['account_uuid'], {
            name: 'idx_refresh_tokens_account'
        });

        await queryInterface.addIndex('refresh_tokens', ['token_hash'], {
            name: 'idx_refresh_tokens_hash',
            unique: true
        });

        await queryInterface.addIndex('refresh_tokens', ['expires_at'], {
            name: 'idx_refresh_tokens_expiry'
        });

        await queryInterface.addIndex('refresh_tokens', ['is_valid'], {
            name: 'idx_refresh_tokens_valid'
        });

        await queryInterface.addIndex('refresh_tokens', ['account_uuid', 'is_valid'], {
            name: 'idx_refresh_tokens_account_valid'
        });

        console.log('✅ Refresh tokens table created with indexes');
    },

    down: async (queryInterface, Sequelize) => {
        await queryInterface.dropTable('refresh_tokens');
        console.log('✅ Refresh tokens table dropped');
    }
};