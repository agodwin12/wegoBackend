'use strict';

// Proof-of-delivery photo taken by the agent at the dropoff (in addition to the
// PIN handoff). Stored on the delivery and shown to the sender on completion.

module.exports = {
    async up(queryInterface, Sequelize) {
        const table = await queryInterface.describeTable('deliveries');
        if (!table.proof_photo_url) {
            await queryInterface.addColumn('deliveries', 'proof_photo_url', {
                type:      Sequelize.STRING(1000),
                allowNull: true,
            });
        }
    },

    async down(queryInterface) {
        const table = await queryInterface.describeTable('deliveries');
        if (table.proof_photo_url) {
            await queryInterface.removeColumn('deliveries', 'proof_photo_url');
        }
    },
};
