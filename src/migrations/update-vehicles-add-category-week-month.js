'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        // Add categoryId column
        await queryInterface.addColumn('vehicles', 'categoryId', {
            type: Sequelize.STRING(36),
            allowNull: true,
            references: { model: 'vehicle_categories', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL'
        });

        // Add weekly + monthly rental prices
        await queryInterface.addColumn('vehicles', 'rentalPricePerWeek', {
            type: Sequelize.DECIMAL(10, 2),
            allowNull: true
        });
        await queryInterface.addColumn('vehicles', 'rentalPricePerMonth', {
            type: Sequelize.DECIMAL(10, 2),
            allowNull: true
        });

        await queryInterface.addIndex('vehicles', ['categoryId']);
    },

    async down(queryInterface) {
        await queryInterface.removeColumn('vehicles', 'categoryId');
        await queryInterface.removeColumn('vehicles', 'rentalPricePerWeek');
        await queryInterface.removeColumn('vehicles', 'rentalPricePerMonth');
    }
};
