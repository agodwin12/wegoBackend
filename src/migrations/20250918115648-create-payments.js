'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('payments', {
      id: { type: Sequelize.STRING(36), primaryKey: true },
      tripId: { type: Sequelize.STRING(36), allowNull: false },
      method: { type: Sequelize.ENUM('cash','momo','om'), defaultValue: 'cash' },
      amount: { type: Sequelize.INTEGER, defaultValue: 0 },
      status: { type: Sequelize.ENUM('pending','settled','failed'), defaultValue: 'pending' },
      reference: Sequelize.STRING(128),
      createdAt: { type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updatedAt: { type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });
    await queryInterface.addIndex('payments', ['tripId','method'], { unique: true });
  },
  async down(queryInterface) { await queryInterface.dropTable('payments'); }
};
