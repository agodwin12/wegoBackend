'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Wire coupons into ride-hailing trips.
//
// Rides are P2P / commission-only: the passenger pays the driver directly and
// WeGo only debits commission from the driver's prepaid wallet. A coupon here is
// PLATFORM-FUNDED by giving up commission:
//   • passenger pays  fareEstimate − discountAmount  (to the driver, P2P)
//   • at settlement WeGo reduces its commission by discountAmount (floored at 0)
//   • discount is capped at the commission so the driver's net is unchanged and
//     WeGo never has to pay the driver.
//
// originalFare preserves the pre-discount fare for reporting.
// The trips table uses camelCase columns (underscored:false).
//
// Idempotent. Run with scripts/run-migration.js.
// ═══════════════════════════════════════════════════════════════════════════

async function columnMissing(qi, table, column) {
    const desc = await qi.describeTable(table).catch(() => ({}));
    return !desc[column];
}

module.exports = {
    async up(queryInterface, Sequelize) {
        const { DataTypes } = Sequelize;

        if (await columnMissing(queryInterface, 'trips', 'couponId')) {
            await queryInterface.addColumn('trips', 'couponId', {
                type: DataTypes.STRING(36), allowNull: true,
            });
        }
        if (await columnMissing(queryInterface, 'trips', 'couponCode')) {
            await queryInterface.addColumn('trips', 'couponCode', {
                type: DataTypes.STRING(20), allowNull: true,
            });
        }
        if (await columnMissing(queryInterface, 'trips', 'discountAmount')) {
            await queryInterface.addColumn('trips', 'discountAmount', {
                type: DataTypes.INTEGER, allowNull: false, defaultValue: 0,
            });
        }
        if (await columnMissing(queryInterface, 'trips', 'originalFare')) {
            await queryInterface.addColumn('trips', 'originalFare', {
                type: DataTypes.INTEGER, allowNull: true,
            });
        }

        const indexes = await queryInterface.showIndex('trips').catch(() => []);
        if (!indexes.some((ix) => ix.name === 'idx_trips_coupon')) {
            await queryInterface.addIndex('trips', {
                fields: ['couponId'], name: 'idx_trips_coupon',
            }).catch((e) => console.warn(`  ⚠️  idx_trips_coupon: ${e.message}`));
        }
        console.log('  ✔ trips coupon columns ready');
    },

    async down(queryInterface) {
        await queryInterface.removeIndex('trips', 'idx_trips_coupon').catch(() => {});
        for (const c of ['couponId', 'couponCode', 'discountAmount', 'originalFare']) {
            await queryInterface.removeColumn('trips', c).catch(() => {});
        }
    },
};
