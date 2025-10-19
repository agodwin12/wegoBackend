'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('drivers', {
      id: { type: Sequelize.STRING(36), primaryKey: true },
      userId: { type: Sequelize.STRING(36), allowNull: false },
      status: { type: Sequelize.ENUM('offline','online','busy'), defaultValue: 'offline' },
      lat: Sequelize.DECIMAL(10,7),
      lng: Sequelize.DECIMAL(10,7),
      heading: Sequelize.FLOAT,
      phone: Sequelize.STRING(32),
      rating: { type: Sequelize.FLOAT, defaultValue: 5.0 },
      vehicleId: Sequelize.STRING(36),
      lastHeartbeat: Sequelize.DATE,
      createdAt: { type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updatedAt: { type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });
    await queryInterface.addIndex('drivers', ['status']);
    await queryInterface.addIndex('drivers', ['lastHeartbeat']);
  },
  async down(queryInterface) { await queryInterface.dropTable('drivers'); }
};
