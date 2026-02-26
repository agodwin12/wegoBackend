// migrations/XXXXXX-add-vehicle-type-to-price-rules.js

'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🚀 [MIGRATION] Adding vehicle_type to price_rules...');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        // Step 1: Add vehicle_type column — nullable first so existing rows don't break
        await queryInterface.addColumn('price_rules', 'vehicle_type', {
            type: Sequelize.ENUM('economy', 'comfort', 'luxury'),
            allowNull: true, // temporarily nullable for existing rows
            defaultValue: 'economy',
            comment: 'Vehicle category this pricing applies to',
            after: 'city', // places it right after city column (MySQL only, ignored in Postgres)
        });

        console.log('✅ [MIGRATION] vehicle_type column added');

        // Step 2: Set all existing rows to 'economy' (safe default)
        await queryInterface.sequelize.query(`
      UPDATE price_rules SET vehicle_type = 'economy' WHERE vehicle_type IS NULL
    `);

        console.log('✅ [MIGRATION] Existing rows defaulted to economy');

        // Step 3: Now make it NOT NULL since all rows have a value
        await queryInterface.changeColumn('price_rules', 'vehicle_type', {
            type: Sequelize.ENUM('economy', 'comfort', 'luxury'),
            allowNull: false,
            defaultValue: 'economy',
            comment: 'Vehicle category this pricing applies to',
        });

        console.log('✅ [MIGRATION] vehicle_type set to NOT NULL');

        // Step 4: Remove old unique index on city if it exists (city alone is no longer unique)
        try {
            await queryInterface.removeIndex('price_rules', ['city']);
            console.log('✅ [MIGRATION] Old city index removed');
        } catch (e) {
            console.log('ℹ️  [MIGRATION] No single-city index to remove, skipping');
        }

        // Step 5: Add new unique index on (city, vehicle_type)
        // One row per city+vehicle combination
        await queryInterface.addIndex('price_rules', ['city', 'vehicle_type'], {
            unique: true,
            name: 'price_rules_city_vehicle_type_unique',
        });

        console.log('✅ [MIGRATION] Unique index on (city, vehicle_type) added');

        // Step 6: Add index on vehicle_type alone for fast lookups
        await queryInterface.addIndex('price_rules', ['vehicle_type'], {
            unique: false,
            name: 'price_rules_vehicle_type_idx',
        });

        console.log('✅ [MIGRATION] Index on vehicle_type added');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🎉 [MIGRATION] price_rules migration complete');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    },

    async down(queryInterface, Sequelize) {
        console.log('⏪ [MIGRATION] Rolling back vehicle_type changes...');

        // Remove the indexes we added
        try {
            await queryInterface.removeIndex(
                'price_rules',
                'price_rules_city_vehicle_type_unique'
            );
        } catch (e) {
            console.log('ℹ️  Unique index not found, skipping');
        }

        try {
            await queryInterface.removeIndex(
                'price_rules',
                'price_rules_vehicle_type_idx'
            );
        } catch (e) {
            console.log('ℹ️  vehicle_type index not found, skipping');
        }

        // Restore old city index
        await queryInterface.addIndex('price_rules', ['city'], {
            unique: false,
            name: 'price_rules_city_idx',
        });

        // Drop the column (also drops the ENUM type in Postgres)
        await queryInterface.removeColumn('price_rules', 'vehicle_type');

        console.log('✅ [MIGRATION] Rollback complete');
    },
};