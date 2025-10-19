// src/models/Payment.js
const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class Payment extends Model {}
Payment.init({
    id: { type: DataTypes.STRING(36), primaryKey: true },
    tripId: { type: DataTypes.STRING(36), allowNull: false },
    method: { type: DataTypes.ENUM('cash','momo','om'), allowNull: false, defaultValue: 'cash' },
    amount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    status: { type: DataTypes.ENUM('pending','settled','failed'), allowNull: false, defaultValue: 'pending' },
    reference: { type: DataTypes.STRING(128) },
}, { sequelize, modelName: 'Payment', tableName: 'payments',
    indexes: [{ unique: true, fields: ['tripId','method'] }]
});

module.exports = Payment;
