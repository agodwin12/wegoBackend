'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Partner fleet ownership.
//
// accounts.partner_id → the PARTNER account (accounts.uuid) that owns this
// driver. Partner-created drivers carry it; independent drivers stay NULL.
// One column powers ownership checks, fleet listing, and KPI aggregation.
// Idempotent. Run with scripts/run-migration.js.
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
    async up(queryInterface, Sequelize) {
        const desc = await queryInterface.describeTable('accounts').catch(() => ({}));
        if (!desc.partner_id) {
            await queryInterface.addColumn('accounts', 'partner_id', {
                type: Sequelize.DataTypes.CHAR(36),
                allowNull: true,
                comment: 'PARTNER account (accounts.uuid) that owns this driver — NULL for independents',
            });
            console.log('  ✔ accounts.partner_id added');
        }
        const indexes = await queryInterface.showIndex('accounts').catch(() => []);
        if (!indexes.some((ix) => ix.name === 'idx_accounts_partner')) {
            await queryInterface.addIndex('accounts', {
                fields: ['partner_id'], name: 'idx_accounts_partner',
            }).catch((e) => console.warn(`  ⚠️  idx_accounts_partner: ${e.message}`));
            console.log('  ✔ idx_accounts_partner added');
        }
    },

    async down(queryInterface) {
        await queryInterface.removeIndex('accounts', 'idx_accounts_partner').catch(() => {});
        await queryInterface.removeColumn('accounts', 'partner_id').catch(() => {});
    },
};
