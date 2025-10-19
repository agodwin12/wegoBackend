'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('vehicle_categories', {
            id: {
                type: Sequelize.STRING(36),
                primaryKey: true
            },
            name: {
                type: Sequelize.STRING(64),
                allowNull: false
            },
            slug: {
                type: Sequelize.STRING(64),
                allowNull: false,
                unique: true
            },
            description: {
                type: Sequelize.STRING(255),
                allowNull: true
            },
            icon: {
                type: Sequelize.STRING(64),
                allowNull: true
            },
            isActive: {
                type: Sequelize.BOOLEAN,
                defaultValue: true
            },
            sortOrder: {
                type: Sequelize.INTEGER,
                defaultValue: 0
            },
            createdAt: {
                type: Sequelize.DATE,
                defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
            },
            updatedAt: {
                type: Sequelize.DATE,
                defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
            }
        });

        await queryInterface.addIndex('vehicle_categories', ['slug']);
        await queryInterface.addIndex('vehicle_categories', ['isActive']);
    },

    async down(queryInterface) {
        await queryInterface.dropTable('vehicle_categories');
    }
};
