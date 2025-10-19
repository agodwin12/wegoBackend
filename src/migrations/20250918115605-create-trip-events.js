'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('trip_events', {
      id: { type: Sequelize.STRING(36), primaryKey: true },
      tripId: { type: Sequelize.STRING(36), allowNull: false },
      type: { type: Sequelize.STRING(64), allowNull: false },
      payload: Sequelize.JSON,
      createdAt: { type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });
  },
  async down(queryInterface) { await queryInterface.dropTable('trip_events'); }
};
