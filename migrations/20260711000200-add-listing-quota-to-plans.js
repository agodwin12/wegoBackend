'use strict';

// Adds service_listing_plans.listing_quota (max active listings a subscriber
// may post under the plan; NULL = unlimited). The model + the createListing
// posting gate rely on it. Idempotent.

module.exports = {
    async up(queryInterface, Sequelize) {
        const desc = await queryInterface.describeTable('service_listing_plans').catch(() => ({}));
        if (!desc.listing_quota) {
            await queryInterface.addColumn('service_listing_plans', 'listing_quota', {
                type: Sequelize.DataTypes.INTEGER,
                allowNull: true,
                comment: 'Max active listings under this plan — NULL = unlimited',
            });
            console.log('  ✔ service_listing_plans.listing_quota added');
        } else {
            console.log('  ℹ️  listing_quota already present');
        }
    },

    async down(queryInterface) {
        await queryInterface.removeColumn('service_listing_plans', 'listing_quota').catch(() => {});
    },
};
