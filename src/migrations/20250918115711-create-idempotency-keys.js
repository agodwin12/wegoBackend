'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('idempotency_keys', {
      key: { type: Sequelize.STRING(128), primaryKey: true },
      userId: { type: Sequelize.STRING(36), allowNull: false },
      resultType: { type: Sequelize.STRING(32), allowNull: false },
      resultId: { type: Sequelize.STRING(64), allowNull: false },
      createdAt: { type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });
  },
  async down(queryInterface) { await queryInterface.dropTable('idempotency_keys'); }
};
