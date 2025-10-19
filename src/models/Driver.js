// src/models/Driver.js
const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class Driver extends Model {}
Driver.init({
    id: { type: DataTypes.STRING(36), primaryKey: true },
    userId: { type: DataTypes.STRING(36), allowNull: false },
    status: { type: DataTypes.ENUM('offline','online','busy'), defaultValue: 'offline' },
    lat: { type: DataTypes.DECIMAL(10,7) },
    lng: { type: DataTypes.DECIMAL(10,7) },
    heading: { type: DataTypes.FLOAT },
    phone: { type: DataTypes.STRING(32) },
    rating: { type: DataTypes.FLOAT, defaultValue: 5.0 },
    vehicleId: { type: DataTypes.STRING(36) },
    lastHeartbeat: { type: DataTypes.DATE },
}, { sequelize, modelName: 'Driver', tableName: 'drivers',
    indexes: [
        { fields: ['status'] },
        { fields: ['lastHeartbeat'] }
    ]
});

module.exports = Driver;
