'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Services marketplace — scaling + moderation cleanup (target: 5M+ listings).
//
//   1. Drop the 20+ duplicate `listing_id` unique indexes left by old
//      sequelize.sync({alter:true}) runs (MySQL caps a table at 64 indexes).
//   2. Add the ranked-browse composite indexes so the public marketplace query
//      (status + is_hero + boost_priority + created_at) is index-ordered — no
//      filesort over millions of rows.
//   3. Add a FULLTEXT index on (title, description) so search scales.
//   4. Extend notifications.type ENUM with the new service listing events.
//   5. Repair rows whose status was silently stored as '' by the old code that
//      wrote the invalid value 'pending'.
//
// Idempotent — safe to run repeatedly. Run with scripts/run-migration.js.
// ═══════════════════════════════════════════════════════════════════════════

async function getIndexes(qi, table) {
    return qi.showIndex(table).catch(() => []);
}

async function addIndexIfMissing(qi, table, opts) {
    const indexes = await getIndexes(qi, table);
    if (indexes.some((ix) => ix.name === opts.name)) return;
    await qi.addIndex(table, opts).catch((e) => {
        console.warn(`  ⚠️  ${opts.name}: ${e.message}`);
    });
}

module.exports = {
    async up(queryInterface) {
        const sequelize = queryInterface.sequelize;

        // ── 1. Drop duplicate listing_id indexes (keep exactly one) ──────────
        const indexes = await getIndexes(queryInterface, 'service_listings');
        const listingIdDuplicates = indexes
            .filter((ix) => ix.name === 'listing_id' || /^listing_id_\d+$/.test(ix.name))
            .map((ix) => ix.name);
        // Keep the canonical idx_listing_id; drop every legacy duplicate.
        for (const name of [...new Set(listingIdDuplicates)]) {
            await queryInterface.removeIndex('service_listings', name).catch((e) => {
                console.warn(`  ⚠️  drop ${name}: ${e.message}`);
            });
        }
        console.log(`  ✔ dropped ${listingIdDuplicates.length} duplicate listing_id indexes`);
        // Make sure a single unique index on listing_id still exists.
        await addIndexIfMissing(queryInterface, 'service_listings', {
            fields: ['listing_id'], unique: true, name: 'uq_listing_id',
        });

        // ── 2. Ranked-browse composite indexes ───────────────────────────────
        // General marketplace browse: active, featured first, then paid boost,
        // then newest. Serves ORDER BY is_hero DESC, boost_priority DESC, created_at DESC.
        await addIndexIfMissing(queryInterface, 'service_listings', {
            fields: ['status', 'is_hero', 'boost_priority', 'created_at'],
            name:   'sl_browse_rank',
        });
        // Same ranking but scoped to a category (category filter is the hot path).
        await addIndexIfMissing(queryInterface, 'service_listings', {
            fields: ['category_id', 'status', 'is_hero', 'boost_priority', 'created_at'],
            name:   'sl_cat_browse_rank',
        });

        // ── 3. FULLTEXT search index ─────────────────────────────────────────
        const haveFt = (await getIndexes(queryInterface, 'service_listings'))
            .some((ix) => ix.name === 'ft_listing_search');
        if (!haveFt) {
            await sequelize.query(
                'ALTER TABLE service_listings ADD FULLTEXT INDEX ft_listing_search (title, description)'
            ).catch((e) => console.warn(`  ⚠️  ft_listing_search: ${e.message}`));
        }

        // ── 4. Extend notifications.type ENUM ────────────────────────────────
        const [cols] = await sequelize.query("SHOW COLUMNS FROM notifications LIKE 'type'");
        if (cols.length) {
            const current = cols[0].Type; // e.g. enum('A','B',...)
            const values = (current.match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1));
            const wanted = ['SERVICE_LISTING_APPROVED', 'SERVICE_LISTING_REJECTED'];
            const missing = wanted.filter((v) => !values.includes(v));
            if (missing.length) {
                const all = [...values, ...missing];
                const enumList = all.map((v) => `'${v.replace(/'/g, "''")}'`).join(',');
                await sequelize.query(
                    `ALTER TABLE notifications MODIFY COLUMN type ENUM(${enumList}) NOT NULL`
                ).catch((e) => console.warn(`  ⚠️  notifications enum: ${e.message}`));
                console.log(`  ✔ added notification types: ${missing.join(', ')}`);
            }
        }

        // ── 5. Repair bad status rows ────────────────────────────────────────
        // Old code wrote the invalid ENUM value 'pending' → MySQL stored ''.
        const [r1] = await sequelize.query(
            "UPDATE service_listings SET status='pending_review' WHERE status='' OR status IS NULL"
        );
        // Legacy 'approved' rows should be live under the new flow.
        const [r2] = await sequelize.query(
            "UPDATE service_listings SET status='active' WHERE status='approved'"
        );
        console.log(`  ✔ repaired ${r1.affectedRows || 0} empty-status + ${r2.affectedRows || 0} legacy-approved rows`);
    },

    async down(queryInterface) {
        const drop = async (t, n) => queryInterface.removeIndex(t, n).catch(() => {});
        await drop('service_listings', 'sl_browse_rank');
        await drop('service_listings', 'sl_cat_browse_rank');
        await drop('service_listings', 'ft_listing_search');
        // Enum values and data repairs are intentionally NOT reverted.
    },
};
