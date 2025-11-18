// src/migrations/20251114223000-create-ratings-table.js

'use strict';

module.exports = {
    up: async (queryInterface, Sequelize) => {
        console.log('📊 [MIGRATION] Creating ratings table...');

        await queryInterface.createTable('ratings', {
            id: {
                type: Sequelize.UUID,
                defaultValue: Sequelize.UUIDV4,
                primaryKey: true,
                allowNull: false,
            },
            trip_id: {
                type: Sequelize.UUID,
                allowNull: false,
                references: {
                    model: 'trips',
                    key: 'id',
                },
                onUpdate: 'CASCADE',
                onDelete: 'CASCADE',
            },
            rated_by: {
                type: Sequelize.UUID,
                allowNull: false,
                comment: 'UUID of account who gave the rating',
                references: {
                    model: 'accounts',
                    key: 'uuid',
                },
                onUpdate: 'CASCADE',
                onDelete: 'CASCADE',
            },
            rated_user: {
                type: Sequelize.UUID,
                allowNull: false,
                comment: 'UUID of account who received the rating',
                references: {
                    model: 'accounts',
                    key: 'uuid',
                },
                onUpdate: 'CASCADE',
                onDelete: 'CASCADE',
            },
            rating_type: {
                type: Sequelize.ENUM('DRIVER_TO_PASSENGER', 'PASSENGER_TO_DRIVER'),
                allowNull: false,
                comment: 'Type of rating',
            },
            stars: {
                type: Sequelize.INTEGER,
                allowNull: false,
                validate: {
                    min: 1,
                    max: 5,
                },
                comment: 'Star rating from 1 to 5',
            },
            comment: {
                type: Sequelize.TEXT,
                allowNull: true,
                comment: 'Optional text comment',
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

        console.log('📊 [MIGRATION] Adding indexes...');

        // Add indexes
        await queryInterface.addIndex('ratings', ['trip_id', 'rating_type'], {
            name: 'idx_ratings_trip_type',
            unique: true,
        });

        await queryInterface.addIndex('ratings', ['rated_user'], {
            name: 'idx_ratings_rated_user',
        });

        await queryInterface.addIndex('ratings', ['rated_by'], {
            name: 'idx_ratings_rated_by',
        });

        console.log('✅ [MIGRATION] Ratings table created successfully');
    },

    down: async (queryInterface, Sequelize) => {
        console.log('🗑️ [MIGRATION] Dropping ratings table...');

        await queryInterface.dropTable('ratings');

        console.log('✅ [MIGRATION] Ratings table dropped');
    },
};