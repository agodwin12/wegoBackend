'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('trips', {
      id: { type: Sequelize.STRING(36), primaryKey: true },
      passengerId: { type: Sequelize.STRING(36), allowNull: false },
      driverId: Sequelize.STRING(36),
      status: {
        type: Sequelize.ENUM('draft','searching','matched','driver_en_route','arrived_pickup','in_progress','completed','canceled','no_drivers'),
        defaultValue: 'searching'
      },
      pickupLat: { type: Sequelize.DECIMAL(10,7), allowNull: false },
      pickupLng: { type: Sequelize.DECIMAL(10,7), allowNull: false },
      pickupAddress: Sequelize.STRING(255),
      dropoffLat: { type: Sequelize.DECIMAL(10,7), allowNull: false },
      dropoffLng: { type: Sequelize.DECIMAL(10,7), allowNull: false },
      dropoffAddress: Sequelize.STRING(255),
      routePolyline: Sequelize.TEXT,
      distance_m: Sequelize.INTEGER,
      duration_s: Sequelize.INTEGER,
      fare_estimate: Sequelize.INTEGER,
      fare_final: Sequelize.INTEGER,
      payment_method: { type: Sequelize.ENUM('cash','momo','om'), defaultValue: 'cash' },
      cancel_reason: Sequelize.STRING(120),
      createdAt: { type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updatedAt: { type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });
    await queryInterface.addIndex('trips', ['passengerId','createdAt']);
    await queryInterface.addIndex('trips', ['driverId','status']);
    await queryInterface.addIndex('trips', ['status']);
  },
  async down(queryInterface) { await queryInterface.dropTable('trips'); }
};
