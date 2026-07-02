'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Strict tier matching: store the tier the passenger requested on the trip.
// Matching then only offers the trip to drivers whose DriverProfile
// vehicle_type is the SAME tier (economy/comfort/luxury).
// Existing rows default to 'economy'. Idempotent.
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
    async up(queryInterface, Sequelize) {
        const desc = await queryInterface.describeTable('trips').catch(() => ({}));
        if (!desc.vehicleType) {
            await queryInterface.addColumn('trips', 'vehicleType', {
                type: Sequelize.DataTypes.STRING(20),
                allowNull: false,
                defaultValue: 'economy',
                comment: 'Requested ride tier (economy/comfort/luxury) — drives strict driver matching',
            });
            console.log('  ✔ trips.vehicleType added');
        }
    },

    async down(queryInterface) {
        await queryInterface.removeColumn('trips', 'vehicleType').catch(() => {});
    },
};
