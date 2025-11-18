'use strict';

/**
 * Migration: Fix Trip Schema Inconsistencies
 *
 * This migration fixes the database schema to match the Trip model:
 * 1. Renames columns from snake_case to camelCase
 * 2. Updates ENUM values from lowercase to UPPERCASE
 *
 * IMPORTANT: This migration assumes the table exists and has data.
 * It performs a careful column renaming and enum update.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      console.log('🔄 [MIGRATION] Starting Trip schema fixes...');

      // Step 1: Rename columns to camelCase
      console.log('📝 [MIGRATION] Renaming columns to camelCase...');

      await queryInterface.renameColumn('trips', 'distance_m', 'distanceM', { transaction });
      await queryInterface.renameColumn('trips', 'duration_s', 'durationS', { transaction });
      await queryInterface.renameColumn('trips', 'fare_estimate', 'fareEstimate', { transaction });
      await queryInterface.renameColumn('trips', 'fare_final', 'fareFinal', { transaction });
      await queryInterface.renameColumn('trips', 'payment_method', 'paymentMethod', { transaction });
      await queryInterface.renameColumn('trips', 'cancel_reason', 'cancelReason', { transaction });

      console.log('✅ [MIGRATION] Column renaming complete');

      // Step 2: Add new timestamp columns if they don't exist
      console.log('📝 [MIGRATION] Adding timestamp columns...');

      const tableDescription = await queryInterface.describeTable('trips', { transaction });

      if (!tableDescription.driverAssignedAt) {
        await queryInterface.addColumn('trips', 'driverAssignedAt', {
          type: Sequelize.DATE,
          allowNull: true
        }, { transaction });
      }

      if (!tableDescription.driverEnRouteAt) {
        await queryInterface.addColumn('trips', 'driverEnRouteAt', {
          type: Sequelize.DATE,
          allowNull: true
        }, { transaction });
      }

      if (!tableDescription.driverArrivedAt) {
        await queryInterface.addColumn('trips', 'driverArrivedAt', {
          type: Sequelize.DATE,
          allowNull: true
        }, { transaction });
      }

      if (!tableDescription.tripStartedAt) {
        await queryInterface.addColumn('trips', 'tripStartedAt', {
          type: Sequelize.DATE,
          allowNull: true
        }, { transaction });
      }

      if (!tableDescription.tripCompletedAt) {
        await queryInterface.addColumn('trips', 'tripCompletedAt', {
          type: Sequelize.DATE,
          allowNull: true
        }, { transaction });
      }

      if (!tableDescription.canceledAt) {
        await queryInterface.addColumn('trips', 'canceledAt', {
          type: Sequelize.DATE,
          allowNull: true
        }, { transaction });
      }

      if (!tableDescription.canceledBy) {
        await queryInterface.addColumn('trips', 'canceledBy', {
          type: Sequelize.ENUM('PASSENGER', 'DRIVER', 'SYSTEM'),
          allowNull: true
        }, { transaction });
      }

      console.log('✅ [MIGRATION] Timestamp columns added');

      // Step 3: Update status ENUM values to UPPERCASE
      console.log('📝 [MIGRATION] Updating status ENUM to UPPERCASE...');

      // First, change the column type to VARCHAR temporarily to update values
      await queryInterface.changeColumn('trips', 'status', {
        type: Sequelize.STRING(50),
        allowNull: false,
        defaultValue: 'SEARCHING'
      }, { transaction });

      // Update existing values to UPPERCASE
      await queryInterface.sequelize.query(
        `UPDATE trips SET status = CASE
          WHEN status = 'draft' THEN 'DRAFT'
          WHEN status = 'searching' THEN 'SEARCHING'
          WHEN status = 'matched' THEN 'MATCHED'
          WHEN status = 'driver_en_route' THEN 'DRIVER_EN_ROUTE'
          WHEN status = 'arrived_pickup' THEN 'DRIVER_ARRIVED'
          WHEN status = 'in_progress' THEN 'IN_PROGRESS'
          WHEN status = 'completed' THEN 'COMPLETED'
          WHEN status = 'canceled' THEN 'CANCELED'
          WHEN status = 'no_drivers' THEN 'NO_DRIVERS'
          ELSE status
        END`,
        { transaction }
      );

      // Now change back to ENUM with UPPERCASE values
      await queryInterface.changeColumn('trips', 'status', {
        type: Sequelize.ENUM(
          'DRAFT',
          'SEARCHING',
          'MATCHED',
          'DRIVER_ASSIGNED',
          'DRIVER_EN_ROUTE',
          'DRIVER_ARRIVED',
          'IN_PROGRESS',
          'COMPLETED',
          'CANCELED',
          'NO_DRIVERS'
        ),
        allowNull: false,
        defaultValue: 'SEARCHING'
      }, { transaction });

      console.log('✅ [MIGRATION] Status ENUM updated to UPPERCASE');

      // Step 4: Update paymentMethod ENUM to UPPERCASE
      console.log('📝 [MIGRATION] Updating paymentMethod ENUM to UPPERCASE...');

      await queryInterface.changeColumn('trips', 'paymentMethod', {
        type: Sequelize.STRING(50),
        allowNull: false,
        defaultValue: 'CASH'
      }, { transaction });

      await queryInterface.sequelize.query(
        `UPDATE trips SET paymentMethod = CASE
          WHEN paymentMethod = 'cash' THEN 'CASH'
          WHEN paymentMethod = 'momo' THEN 'MOMO'
          WHEN paymentMethod = 'om' THEN 'OM'
          ELSE paymentMethod
        END`,
        { transaction }
      );

      await queryInterface.changeColumn('trips', 'paymentMethod', {
        type: Sequelize.ENUM('CASH', 'MOMO', 'OM'),
        allowNull: false,
        defaultValue: 'CASH'
      }, { transaction });

      console.log('✅ [MIGRATION] PaymentMethod ENUM updated to UPPERCASE');

      await transaction.commit();
      console.log('✅ [MIGRATION] Trip schema fixes completed successfully');

    } catch (error) {
      await transaction.rollback();
      console.error('❌ [MIGRATION] Error during migration:', error);
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      console.log('🔄 [MIGRATION] Reverting Trip schema fixes...');

      // Revert column names
      await queryInterface.renameColumn('trips', 'distanceM', 'distance_m', { transaction });
      await queryInterface.renameColumn('trips', 'durationS', 'duration_s', { transaction });
      await queryInterface.renameColumn('trips', 'fareEstimate', 'fare_estimate', { transaction });
      await queryInterface.renameColumn('trips', 'fareFinal', 'fare_final', { transaction });
      await queryInterface.renameColumn('trips', 'paymentMethod', 'payment_method', { transaction });
      await queryInterface.renameColumn('trips', 'cancelReason', 'cancel_reason', { transaction });

      // Remove new columns
      await queryInterface.removeColumn('trips', 'driverAssignedAt', { transaction });
      await queryInterface.removeColumn('trips', 'driverEnRouteAt', { transaction });
      await queryInterface.removeColumn('trips', 'driverArrivedAt', { transaction });
      await queryInterface.removeColumn('trips', 'tripStartedAt', { transaction });
      await queryInterface.removeColumn('trips', 'tripCompletedAt', { transaction });
      await queryInterface.removeColumn('trips', 'canceledAt', { transaction });
      await queryInterface.removeColumn('trips', 'canceledBy', { transaction });

      // Revert status ENUM
      await queryInterface.changeColumn('trips', 'status', {
        type: Sequelize.STRING(50),
        allowNull: false
      }, { transaction });

      await queryInterface.sequelize.query(
        `UPDATE trips SET status = CASE
          WHEN status = 'DRAFT' THEN 'draft'
          WHEN status = 'SEARCHING' THEN 'searching'
          WHEN status = 'MATCHED' THEN 'matched'
          WHEN status = 'DRIVER_EN_ROUTE' THEN 'driver_en_route'
          WHEN status = 'DRIVER_ARRIVED' THEN 'arrived_pickup'
          WHEN status = 'IN_PROGRESS' THEN 'in_progress'
          WHEN status = 'COMPLETED' THEN 'completed'
          WHEN status = 'CANCELED' THEN 'canceled'
          WHEN status = 'NO_DRIVERS' THEN 'no_drivers'
          ELSE status
        END`,
        { transaction }
      );

      await queryInterface.changeColumn('trips', 'status', {
        type: Sequelize.ENUM('draft','searching','matched','driver_en_route','arrived_pickup','in_progress','completed','canceled','no_drivers'),
        allowNull: false,
        defaultValue: 'searching'
      }, { transaction });

      // Revert paymentMethod ENUM
      await queryInterface.changeColumn('trips', 'payment_method', {
        type: Sequelize.STRING(50),
        allowNull: false
      }, { transaction });

      await queryInterface.sequelize.query(
        `UPDATE trips SET payment_method = CASE
          WHEN payment_method = 'CASH' THEN 'cash'
          WHEN payment_method = 'MOMO' THEN 'momo'
          WHEN payment_method = 'OM' THEN 'om'
          ELSE payment_method
        END`,
        { transaction }
      );

      await queryInterface.changeColumn('trips', 'payment_method', {
        type: Sequelize.ENUM('cash','momo','om'),
        allowNull: false,
        defaultValue: 'cash'
      }, { transaction });

      await transaction.commit();
      console.log('✅ [MIGRATION] Rollback completed successfully');

    } catch (error) {
      await transaction.rollback();
      console.error('❌ [MIGRATION] Error during rollback:', error);
      throw error;
    }
  }
};
