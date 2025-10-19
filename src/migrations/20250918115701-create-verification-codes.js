'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('verification_codes', {
      id: { type: Sequelize.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true },
      account_id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false },
      channel: { type: Sequelize.ENUM('SMS','EMAIL'), allowNull: false },
      target: { type: Sequelize.STRING(190), allowNull: false },
      code_hash: { type: Sequelize.STRING(255), allowNull: false },
      purpose: { type: Sequelize.ENUM('PHONE_VERIFY','EMAIL_VERIFY','PASSWORD_RESET','MFA'), allowNull: false },
      attempts: { type: Sequelize.INTEGER.UNSIGNED, defaultValue: 0 },
      max_attempts: { type: Sequelize.INTEGER.UNSIGNED, defaultValue: 5 },
      expires_at: { type: Sequelize.DATE, allowNull: false },
      consumed_at: Sequelize.DATE,
      createdAt: { type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });
    await queryInterface.addIndex('verification_codes', ['account_id','purpose','expires_at']);
  },
  async down(queryInterface) { await queryInterface.dropTable('verification_codes'); }
};
