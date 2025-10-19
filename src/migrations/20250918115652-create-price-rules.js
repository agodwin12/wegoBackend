'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('price_rules', {
      id: { type: Sequelize.STRING(36), primaryKey: true },
      city: { type: Sequelize.STRING(64), allowNull: false },
      base: { type: Sequelize.INTEGER, defaultValue: 3000 },
      per_km: { type: Sequelize.INTEGER, defaultValue: 0 },
      per_min: { type: Sequelize.INTEGER, defaultValue: 0 },
      min_fare: { type: Sequelize.INTEGER, defaultValue: 3000 },
      surge_mult: { type: Sequelize.FLOAT, defaultValue: 1.0 },
      createdAt: { type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updatedAt: { type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });
    await queryInterface.addIndex('price_rules', ['city','createdAt']);
  },
  async down(queryInterface) { await queryInterface.dropTable('price_rules'); }
};
