// src/models/ChatMessage.js
const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class ChatMessage extends Model {}

ChatMessage.init({
    id: {
        type: DataTypes.CHAR(36),
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4
    },
    tripId: {
        type: DataTypes.CHAR(36),
        allowNull: false,
        references: {
            model: 'trips',
            key: 'id'
        }
    },
    fromUserId: {
        type: DataTypes.CHAR(36),
        allowNull: false,
        references: {
            model: 'accounts',
            key: 'uuid'
        }
    },
    text: {
        type: DataTypes.STRING(2000),
        allowNull: false
    },
    readAt: {
        type: DataTypes.DATE
    },
}, {
    sequelize,
    modelName: 'ChatMessage',
    tableName: 'chat_messages',
    timestamps: true,
    underscored: false,
    indexes: [
        { fields: ['tripId', 'createdAt'] }
    ]
});

// ────────────────────────────────────────────────────────────────
// ASSOCIATIONS
// ────────────────────────────────────────────────────────────────

ChatMessage.associate = (models) => {
    // ChatMessage belongs to Account (sender)
    ChatMessage.belongsTo(models.Account, {
        foreignKey: 'fromUserId',
        as: 'sender',
        targetKey: 'uuid',
    });

    // ChatMessage belongs to Trip
    ChatMessage.belongsTo(models.Trip, {
        foreignKey: 'tripId',
        as: 'trip',
    });
};

module.exports = ChatMessage;