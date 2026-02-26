'use strict';

module.exports = {
    up: async (queryInterface, Sequelize) => {
        await queryInterface.createTable('coupons', {
            id: {
                type: Sequelize.UUID,
                defaultValue: Sequelize.UUIDV4,
                primaryKey: true,
                allowNull: false
            },
            code: {
                type: Sequelize.STRING(50),
                allowNull: false,
                unique: true,
                comment: 'Unique coupon code'
            },
            description: {
                type: Sequelize.TEXT,
                allowNull: true,
                comment: 'Coupon description'
            },
            discount_type: {
                type: Sequelize.ENUM('percentage', 'fixed'),
                allowNull: false,
                comment: 'Type of discount: percentage or fixed amount'
            },
            discount_value: {
                type: Sequelize.INTEGER,
                allowNull: false,
                comment: 'Discount value (percentage 1-100 or fixed amount in FCFA)'
            },
            max_discount_amount: {
                type: Sequelize.INTEGER,
                allowNull: true,
                comment: 'Maximum discount cap for percentage coupons (in FCFA)'
            },
            min_trip_amount: {
                type: Sequelize.INTEGER,
                allowNull: false,
                defaultValue: 0,
                comment: 'Minimum trip amount required to use coupon (in FCFA)'
            },
            usage_limit_total: {
                type: Sequelize.INTEGER,
                allowNull: true,
                comment: 'Total number of times coupon can be used (null = unlimited)'
            },
            usage_limit_per_user: {
                type: Sequelize.INTEGER,
                allowNull: false,
                defaultValue: 1,
                comment: 'Maximum times a single user can use this coupon'
            },
            used_count: {
                type: Sequelize.INTEGER,
                allowNull: false,
                defaultValue: 0,
                comment: 'Number of times coupon has been used'
            },
            valid_from: {
                type: Sequelize.DATE,
                allowNull: false,
                comment: 'Coupon validity start date'
            },
            valid_until: {
                type: Sequelize.DATE,
                allowNull: false,
                comment: 'Coupon validity end date'
            },
            applicable_to: {
                type: Sequelize.ENUM('all', 'new_users', 'specific_users'),
                allowNull: false,
                defaultValue: 'all',
                comment: 'Who can use this coupon'
            },
            is_active: {
                type: Sequelize.BOOLEAN,
                allowNull: false,
                defaultValue: true,
                comment: 'Whether coupon is currently active'
            },
            createdAt: {
                type: Sequelize.DATE,
                allowNull: false,
                defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
            },
            updatedAt: {
                type: Sequelize.DATE,
                allowNull: false,
                defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP')
            }
        });

        // Add indexes for better query performance
        await queryInterface.addIndex('coupons', ['code'], {
            name: 'idx_coupons_code',
            unique: true
        });

        await queryInterface.addIndex('coupons', ['is_active'], {
            name: 'idx_coupons_is_active'
        });

        await queryInterface.addIndex('coupons', ['valid_from', 'valid_until'], {
            name: 'idx_coupons_validity'
        });

        await queryInterface.addIndex('coupons', ['discount_type'], {
            name: 'idx_coupons_discount_type'
        });

        console.log('✅ Coupons table created successfully');
    },

    down: async (queryInterface, Sequelize) => {
        await queryInterface.dropTable('coupons');
        console.log('✅ Coupons table dropped successfully');
    }
};