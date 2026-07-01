'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Wire coupons into deliveries.
//
// The Coupon / CouponUsage system already exists (originally built for rides).
// Deliveries never referenced it. This adds the snapshot columns so a discount
// applied at booking time is auditable on the delivery row itself, and indexes
// the coupon linkage for reporting.
//
// Funding model (platform-funded): the discount reduces what the SENDER pays
// and is absorbed by WeGo's commission — the driver's payout is never reduced.
// original_total_price preserves the pre-discount price for reporting.
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

        if (await columnMissing(queryInterface, 'deliveries', 'coupon_id')) {
            await queryInterface.addColumn('deliveries', 'coupon_id', {
                type: DataTypes.STRING(36), allowNull: true,
                comment: 'FK to coupons.id — coupon redeemed on this delivery',
            });
        }
        if (await columnMissing(queryInterface, 'deliveries', 'coupon_code')) {
            await queryInterface.addColumn('deliveries', 'coupon_code', {
                type: DataTypes.STRING(20), allowNull: true,
                comment: 'Snapshot of the redeemed coupon code',
            });
        }
        if (await columnMissing(queryInterface, 'deliveries', 'discount_amount')) {
            await queryInterface.addColumn('deliveries', 'discount_amount', {
                type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0,
                comment: 'Discount applied to the sender price (XAF). Absorbed by commission.',
            });
        }
        if (await columnMissing(queryInterface, 'deliveries', 'original_total_price')) {
            await queryInterface.addColumn('deliveries', 'original_total_price', {
                type: DataTypes.DECIMAL(10, 2), allowNull: true,
                comment: 'Sender price before any coupon discount (for reporting)',
            });
        }

        // Index the coupon linkage (reporting: "all redemptions of coupon X").
        const indexes = await queryInterface.showIndex('deliveries').catch(() => []);
        if (!indexes.some((ix) => ix.name === 'idx_deliveries_coupon')) {
            await queryInterface.addIndex('deliveries', {
                fields: ['coupon_id'], name: 'idx_deliveries_coupon',
            }).catch((e) => console.warn(`  ⚠️  idx_deliveries_coupon: ${e.message}`));
        }

        // coupon_usage was rides-only (trip_id). Add delivery_id so a redemption
        // can point at a delivery instead of a trip.
        if (await columnMissing(queryInterface, 'coupon_usage', 'delivery_id')) {
            await queryInterface.addColumn('coupon_usage', 'delivery_id', {
                type: DataTypes.INTEGER, allowNull: true,
                comment: 'FK to deliveries.id when the coupon was used on a delivery',
            });
            await queryInterface.addIndex('coupon_usage', {
                fields: ['delivery_id'], name: 'idx_coupon_usage_delivery',
            }).catch((e) => console.warn(`  ⚠️  idx_coupon_usage_delivery: ${e.message}`));
        }
    },

    async down(queryInterface) {
        const drop = async (col) =>
            queryInterface.removeColumn('deliveries', col).catch(() => {});
        await queryInterface.removeIndex('deliveries', 'idx_deliveries_coupon').catch(() => {});
        await drop('coupon_id');
        await drop('coupon_code');
        await drop('discount_amount');
        await drop('original_total_price');
    },
};
