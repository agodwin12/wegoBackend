'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Deliveries scaling (target: 200k+ concurrent senders, millions of rows).
//
// Driver matching already runs off Redis geo (locationService.findNearbyDrivers),
// so it doesn't touch this table. The SQL hot paths that DO need indexes:
//   • "does this sender already have an active delivery?"  (sender_id, status)
//   • agent history + bonus counting  (driver_id, status, delivered_at)
//   • admin list ordering / status filters  (status, created_at)
//
// Also drops the 20+ duplicate delivery_code indexes left by old
// sequelize.sync({alter:true}) runs (MySQL caps a table at 64 indexes).
//
// Idempotent. Run with scripts/run-migration.js.
// ═══════════════════════════════════════════════════════════════════════════

async function getIndexes(qi) {
    return qi.showIndex('deliveries').catch(() => []);
}

async function addIndexIfMissing(qi, opts) {
    const idx = await getIndexes(qi);
    if (idx.some((i) => i.name === opts.name)) return;
    await qi.addIndex('deliveries', opts).catch((e) => console.warn(`  ⚠️  ${opts.name}: ${e.message}`));
}

module.exports = {
    async up(queryInterface) {
        // ── Drop duplicate delivery_code indexes (keep one unique) ───────────
        const idx = await getIndexes(queryInterface);
        const dupes = idx
            .filter((i) => i.name === 'delivery_code' || /^delivery_code_\d+$/.test(i.name))
            .map((i) => i.name);
        for (const name of [...new Set(dupes)]) {
            await queryInterface.removeIndex('deliveries', name).catch((e) => console.warn(`  ⚠️  drop ${name}: ${e.message}`));
        }
        console.log(`  ✔ dropped ${dupes.length} duplicate delivery_code indexes`);
        await addIndexIfMissing(queryInterface, { fields: ['delivery_code'], unique: true, name: 'uq_delivery_code' });

        // ── Scaling composite indexes ────────────────────────────────────────
        await addIndexIfMissing(queryInterface, {
            fields: ['sender_id', 'status'], name: 'idx_deliveries_sender_status',
        });
        await addIndexIfMissing(queryInterface, {
            fields: ['driver_id', 'status', 'delivered_at'], name: 'idx_deliveries_driver_status_delivered',
        });
        await addIndexIfMissing(queryInterface, {
            fields: ['status', 'created_at'], name: 'idx_deliveries_status_created',
        });
    },

    async down(queryInterface) {
        const drop = async (n) => queryInterface.removeIndex('deliveries', n).catch(() => {});
        await drop('idx_deliveries_sender_status');
        await drop('idx_deliveries_driver_status_delivered');
        await drop('idx_deliveries_status_created');
    },
};
