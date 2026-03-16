'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('delivery_pricing', {
            id: {
                type: Sequelize.INTEGER,
                autoIncrement: true,
                primaryKey: true,
                allowNull: false,
            },

            // Zone/City identifier — admin can create multiple pricing configs
            // e.g. "Douala Centre", "Douala Bassa", "Yaoundé"
            zone_name: {
                type: Sequelize.STRING(100),
                allowNull: false,
            },

            zone_description: {
                type: Sequelize.STRING(255),
                allowNull: true,
            },

            // Base fee charged for every delivery regardless of distance (XAF)
            base_fee: {
                type: Sequelize.DECIMAL(10, 2),
                allowNull: false,
                defaultValue: 500.00,
            },

            // Price per kilometer (XAF)
            per_km_rate: {
                type: Sequelize.DECIMAL(10, 2),
                allowNull: false,
                defaultValue: 150.00,
            },

            // Package size multipliers
            // Final price = (base_fee + km * per_km_rate) * size_multiplier * surge_multiplier
            size_multiplier_small: {
                type: Sequelize.DECIMAL(4, 2),
                allowNull: false,
                defaultValue: 1.00, // Small: documents, envelopes
            },

            size_multiplier_medium: {
                type: Sequelize.DECIMAL(4, 2),
                allowNull: false,
                defaultValue: 1.30, // Medium: small parcels
            },

            size_multiplier_large: {
                type: Sequelize.DECIMAL(4, 2),
                allowNull: false,
                defaultValue: 1.70, // Large: bulky items
            },

            // WEGO commission percentage on this zone (e.g. 20.00 = 20%)
            commission_percentage: {
                type: Sequelize.DECIMAL(5, 2),
                allowNull: false,
                defaultValue: 20.00,
            },

            // Minimum price floor — no delivery can be cheaper than this (XAF)
            minimum_price: {
                type: Sequelize.DECIMAL(10, 2),
                allowNull: false,
                defaultValue: 1000.00,
            },

            // Maximum distance this zone config covers (km)
            // Deliveries beyond this distance get an error or custom quote
            max_distance_km: {
                type: Sequelize.DECIMAL(6, 2),
                allowNull: false,
                defaultValue: 50.00,
            },

            is_active: {
                type: Sequelize.BOOLEAN,
                allowNull: false,
                defaultValue: true,
            },

            // Which admin created/last updated this config
            created_by: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: {
                    model: 'employees',
                    key: 'id',
                },
                onUpdate: 'CASCADE',
                onDelete: 'SET NULL',
            },

            created_at: {
                type: Sequelize.DATE,
                allowNull: false,
                defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
            },

            updated_at: {
                type: Sequelize.DATE,
                allowNull: false,
                defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'),
            },
        });

        // Index for fast lookup of active configs
        await queryInterface.addIndex('delivery_pricing', ['is_active'], {
            name: 'idx_delivery_pricing_active',
        });

        await queryInterface.addIndex('delivery_pricing', ['zone_name'], {
            name: 'idx_delivery_pricing_zone',
        });

        console.log('✅ delivery_pricing table created');
    },

    async down(queryInterface, Sequelize) {
        await queryInterface.dropTable('delivery_pricing');
        console.log('🗑️ delivery_pricing table dropped');
    },
};