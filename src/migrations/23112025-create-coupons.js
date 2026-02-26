'use strict';

module.exports = {
    up: async (queryInterface, Sequelize) => {
        // Create coupons table
        await queryInterface.createTable('coupons', {
            id: {
                type: Sequelize.STRING(36),
                primaryKey: true,
                allowNull: false
            },
            code: {
                type: Sequelize.STRING(20),
                allowNull: false,
                unique: true
            },
            description: {
                type: Sequelize.STRING(255),
                allowNull: true
            },
            discount_type: {
                type: Sequelize.ENUM('percentage', 'fixed'),
                allowNull: false,
                defaultValue: 'percentage'
            },
            discount_value: {
                type: Sequelize.INTEGER,
                allowNull: false
            },
            max_discount_amount: {
                type: Sequelize.INTEGER,
                allowNull: true,
                comment: 'Maximum discount cap for percentage-based coupons in FCFA'
            },
            min_trip_amount: {
                type: Sequelize.INTEGER,
                allowNull: false,
                defaultValue: 0,
                comment: 'Minimum trip fare required to use this coupon in FCFA'
            },
            usage_limit_total: {
                type: Sequelize.INTEGER,
                allowNull: true,
                comment: 'Total number of times this coupon can be used across all users'
            },
            usage_limit_per_user: {
                type: Sequelize.INTEGER,
                allowNull: false,
                defaultValue: 1
            },
            used_count: {
                type: Sequelize.INTEGER,
                allowNull: false,
                defaultValue: 0
            },
            valid_from: {
                type: Sequelize.DATE,
                allowNull: false
            },
            valid_until: {
                type: Sequelize.DATE,
                allowNull: false
            },
            applicable_to: {
                type: Sequelize.ENUM('all', 'new_users', 'specific_users'),
                allowNull: false,
                defaultValue: 'all'
            },
            is_active: {
                type: Sequelize.BOOLEAN,
                allowNull: false,
                defaultValue: true
            },
            created_by: {
                type: Sequelize.STRING(36),
                allowNull: false,
                references: {
                    model: 'employees',
                    key: 'id'
                },
                onUpdate: 'CASCADE',
                onDelete: 'RESTRICT'
            },
            createdAt: {
                type: Sequelize.DATE,
                allowNull: false
            },
            updatedAt: {
                type: Sequelize.DATE,
                allowNull: false
            }
        });

        // Create coupon_usage tracking table
        await queryInterface.createTable('coupon_usage', {
            id: {
                type: Sequelize.STRING(36),
                primaryKey: true,
                allowNull: false
            },
            coupon_id: {
                type: Sequelize.STRING(36),
                allowNull: false,
                references: {
                    model: 'coupons',
                    key: 'id'
                },
                onUpdate: 'CASCADE',
                onDelete: 'CASCADE'
            },
            user_id: {
                type: Sequelize.STRING(36),
                allowNull: false,
                references: {
                    model: 'users',
                    key: 'id'
                },
                onUpdate: 'CASCADE',
                onDelete: 'CASCADE'
            },
            trip_id: {
                type: Sequelize.STRING(36),
                allowNull: true,
                references: {
                    model: 'trips',
                    key: 'id'
                },
                onUpdate: 'CASCADE',
                onDelete: 'SET NULL'
            },
            discount_applied: {
                type: Sequelize.INTEGER,
                allowNull: false,
                comment: 'Actual discount amount applied in FCFA'
            },
            used_at: {
                type: Sequelize.DATE,
                allowNull: false
            }
        });

        // Create indexes for better query performance
        await queryInterface.addIndex('coupons', ['code']);
        await queryInterface.addIndex('coupons', ['is_active']);
        await queryInterface.addIndex('coupons', ['valid_from', 'valid_until']);
        await queryInterface.addIndex('coupon_usage', ['coupon_id']);
        await queryInterface.addIndex('coupon_usage', ['user_id']);
        await queryInterface.addIndex('coupon_usage', ['trip_id']);
    },

    down: async (queryInterface, Sequelize) => {
        await queryInterface.dropTable('coupon_usage');
        await queryInterface.dropTable('coupons');
    }
};