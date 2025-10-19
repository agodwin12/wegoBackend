// src/models/ChatMessage.js
const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class ChatMessage extends Model {}
ChatMessage.init({
    id: { type: DataTypes.STRING(36), primaryKey: true },
    tripId: { type: DataTypes.STRING(36), allowNull: false },
    fromUserId: { type: DataTypes.STRING(36), allowNull: false },
    text: { type: DataTypes.STRING(2000), allowNull: false },
    readAt: { type: DataTypes.DATE },
}, { sequelize, modelName: 'ChatMessage', tableName: 'chat_messages',
    indexes: [{ fields: ['tripId', 'createdAt'] }]
});

module.exports = ChatMessage;
