'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('ratings', {
      id: { type: Sequelize.STRING(36), primaryKey: true },
      tripId: { type: Sequelize.STRING(36), allowNull: false },
      raterId: { type: Sequelize.STRING(36), allowNull: false },
      rateeId: { type: Sequelize.STRING(36), allowNull: false },
      stars: { type: Sequelize.TINYINT, allowNull: false },
      tags: Sequelize.JSON,
      comment: Sequelize.STRING(1000),
      createdAt: { type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });
    await queryInterface.addIndex('ratings', ['tripId','raterId'], { unique: true });
  },
  async down(queryInterface) { await queryInterface.dropTable('ratings'); }
};
