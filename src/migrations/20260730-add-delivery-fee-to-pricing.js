'use strict';

// Unified delivery: a flat, back-office-configurable delivery fee applied to
// every delivery when enabled (replaces the old express-only surcharge).

module.exports = {
    async up(queryInterface, Sequelize) {
        const table = await queryInterface.describeTable('delivery_pricing');
        if (!table.delivery_fee) {
            await queryInterface.addColumn('delivery_pricing', 'delivery_fee', {
                type:         Sequelize.DECIMAL(10, 2),
                allowNull:    false,
                defaultValue: 0.00,
            });
        }
        if (!table.delivery_fee_enabled) {
            await queryInterface.addColumn('delivery_pricing', 'delivery_fee_enabled', {
                type:         Sequelize.BOOLEAN,
                allowNull:    false,
                defaultValue: false,
            });
        }
    },

    async down(queryInterface) {
        const table = await queryInterface.describeTable('delivery_pricing');
        if (table.delivery_fee)         await queryInterface.removeColumn('delivery_pricing', 'delivery_fee');
        if (table.delivery_fee_enabled) await queryInterface.removeColumn('delivery_pricing', 'delivery_fee_enabled');
    },
};
