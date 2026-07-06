'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Repair corrupt FK constraints on service_ad_payments.
//
// A historical sequelize.sync({alter:true}) accumulated dozens of duplicate FK
// constraints. Critically, EVERY plan_id foreign key points at
// service_ad_payments(id) instead of service_listing_plans(id) — so inserting
// any ServiceAdPayment (with a real plan_id) fails the constraint, breaking all
// service listing payments and subscriptions.
//
// Fix: drop every misdirected plan_id FK (those not referencing
// service_listing_plans). The plan relationship is enforced in the app layer.
// Also dedupe the redundant hero_reviewed_by FKs (keep one). Idempotent.
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
    async up(queryInterface) {
        const q = queryInterface.sequelize;

        // 1. Drop all plan_id FKs that don't reference service_listing_plans.
        const [wrongPlan] = await q.query(
            "SELECT CONSTRAINT_NAME AS cn FROM information_schema.KEY_COLUMN_USAGE " +
            "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'service_ad_payments' " +
            "AND COLUMN_NAME = 'plan_id' AND REFERENCED_TABLE_NAME IS NOT NULL " +
            "AND REFERENCED_TABLE_NAME <> 'service_listing_plans'"
        );
        for (const { cn } of wrongPlan) {
            await q.query(`ALTER TABLE service_ad_payments DROP FOREIGN KEY \`${cn}\``).catch((e) =>
                console.warn(`  ⚠️  drop ${cn}: ${e.message}`));
        }
        console.log(`  ✔ dropped ${wrongPlan.length} misdirected plan_id FK(s)`);

        // 2. Dedupe redundant hero_reviewed_by FKs — keep the first, drop the rest.
        const [heroFks] = await q.query(
            "SELECT CONSTRAINT_NAME AS cn FROM information_schema.KEY_COLUMN_USAGE " +
            "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'service_ad_payments' " +
            "AND COLUMN_NAME = 'hero_reviewed_by' AND REFERENCED_TABLE_NAME IS NOT NULL " +
            "ORDER BY CONSTRAINT_NAME"
        );
        for (const { cn } of heroFks.slice(1)) {
            await q.query(`ALTER TABLE service_ad_payments DROP FOREIGN KEY \`${cn}\``).catch(() => {});
        }
        if (heroFks.length > 1) console.log(`  ✔ deduped ${heroFks.length - 1} redundant hero_reviewed_by FK(s)`);

        // 3. Dedupe redundant listing_id FKs — keep one.
        const [listingFks] = await q.query(
            "SELECT CONSTRAINT_NAME AS cn FROM information_schema.KEY_COLUMN_USAGE " +
            "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'service_ad_payments' " +
            "AND COLUMN_NAME = 'listing_id' AND REFERENCED_TABLE_NAME IS NOT NULL " +
            "ORDER BY CONSTRAINT_NAME"
        );
        for (const { cn } of listingFks.slice(1)) {
            await q.query(`ALTER TABLE service_ad_payments DROP FOREIGN KEY \`${cn}\``).catch(() => {});
        }
        if (listingFks.length > 1) console.log(`  ✔ deduped ${listingFks.length - 1} redundant listing_id FK(s)`);

        // 4. service_listings.current_plan_id: same corruption — every FK points
        //    at service_ad_payments instead of service_listing_plans. Drop the
        //    misdirected ones (the plan link is enforced in the app).
        const [wrongCurPlan] = await q.query(
            "SELECT CONSTRAINT_NAME AS cn FROM information_schema.KEY_COLUMN_USAGE " +
            "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'service_listings' " +
            "AND COLUMN_NAME = 'current_plan_id' AND REFERENCED_TABLE_NAME IS NOT NULL " +
            "AND REFERENCED_TABLE_NAME <> 'service_listing_plans'"
        );
        for (const { cn } of wrongCurPlan) {
            await q.query(`ALTER TABLE service_listings DROP FOREIGN KEY \`${cn}\``).catch((e) =>
                console.warn(`  ⚠️  drop ${cn}: ${e.message}`));
        }
        if (wrongCurPlan.length) console.log(`  ✔ dropped ${wrongCurPlan.length} misdirected service_listings.current_plan_id FK(s)`);

        // 5. Dedupe redundant service_listings FKs on high-churn columns.
        for (const col of ['provider_id', 'category_id', 'current_plan_id']) {
            const [fks] = await q.query(
                "SELECT CONSTRAINT_NAME AS cn FROM information_schema.KEY_COLUMN_USAGE " +
                "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'service_listings' " +
                `AND COLUMN_NAME = '${col}' AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY CONSTRAINT_NAME`
            );
            for (const { cn } of fks.slice(1)) {
                await q.query(`ALTER TABLE service_listings DROP FOREIGN KEY \`${cn}\``).catch(() => {});
            }
            if (fks.length > 1) console.log(`  ✔ deduped ${fks.length - 1} redundant service_listings.${col} FK(s)`);
        }
    },

    async down() {
        // No-op: we do not re-create the corrupt constraints.
    },
};
