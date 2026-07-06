'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Provider-level service subscriptions.
//
// service_ad_payments.listing_id becomes NULLABLE: a provider-level
// subscription (a plan granting N posts / validity) is NOT tied to a single
// listing. Per-listing activations keep their listing_id; subscriptions use
// NULL. The createListing posting gate reads the provider's active plan.
// Idempotent.
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
    async up(queryInterface, Sequelize) {
        const desc = await queryInterface.describeTable('service_ad_payments').catch(() => ({}));
        if (desc.listing_id && desc.listing_id.allowNull === false) {
            await queryInterface.changeColumn('service_ad_payments', 'listing_id', {
                type: Sequelize.DataTypes.INTEGER,
                allowNull: true,
                comment: 'ServiceListing id — NULL for a provider-level subscription',
            });
            console.log('  ✔ service_ad_payments.listing_id is now nullable');
        } else {
            console.log('  ℹ️  service_ad_payments.listing_id already nullable');
        }
    },

    async down(queryInterface, Sequelize) {
        // Only revert if no subscription (NULL) rows exist, to avoid breaking data.
        const [[row]] = await queryInterface.sequelize.query(
            "SELECT COUNT(*) AS n FROM service_ad_payments WHERE listing_id IS NULL"
        );
        if (Number(row.n) === 0) {
            await queryInterface.changeColumn('service_ad_payments', 'listing_id', {
                type: Sequelize.DataTypes.INTEGER,
                allowNull: false,
            }).catch(() => {});
        }
    },
};
