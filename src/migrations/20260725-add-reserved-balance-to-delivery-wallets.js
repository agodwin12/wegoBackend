'use strict';

// The pre-paid delivery commission service (deliveryCommission.service.js)
// reserves an agent's commission in `reserved_balance` on accept and moves it
// out of `balance` on completion. The column was referenced in code but never
// created, so every delivery accept with a commission threw
// "Unknown column 'reserved_balance'". This adds it.

module.exports = {
    async up(queryInterface, Sequelize) {
        const table = await queryInterface.describeTable('delivery_wallets');
        if (!table.reserved_balance) {
            await queryInterface.addColumn('delivery_wallets', 'reserved_balance', {
                type:         Sequelize.DECIMAL(12, 2),
                allowNull:    false,
                defaultValue: 0.00,
            });
        }
    },

    async down(queryInterface) {
        const table = await queryInterface.describeTable('delivery_wallets');
        if (table.reserved_balance) {
            await queryInterface.removeColumn('delivery_wallets', 'reserved_balance');
        }
    },
};
