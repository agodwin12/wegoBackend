'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('driver_documents', {
      id: { type: Sequelize.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true },
      account_id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false },
      doc_type: { type: Sequelize.ENUM('DRIVER_LICENSE','INSURANCE','CNI','OTHER'), allowNull: false },
      file_url: { type: Sequelize.STRING(255), allowNull: false },
      number: Sequelize.STRING(128),
      issued_at: Sequelize.DATEONLY,
      expires_at: Sequelize.DATEONLY,
      status: { type: Sequelize.ENUM('PENDING','APPROVED','REJECTED'), defaultValue: 'PENDING' },
      createdAt: { type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updatedAt: { type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });
    await queryInterface.addIndex('driver_documents', ['account_id','doc_type','status']);
  },
  async down(queryInterface) { await queryInterface.dropTable('driver_documents'); }
};
