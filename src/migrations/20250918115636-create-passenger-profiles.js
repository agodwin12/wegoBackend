'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('passenger_profiles', {
      account_id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true },
      address_text: Sequelize.STRING(255),
      notes: Sequelize.STRING(255),
      createdAt: Sequelize.DATE,
      updatedAt: Sequelize.DATE
    });
  },
  async down(queryInterface) { await queryInterface.dropTable('passenger_profiles'); }
};
