'use strict';

module.exports = {
    up: async (queryInterface, Sequelize) => {
        // Add status field
        await queryInterface.addColumn('price_rules', 'status', {
            type: Sequelize.ENUM('active', 'inactive'),
            allowNull: false,
            defaultValue: 'active',
            after: 'surge_mult'
        });

        // Add created_by field for audit tracking
        await queryInterface.addColumn('price_rules', 'created_by', {
            type: Sequelize.STRING(36),
            allowNull: true, // Nullable for existing records
            references: {
                model: 'employees',
                key: 'id'
            },
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL',
            after: 'status'
        });

        // Add updated_by field for audit tracking
        await queryInterface.addColumn('price_rules', 'updated_by', {
            type: Sequelize.STRING(36),
            allowNull: true,
            references: {
                model: 'employees',
                key: 'id'
            },
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL',
            after: 'created_by'
        });

        // Add indexes for better performance
        await queryInterface.addIndex('price_rules', ['city']);
        await queryInterface.addIndex('price_rules', ['status']);
        await queryInterface.addIndex('price_rules', ['created_by']);
        await queryInterface.addIndex('price_rules', ['updated_by']);
    },

    down: async (queryInterface, Sequelize) => {
        // Remove indexes
        await queryInterface.removeIndex('price_rules', ['city']);
        await queryInterface.removeIndex('price_rules', ['status']);
        await queryInterface.removeIndex('price_rules', ['created_by']);
        await queryInterface.removeIndex('price_rules', ['updated_by']);

        // Remove columns
        await queryInterface.removeColumn('price_rules', 'updated_by');
        await queryInterface.removeColumn('price_rules', 'created_by');
        await queryInterface.removeColumn('price_rules', 'status');
    }
};