'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('ride_surge_rules', {
            id: {
                type: Sequelize.INTEGER,
                autoIncrement: true,
                primaryKey: true,
                allowNull: false,
            },

            name: {
                type: Sequelize.STRING(100),
                allowNull: false,
            },

            description: {
                type: Sequelize.STRING(255),
                allowNull: true,
            },

            // Days of week: 0=Sun … 6=Sat, JSON array e.g. [1,2,3,4,5]
            days_of_week: {
                type: Sequelize.JSON,
                allowNull: false,
                comment: 'Array of day numbers: 0=Sun … 6=Sat. e.g. [1,2,3,4,5]',
            },

            start_time: {
                type: Sequelize.STRING(5),
                allowNull: false,
                comment: 'HH:MM 24h, e.g. "07:00"',
            },

            end_time: {
                type: Sequelize.STRING(5),
                allowNull: false,
                comment: 'HH:MM 24h, e.g. "09:00"',
            },

            multiplier: {
                type: Sequelize.DECIMAL(4, 2),
                allowNull: false,
                defaultValue: 1.30,
                comment: 'e.g. 1.30 = 30% surge. Min 1.00, Max 3.00',
            },

            // NULL = applies to every city (global).
            city: {
                type: Sequelize.STRING(100),
                allowNull: true,
                comment: 'NULL = applies to all cities',
            },

            // NULL = applies to every vehicle type in the city.
            vehicle_type: {
                type: Sequelize.ENUM('economy', 'comfort', 'luxury'),
                allowNull: true,
                comment: 'NULL = applies to all vehicle types',
            },

            priority: {
                type: Sequelize.INTEGER,
                allowNull: false,
                defaultValue: 1,
                comment: 'Higher number wins when rules overlap',
            },

            is_active: {
                type: Sequelize.BOOLEAN,
                allowNull: false,
                defaultValue: true,
            },

            created_by: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: 'employees', key: 'id' },
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

        await queryInterface.addIndex('ride_surge_rules', ['is_active'], {
            name: 'idx_ride_surge_active',
        });
        await queryInterface.addIndex('ride_surge_rules', ['priority'], {
            name: 'idx_ride_surge_priority',
        });
        await queryInterface.addIndex('ride_surge_rules', ['city'], {
            name: 'idx_ride_surge_city',
        });

        // ─── SEED DEFAULT RIDE SURGE RULES ────────────────────────────────────────
        await queryInterface.bulkInsert('ride_surge_rules', [
            {
                name: 'Morning rush',
                description: 'Weekday morning peak',
                days_of_week: JSON.stringify([1, 2, 3, 4, 5]),
                start_time: '07:00',
                end_time: '09:00',
                multiplier: 1.40,
                city: null,
                vehicle_type: null,
                priority: 5,
                is_active: true,
                created_by: null,
                created_at: new Date(),
                updated_at: new Date(),
            },
            {
                name: 'Evening rush',
                description: 'Weekday evening peak',
                days_of_week: JSON.stringify([1, 2, 3, 4, 5]),
                start_time: '17:00',
                end_time: '20:00',
                multiplier: 1.50,
                city: null,
                vehicle_type: null,
                priority: 5,
                is_active: true,
                created_by: null,
                created_at: new Date(),
                updated_at: new Date(),
            },
            {
                name: 'Friday night',
                description: 'Higher demand, fewer drivers',
                days_of_week: JSON.stringify([5]),
                start_time: '20:00',
                end_time: '23:59',
                multiplier: 1.80,
                city: null,
                vehicle_type: null,
                priority: 8,
                is_active: true,
                created_by: null,
                created_at: new Date(),
                updated_at: new Date(),
            },
        ]);

        console.log('✅ ride_surge_rules table created with 3 default rules');
    },

    async down(queryInterface, Sequelize) {
        await queryInterface.dropTable('ride_surge_rules');
        console.log('🗑️ ride_surge_rules table dropped');
    },
};
