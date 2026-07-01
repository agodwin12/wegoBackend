'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Minimal migration runner — this project does not use sequelize-cli.
// Usage:
//   node scripts/run-migration.js <path-to-migration> [up|down]
// Example:
//   node scripts/run-migration.js migrations/20260701000000-add-google-auth-to-accounts.js up
//
// Migrations must export { up(queryInterface, Sequelize), down(...) } and
// should be idempotent (this runner has no SequelizeMeta tracking).
// ═══════════════════════════════════════════════════════════════════════════

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), override: true });

const { Sequelize } = require('sequelize');
const sequelize     = require('../src/config/database');

(async () => {
    const file = process.argv[2];
    const dir  = process.argv[3] || 'up';

    if (!file) {
        console.error('Usage: node scripts/run-migration.js <migration-file> [up|down]');
        process.exit(1);
    }
    if (dir !== 'up' && dir !== 'down') {
        console.error('Direction must be "up" or "down".');
        process.exit(1);
    }

    const migration = require(path.resolve(process.cwd(), file));
    if (typeof migration[dir] !== 'function') {
        console.error(`Migration has no ${dir}() export.`);
        process.exit(1);
    }

    const qi = sequelize.getQueryInterface();
    console.log(`▶  Running ${dir}() of ${file} ...`);
    await migration[dir](qi, Sequelize);
    console.log('✅ Migration step complete.');
    await sequelize.close();
    process.exit(0);
})().catch((e) => {
    console.error('❌ Migration failed:', e.message);
    process.exit(1);
});
