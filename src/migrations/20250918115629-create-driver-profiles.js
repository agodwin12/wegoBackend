'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('driver_profiles', {
      account_id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true },
      cni_number: { type: Sequelize.STRING(64), allowNull: false },
      license_number: { type: Sequelize.STRING(64), allowNull: false },
      license_expiry: { type: Sequelize.DATEONLY, allowNull: false },
      insurance_number: Sequelize.STRING(64),
      insurance_expiry: Sequelize.DATEONLY,
      rating_avg: { type: Sequelize.DECIMAL(3,2), defaultValue: 0.00 },
      rating_count: { type: Sequelize.INTEGER.UNSIGNED, defaultValue: 0 },
      vehicle_type: Sequelize.STRING(50),
      vehicle_plate: Sequelize.STRING(32),
      avatar_url: Sequelize.STRING(255),
      status: { type: Sequelize.ENUM('offline','online','on_trip','suspended'), defaultValue: 'offline' },
      current_lat: Sequelize.DECIMAL(10,7),
      current_lng: Sequelize.DECIMAL(10,7),
      verification_state: { type: Sequelize.ENUM('UNVERIFIED','PENDING','VERIFIED','REJECTED'), defaultValue: 'PENDING' },
      createdAt: { type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updatedAt: { type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });
  },
  async down(queryInterface) { await queryInterface.dropTable('driver_profiles'); }
};
