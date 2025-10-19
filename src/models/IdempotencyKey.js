const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class IdempotencyKey extends Model {}
IdempotencyKey.init({
    key: { type: DataTypes.STRING(128), primaryKey: true },
    userId: { type: DataTypes.STRING(36), allowNull: false },
    resultType: { type: DataTypes.STRING(32), allowNull: false },
    resultId: { type: DataTypes.STRING(64), allowNull: false },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, { sequelize, modelName: 'IdempotencyKey', tableName: 'idempotency_keys', updatedAt: false });

module.exports = IdempotencyKey;
