// wegobackend/src/migrations/YYYYMMDDHHMMSS-create-partner-profiles.js

'use strict';

module.exports = {
    up: async (queryInterface, Sequelize) => {
        await queryInterface.createTable('partner_profiles', {
            id: {
                type: Sequelize.STRING(36),
                primaryKey: true,
                allowNull: false,
            },
            account_id: {
                type: Sequelize.CHAR(36),
                allowNull: false,
                unique: true,
                references: {
                    model: 'accounts',
                    key: 'uuid'
                },
                onUpdate: 'CASCADE',
                onDelete: 'CASCADE',
                comment: 'Links to the partner account'
            },
            partner_name: {
                type: Sequelize.STRING(128),
                allowNull: false,
            },
            address: {
                type: Sequelize.STRING(255),
                allowNull: true,
            },
            phone_number: {
                type: Sequelize.STRING(20),
                allowNull: false,
            },
            email: {
                type: Sequelize.STRING(128),
                allowNull: false,
                unique: true,
            },
            profile_photo: {
                type: Sequelize.STRING(512),
                allowNull: true,
                comment: 'R2 bucket URL for profile photo'
            },
            is_blocked: {
                type: Sequelize.BOOLEAN,
                allowNull: false,
                defaultValue: false,
                comment: 'Whether this partner is blocked from the system'
            },
            blocked_at: {
                type: Sequelize.DATE,
                allowNull: true,
                comment: 'Timestamp when partner was blocked'
            },
            blocked_by: {
                type: Sequelize.CHAR(36),
                allowNull: true,
                references: {
                    model: 'accounts',
                    key: 'uuid'
                },
                onUpdate: 'CASCADE',
                onDelete: 'SET NULL',
                comment: 'Employee who blocked this partner'
            },
            blocked_reason: {
                type: Sequelize.STRING(500),
                allowNull: true,
                comment: 'Reason for blocking the partner'
            },
            created_by_employee_id: {
                type: Sequelize.CHAR(36),
                allowNull: true,
                references: {
                    model: 'accounts',
                    key: 'uuid'
                },
                onUpdate: 'CASCADE',
                onDelete: 'SET NULL',
                comment: 'Employee who created this partner profile'
            },
            created_at: {
                allowNull: false,
                type: Sequelize.DATE,
                defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
            },
            updated_at: {
                allowNull: false,
                type: Sequelize.DATE,
                defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP')
            }
        });

        // Add indexes
        await queryInterface.addIndex('partner_profiles', ['account_id'], {
            unique: true,
            name: 'unique_partner_account'
        });

        await queryInterface.addIndex('partner_profiles', ['email'], {
            unique: true,
            name: 'unique_partner_email'
        });

        await queryInterface.addIndex('partner_profiles', ['is_blocked'], {
            name: 'idx_partner_is_blocked'
        });

        await queryInterface.addIndex('partner_profiles', ['phone_number'], {
            name: 'idx_partner_phone'
        });

        console.log('✅ partner_profiles table created successfully');
    },

    down: async (queryInterface, Sequelize) => {
        await queryInterface.dropTable('partner_profiles');
        console.log('✅ partner_profiles table dropped successfully');
    }
};