'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Delivery agent bonus program.
//
// Reuses the existing bonus_programs / bonus_awards tables (built for rides).
//   1. bonus_programs.vertical — scopes a program to RIDE / DELIVERY / BOTH so
//      the ride engine and the delivery engine each evaluate only their own.
//      Existing programs default to RIDE (no behaviour change).
//   2. delivery_wallets.total_bonuses — lifetime bonus total for reporting.
//   3. delivery_wallet_transactions.type += 'bonus_quest' — the ledger row that
//      credits a milestone bonus to the agent's wallet.
//
// Idempotent. Run with scripts/run-migration.js.
// ═══════════════════════════════════════════════════════════════════════════

async function columnMissing(qi, table, column) {
    const desc = await qi.describeTable(table).catch(() => ({}));
    return !desc[column];
}

async function enumAddValue(sequelize, table, column, newValues, notNull = true) {
    const [cols] = await sequelize.query(`SHOW COLUMNS FROM ${table} LIKE '${column}'`);
    if (!cols.length) return;
    const current = cols[0].Type;
    const values  = (current.match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1));
    const missing = newValues.filter((v) => !values.includes(v));
    if (!missing.length) return;
    const all      = [...values, ...missing];
    const enumList = all.map((v) => `'${v.replace(/'/g, "''")}'`).join(',');
    await sequelize.query(
        `ALTER TABLE ${table} MODIFY COLUMN ${column} ENUM(${enumList}) ${notNull ? 'NOT NULL' : 'NULL'}`
    );
    console.log(`  ✔ ${table}.${column} += ${missing.join(', ')}`);
}

module.exports = {
    async up(queryInterface, Sequelize) {
        const { DataTypes } = Sequelize;
        const sequelize = queryInterface.sequelize;

        // 1. bonus_programs.vertical
        if (await columnMissing(queryInterface, 'bonus_programs', 'vertical')) {
            await queryInterface.addColumn('bonus_programs', 'vertical', {
                type: DataTypes.ENUM('RIDE', 'DELIVERY', 'BOTH'),
                allowNull: false,
                defaultValue: 'RIDE',
                comment: 'Which vertical this bonus program applies to',
            });
            await queryInterface.addIndex('bonus_programs', {
                fields: ['vertical'], name: 'bonus_programs_vertical',
            }).catch((e) => console.warn(`  ⚠️  bonus_programs_vertical: ${e.message}`));
            console.log('  ✔ bonus_programs.vertical added (default RIDE)');
        }

        // 2. delivery_wallets.total_bonuses
        if (await columnMissing(queryInterface, 'delivery_wallets', 'total_bonuses')) {
            await queryInterface.addColumn('delivery_wallets', 'total_bonuses', {
                type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0,
                comment: 'Lifetime bonus XAF credited to this wallet',
            });
            console.log('  ✔ delivery_wallets.total_bonuses added');
        }

        // 3. delivery_wallet_transactions.type += bonus_quest
        await enumAddValue(sequelize, 'delivery_wallet_transactions', 'type', ['bonus_quest']);

        // 4. notifications.type += DELIVERY_BONUS_EARNED
        await enumAddValue(sequelize, 'notifications', 'type', ['DELIVERY_BONUS_EARNED']);
    },

    async down(queryInterface) {
        await queryInterface.removeIndex('bonus_programs', 'bonus_programs_vertical').catch(() => {});
        await queryInterface.removeColumn('bonus_programs', 'vertical').catch(() => {});
        await queryInterface.removeColumn('delivery_wallets', 'total_bonuses').catch(() => {});
        // ENUM value is left in place (removing it would fail if rows use it).
    },
};
