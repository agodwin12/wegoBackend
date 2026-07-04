'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// RIDE-HAILING FLEET OWNERS  (distinct from vehicle-rental "Partners")
//
// A Fleet Owner is a company/person WeGo onboards to run a fleet of
// ride-hailing drivers. Created by WeGo staff in the backoffice with KYC
// documents. Completely separate from the rental PartnerProfile concept.
//
//   1. accounts.user_type gains 'FLEET_OWNER'
//   2. accounts.fleet_owner_id → the FLEET_OWNER account that owns a driver
//   3. fleet_owner_profiles → KYC (ID card front/back, NIU number + document)
//
// Idempotent. Run with scripts/run-migration.js.
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
    async up(queryInterface, Sequelize) {
        const { DataTypes } = Sequelize;

        // 1. Add FLEET_OWNER to the user_type enum (idempotent).
        const [enumRows] = await queryInterface.sequelize.query(
            "SHOW COLUMNS FROM accounts LIKE 'user_type'"
        );
        const enumType = enumRows?.[0]?.Type || '';
        if (!enumType.includes("'FLEET_OWNER'")) {
            await queryInterface.sequelize.query(
                "ALTER TABLE accounts MODIFY COLUMN user_type " +
                "ENUM('PASSENGER','DRIVER','PARTNER','ADMIN','DELIVERY_AGENT','FLEET_OWNER') NOT NULL"
            );
            console.log('  ✔ user_type enum gained FLEET_OWNER');
        }

        // 2. accounts.fleet_owner_id
        const acc = await queryInterface.describeTable('accounts').catch(() => ({}));
        if (!acc.fleet_owner_id) {
            await queryInterface.addColumn('accounts', 'fleet_owner_id', {
                type: DataTypes.CHAR(36),
                allowNull: true,
                comment: 'FLEET_OWNER account (accounts.uuid) that owns this driver — NULL for independents',
            });
            console.log('  ✔ accounts.fleet_owner_id added');
        }
        const idx = await queryInterface.showIndex('accounts').catch(() => []);
        if (!idx.some((i) => i.name === 'idx_accounts_fleet_owner')) {
            await queryInterface.addIndex('accounts', {
                fields: ['fleet_owner_id'], name: 'idx_accounts_fleet_owner',
            }).catch((e) => console.warn(`  ⚠️  idx_accounts_fleet_owner: ${e.message}`));
            console.log('  ✔ idx_accounts_fleet_owner added');
        }

        // 3. fleet_owner_profiles (describeTable throws when the table is absent)
        let hasTable = true;
        try { await queryInterface.describeTable('fleet_owner_profiles'); }
        catch { hasTable = false; }
        if (!hasTable) {
            await queryInterface.createTable('fleet_owner_profiles', {
                id:            { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
                // No DB-level FK (avoids charset/collation friction with accounts.uuid);
                // the 1:1 link + cascade on delete are enforced in the controller.
                account_id:    { type: DataTypes.CHAR(36), allowNull: false, unique: true },
                company_name:  { type: DataTypes.STRING(128), allowNull: false },
                contact_name:  { type: DataTypes.STRING(128), allowNull: true },
                phone_number:  { type: DataTypes.STRING(20),  allowNull: false },
                email:         { type: DataTypes.STRING(128), allowNull: false },
                address:       { type: DataTypes.STRING(255), allowNull: true },
                profile_photo: { type: DataTypes.STRING(512), allowNull: true },
                // KYC documents (R2 URLs)
                id_card_front_url: { type: DataTypes.STRING(512), allowNull: true },
                id_card_back_url:  { type: DataTypes.STRING(512), allowNull: true },
                niu_number:        { type: DataTypes.STRING(50),  allowNull: true },
                niu_document_url:  { type: DataTypes.STRING(512), allowNull: true },
                created_by_employee_id: { type: DataTypes.CHAR(36), allowNull: true },
                created_at:    { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
                updated_at:    { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
            });
            await queryInterface.addIndex('fleet_owner_profiles', { unique: true, fields: ['account_id'], name: 'uniq_fleet_owner_account' }).catch(() => {});
            await queryInterface.addIndex('fleet_owner_profiles', { fields: ['email'], name: 'idx_fleet_owner_email' }).catch(() => {});
            console.log('  ✔ fleet_owner_profiles created');
        }
    },

    async down(queryInterface) {
        await queryInterface.dropTable('fleet_owner_profiles').catch(() => {});
        await queryInterface.removeIndex('accounts', 'idx_accounts_fleet_owner').catch(() => {});
        await queryInterface.removeColumn('accounts', 'fleet_owner_id').catch(() => {});
        // enum value left in place (harmless)
    },
};
