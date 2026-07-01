'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Scaling indexes for vehicle rental (target: 50k+ vehicles).
// Without these, browsing available vehicles by region/availability and
// filtering rentals by status/payment/date do full table scans.
// Idempotent — safe to run repeatedly. Run with scripts/run-migration.js.
// ═══════════════════════════════════════════════════════════════════════════

async function addIndexIfMissing(qi, table, fields, name) {
    const indexes = await qi.showIndex(table).catch(() => []);
    if (indexes.some((ix) => ix.name === name)) return;
    await qi.addIndex(table, { fields, name }).catch((e) => {
        console.warn(`  ⚠️  ${name}: ${e.message}`);
    });
}

module.exports = {
    async up(queryInterface) {
        // ── vehicles: the public "available to rent" browse filter ──────────
        // Includes created_at so ORDER BY created_at DESC is served by the index
        // (no filesort over the matched rows — critical at 50k vehicles).
        await addIndexIfMissing(queryInterface, 'vehicles',
            ['region', 'available_for_rent', 'is_blocked', 'created_at'], 'idx_vehicles_browse');
        await addIndexIfMissing(queryInterface, 'vehicles',
            ['available_for_rent'], 'idx_vehicles_available');
        await addIndexIfMissing(queryInterface, 'vehicles',
            ['category_id', 'available_for_rent'], 'idx_vehicles_category_available');

        // ── vehicle_rentals: admin filters + availability/date overlap ──────
        await addIndexIfMissing(queryInterface, 'vehicle_rentals',
            ['status'], 'idx_rentals_status');
        await addIndexIfMissing(queryInterface, 'vehicle_rentals',
            ['payment_status'], 'idx_rentals_payment_status');
        await addIndexIfMissing(queryInterface, 'vehicle_rentals',
            ['status', 'payment_status'], 'idx_rentals_status_payment');
        await addIndexIfMissing(queryInterface, 'vehicle_rentals',
            ['vehicle_id', 'start_date', 'end_date'], 'idx_rentals_vehicle_dates');
    },

    async down(queryInterface) {
        const drop = async (t, n) => queryInterface.removeIndex(t, n).catch(() => {});
        await drop('vehicles', 'idx_vehicles_browse');
        await drop('vehicles', 'idx_vehicles_available');
        await drop('vehicles', 'idx_vehicles_category_available');
        await drop('vehicle_rentals', 'idx_rentals_status');
        await drop('vehicle_rentals', 'idx_rentals_payment_status');
        await drop('vehicle_rentals', 'idx_rentals_status_payment');
        await drop('vehicle_rentals', 'idx_rentals_vehicle_dates');
    },
};
