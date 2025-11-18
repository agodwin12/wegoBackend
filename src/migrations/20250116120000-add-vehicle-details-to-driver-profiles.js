// src/migrations/20250116120000-add-driver-documents-and-vehicle-fields.js
'use strict';

module.exports = {
    up: async (queryInterface, Sequelize) => {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔄 [MIGRATION UP] Adding driver documents and vehicle fields...');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        const transaction = await queryInterface.sequelize.transaction();

        try {
            // ═══════════════════════════════════════════════════════════════════
            // ADD DOCUMENT URL FIELDS
            // ═══════════════════════════════════════════════════════════════════

            console.log('📄 [MIGRATION] Adding license_document_url column...');
            await queryInterface.addColumn(
                'driver_profiles',
                'license_document_url',
                {
                    type: Sequelize.STRING(255),
                    allowNull: true,
                    comment: 'URL to uploaded driver license document/photo',
                },
                { transaction }
            );
            console.log('✅ [MIGRATION] license_document_url added');

            console.log('📄 [MIGRATION] Adding insurance_document_url column...');
            await queryInterface.addColumn(
                'driver_profiles',
                'insurance_document_url',
                {
                    type: Sequelize.STRING(255),
                    allowNull: true,
                    comment: 'URL to uploaded insurance document/photo',
                },
                { transaction }
            );
            console.log('✅ [MIGRATION] insurance_document_url added');

            // ═══════════════════════════════════════════════════════════════════
            // ADD VEHICLE DETAIL FIELDS
            // ═══════════════════════════════════════════════════════════════════

            console.log('🚗 [MIGRATION] Adding vehicle_type column...');
            await queryInterface.addColumn(
                'driver_profiles',
                'vehicle_type',
                {
                    type: Sequelize.STRING(50),
                    allowNull: true,
                    comment: 'Vehicle category (Economy, Comfort, Luxury, Standard)',
                },
                { transaction }
            );
            console.log('✅ [MIGRATION] vehicle_type added');

            console.log('🚗 [MIGRATION] Adding vehicle_make_model column...');
            await queryInterface.addColumn(
                'driver_profiles',
                'vehicle_make_model',
                {
                    type: Sequelize.STRING(100),
                    allowNull: true,
                    comment: 'Vehicle make and model (e.g., "Toyota Corolla", "Honda Civic")',
                },
                { transaction }
            );
            console.log('✅ [MIGRATION] vehicle_make_model added');

            console.log('🚗 [MIGRATION] Adding vehicle_color column...');
            await queryInterface.addColumn(
                'driver_profiles',
                'vehicle_color',
                {
                    type: Sequelize.STRING(50),
                    allowNull: true,
                    comment: 'Vehicle color (e.g., "Black", "White", "Silver", "Blue")',
                },
                { transaction }
            );
            console.log('✅ [MIGRATION] vehicle_color added');

            // ═══════════════════════════════════════════════════════════════════
            // CHECK IF OLD VEHICLE COLUMNS EXIST AND REMOVE THEM (OPTIONAL)
            // ═══════════════════════════════════════════════════════════════════

            // Check if vehicle_brand exists (old schema)
            const tableDescription = await queryInterface.describeTable('driver_profiles');

            if (tableDescription.vehicle_brand) {
                console.log('🔄 [MIGRATION] Removing old vehicle_brand column...');
                await queryInterface.removeColumn('driver_profiles', 'vehicle_brand', { transaction });
                console.log('✅ [MIGRATION] vehicle_brand removed');
            }

            if (tableDescription.vehicle_model) {
                console.log('🔄 [MIGRATION] Removing old vehicle_model column...');
                await queryInterface.removeColumn('driver_profiles', 'vehicle_model', { transaction });
                console.log('✅ [MIGRATION] vehicle_model removed');
            }

            await transaction.commit();

            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('✅ [MIGRATION UP] Successfully added all fields!');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        } catch (error) {
            await transaction.rollback();
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.error('❌ [MIGRATION UP FAILED]');
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.error('Error:', error.message);
            console.error('Stack:', error.stack);
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
            throw error;
        }
    },

    down: async (queryInterface, Sequelize) => {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('⏪ [MIGRATION DOWN] Rolling back driver documents and vehicle fields...');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        const transaction = await queryInterface.sequelize.transaction();

        try {
            // ═══════════════════════════════════════════════════════════════════
            // REMOVE DOCUMENT URL FIELDS
            // ═══════════════════════════════════════════════════════════════════

            console.log('🗑️  [MIGRATION] Removing license_document_url column...');
            await queryInterface.removeColumn('driver_profiles', 'license_document_url', { transaction });
            console.log('✅ [MIGRATION] license_document_url removed');

            console.log('🗑️  [MIGRATION] Removing insurance_document_url column...');
            await queryInterface.removeColumn('driver_profiles', 'insurance_document_url', { transaction });
            console.log('✅ [MIGRATION] insurance_document_url removed');

            // ═══════════════════════════════════════════════════════════════════
            // REMOVE VEHICLE DETAIL FIELDS
            // ═══════════════════════════════════════════════════════════════════

            console.log('🗑️  [MIGRATION] Removing vehicle_type column...');
            await queryInterface.removeColumn('driver_profiles', 'vehicle_type', { transaction });
            console.log('✅ [MIGRATION] vehicle_type removed');

            console.log('🗑️  [MIGRATION] Removing vehicle_make_model column...');
            await queryInterface.removeColumn('driver_profiles', 'vehicle_make_model', { transaction });
            console.log('✅ [MIGRATION] vehicle_make_model removed');

            console.log('🗑️  [MIGRATION] Removing vehicle_color column...');
            await queryInterface.removeColumn('driver_profiles', 'vehicle_color', { transaction });
            console.log('✅ [MIGRATION] vehicle_color removed');

            // ═══════════════════════════════════════════════════════════════════
            // OPTIONALLY RE-ADD OLD COLUMNS (if you had them before)
            // ═══════════════════════════════════════════════════════════════════

            console.log('🔄 [MIGRATION] Re-adding old vehicle_brand column...');
            await queryInterface.addColumn(
                'driver_profiles',
                'vehicle_brand',
                {
                    type: Sequelize.STRING(100),
                    allowNull: true,
                },
                { transaction }
            );
            console.log('✅ [MIGRATION] vehicle_brand re-added');

            console.log('🔄 [MIGRATION] Re-adding old vehicle_model column...');
            await queryInterface.addColumn(
                'driver_profiles',
                'vehicle_model',
                {
                    type: Sequelize.STRING(100),
                    allowNull: true,
                },
                { transaction }
            );
            console.log('✅ [MIGRATION] vehicle_model re-added');

            await transaction.commit();

            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('✅ [MIGRATION DOWN] Successfully rolled back all changes!');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        } catch (error) {
            await transaction.rollback();
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.error('❌ [MIGRATION DOWN FAILED]');
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.error('Error:', error.message);
            console.error('Stack:', error.stack);
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
            throw error;
        }
    }
};