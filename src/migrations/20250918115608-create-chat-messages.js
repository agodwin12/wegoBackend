'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('chat_messages', {
      id: {
        type: Sequelize.STRING(36),
        primaryKey: true
      },
      tripId: {
        type: Sequelize.STRING(36),
        allowNull: false
      },
      fromUserId: {
        type: Sequelize.STRING(36),
        allowNull: false
      },
      text: {
        type: Sequelize.STRING(2000),
        allowNull: false
      },
      readAt: {
        type: Sequelize.DATE
      },
      createdAt: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      },
      updatedAt: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      }
    });

    // ✅ Add index for tripId + createdAt (for efficient chat history queries)
    await queryInterface.addIndex('chat_messages', ['tripId', 'createdAt']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('chat_messages');
  }
};
