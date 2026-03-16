'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('delivery_surge_rules', {
            id: {
                type: Sequelize.INTEGER,
                autoIncrement: true,
                primaryKey: true,
                allowNull: false,
            },

            // Human-readable name for this rule
            // e.g. "Morning Rush", "Friday Evening", "Weekend Night"
            name: {
                type: Sequelize.STRING(100),
                allowNull: false,
            },

            description: {
                type: Sequelize.STRING(255),
                allowNull: true,
            },

            // ─── TIME-BASED RULES ───────────────────────────────────────────────────
            // Days of week this rule applies to (stored as JSON array)
            // e.g. [1,2,3,4,5] = Monday–Friday, [0,6] = Weekend
            // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
            days_of_week: {
                type: Sequelize.JSON,
                allowNull: false,
                comment: 'Array of day numbers: 0=Sun, 1=Mon, ..., 6=Sat. e.g. [1,2,3,4,5]',
            },

            // Time range in HH:MM format (24h)
            start_time: {
                type: Sequelize.STRING(5),
                allowNull: false,
                comment: 'HH:MM format, e.g. "07:00"',
            },

            end_time: {
                type: Sequelize.STRING(5),
                allowNull: false,
                comment: 'HH:MM format, e.g. "09:00"',
            },

            // ─── SURGE MULTIPLIER ───────────────────────────────────────────────────
            // Applied on top of the base pricing formula
            // e.g. 1.30 = 30% more expensive during this window
            // Minimum 1.00 (no discount), Maximum 3.00 (safety cap)
            multiplier: {
                type: Sequelize.DECIMAL(4, 2),
                allowNull: false,
                defaultValue: 1.30,
                comment: 'e.g. 1.30 = 30% surge. Min 1.00, Max 3.00',
            },

            // ─── SCOPE ──────────────────────────────────────────────────────────────
            // Optional: link this surge rule to a specific pricing zone
            // NULL = applies globally to all zones
            delivery_pricing_id: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: {
                    model: 'delivery_pricing',
                    key: 'id',
                },
                onUpdate: 'CASCADE',
                onDelete: 'SET NULL',
                comment: 'NULL = applies to all zones',
            },

            // ─── PRIORITY ───────────────────────────────────────────────────────────
            // When multiple rules match the same time window,
            // the one with the HIGHEST priority wins
            // e.g. a specific Friday evening rule (priority 10) beats
            // a general weekday rule (priority 1)
            priority: {
                type: Sequelize.INTEGER,
                allowNull: false,
                defaultValue: 1,
                comment: 'Higher number = higher priority when rules overlap',
            },

            // ─── STATUS ─────────────────────────────────────────────────────────────
            is_active: {
                type: Sequelize.BOOLEAN,
                allowNull: false,
                defaultValue: true,
            },

            // Audit trail
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

        // ─── INDEXES ──────────────────────────────────────────────────────────────

        await queryInterface.addIndex('delivery_surge_rules', ['is_active'], {
            name: 'idx_surge_rules_active',
        });

        await queryInterface.addIndex('delivery_surge_rules', ['priority'], {
            name: 'idx_surge_rules_priority',
        });

        await queryInterface.addIndex('delivery_surge_rules', ['delivery_pricing_id'], {
            name: 'idx_surge_rules_pricing_zone',
        });

        // ─── SEED DEFAULT SURGE RULES ─────────────────────────────────────────────
        // Insert sensible defaults so the system works out of the box

        await queryInterface.bulkInsert('delivery_surge_rules', [
            {
                name: 'Morning Rush',
                description: 'Weekday morning peak hours',
                days_of_week: JSON.stringify([1, 2, 3, 4, 5]), // Mon–Fri
                start_time: '07:00',
                end_time: '09:30',
                multiplier: 1.30,
                delivery_pricing_id: null,
                priority: 5,
                is_active: true,
                created_by: null,
                created_at: new Date(),
                updated_at: new Date(),
            },
            {
                name: 'Lunch Rush',
                description: 'Midday peak — everyone ordering at once',
                days_of_week: JSON.stringify([1, 2, 3, 4, 5]), // Mon–Fri
                start_time: '11:30',
                end_time: '13:30',
                multiplier: 1.20,
                delivery_pricing_id: null,
                priority: 5,
                is_active: true,
                created_by: null,
                created_at: new Date(),
                updated_at: new Date(),
            },
            {
                name: 'Evening Rush',
                description: 'End of day peak hours',
                days_of_week: JSON.stringify([1, 2, 3, 4, 5]), // Mon–Fri
                start_time: '17:00',
                end_time: '20:00',
                multiplier: 1.40,
                delivery_pricing_id: null,
                priority: 5,
                is_active: true,
                created_by: null,
                created_at: new Date(),
                updated_at: new Date(),
            },
            {
                name: 'Weekend Peak',
                description: 'Saturday and Sunday busy hours',
                days_of_week: JSON.stringify([0, 6]), // Sun & Sat
                start_time: '10:00',
                end_time: '21:00',
                multiplier: 1.25,
                delivery_pricing_id: null,
                priority: 3,
                is_active: true,
                created_by: null,
                created_at: new Date(),
                updated_at: new Date(),
            },
            {
                name: 'Late Night',
                description: 'Night deliveries — fewer drivers available',
                days_of_week: JSON.stringify([0, 1, 2, 3, 4, 5, 6]), // Every day
                start_time: '22:00',
                end_time: '23:59',
                multiplier: 1.50,
                delivery_pricing_id: null,
                priority: 8,
                is_active: true,
                created_by: null,
                created_at: new Date(),
                updated_at: new Date(),
            },
        ]);

        console.log('✅ delivery_surge_rules table created with 5 default rules');
    },

    async down(queryInterface, Sequelize) {
        await queryInterface.dropTable('delivery_surge_rules');
        console.log('🗑️ delivery_surge_rules table dropped');
    },
};