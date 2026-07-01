'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Add Google OAuth support to `accounts`.
// ───────────────────────────────────────────────────────────────────────────
// Idempotent: each step checks whether it has already been applied, so it is
// safe to run on a DB where a previous sequelize.sync({alter:true}) already
// created some of these columns. Use with sequelize-cli:
//     npx sequelize-cli db:migrate
// or run programmatically via scripts/run-migration.js.
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
    async up(queryInterface, Sequelize) {
        const table = 'accounts';
        const desc  = await queryInterface.describeTable(table);

        // ── 1. Columns ──────────────────────────────────────────────────────
        if (!desc.google_id) {
            await queryInterface.addColumn(table, 'google_id', {
                type: Sequelize.STRING(255), allowNull: true,
                comment: 'Google subject (sub) claim — stable unique Google user id.',
            });
        }
        if (!desc.auth_provider) {
            await queryInterface.addColumn(table, 'auth_provider', {
                type: Sequelize.ENUM('LOCAL', 'GOOGLE', 'LOCAL_GOOGLE'),
                allowNull: false, defaultValue: 'LOCAL',
            });
        }
        if (!desc.last_login_provider) {
            await queryInterface.addColumn(table, 'last_login_provider', {
                type: Sequelize.ENUM('LOCAL', 'GOOGLE'), allowNull: true,
            });
        }
        if (!desc.google_avatar_url) {
            await queryInterface.addColumn(table, 'google_avatar_url', {
                type: Sequelize.STRING(500), allowNull: true,
            });
        }

        // ── 2. password_hash must be NULLABLE (Google accounts have no password)
        if (desc.password_hash && desc.password_hash.allowNull === false) {
            await queryInterface.changeColumn(table, 'password_hash', {
                type: Sequelize.STRING(255), allowNull: true,
            });
        }

        // ── 3. Unique index on google_id (only if no unique index covers it) ─
        const indexes = await queryInterface.showIndex(table);
        const hasGoogleUnique = indexes.some(
            (ix) => ix.unique && ix.fields && ix.fields.some((f) => f.attribute === 'google_id')
        );
        if (!hasGoogleUnique) {
            await queryInterface.addIndex(table, {
                fields: ['google_id'], unique: true, name: 'accounts_google_id_unique',
            });
        }

        // ── 4. Helpful non-unique indexes ───────────────────────────────────
        const hasAuthProviderIdx = indexes.some((ix) => ix.name === 'accounts_auth_provider_idx');
        if (desc.auth_provider && !hasAuthProviderIdx) {
            await queryInterface.addIndex(table, {
                fields: ['auth_provider'], name: 'accounts_auth_provider_idx',
            }).catch(() => {});
        }
    },

    async down(queryInterface, Sequelize) {
        const table = 'accounts';
        await queryInterface.removeIndex(table, 'accounts_google_id_unique').catch(() => {});
        await queryInterface.removeIndex(table, 'accounts_auth_provider_idx').catch(() => {});
        for (const col of ['google_avatar_url', 'last_login_provider', 'auth_provider', 'google_id']) {
            await queryInterface.removeColumn(table, col).catch(() => {});
        }
    },
};
