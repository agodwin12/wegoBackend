// src/models/Vehicle.js
const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class Vehicle extends Model {}

Vehicle.init({
    id: { type: DataTypes.STRING(36), primaryKey: true },
    plate: { type: DataTypes.STRING(24), allowNull: false, unique: true },
    makeModel: DataTypes.STRING(64),
    color: DataTypes.STRING(32),
    seats: { type: DataTypes.INTEGER, defaultValue: 4 },

    partnerId: {
        type: DataTypes.CHAR(36),
        allowNull: false,
        references: { model: 'accounts', key: 'uuid' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
    },

    categoryId: {
        type: DataTypes.STRING(36),
        allowNull: true,
        references: { model: 'vehicle_categories', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
    },

    availableForRent: { type: DataTypes.BOOLEAN, defaultValue: false },
    rentalPricePerHour: DataTypes.DECIMAL(10, 2),
    rentalPricePerDay: DataTypes.DECIMAL(10, 2),
    rentalCurrency: { type: DataTypes.STRING(10), defaultValue: 'XAF' },
    images: { type: DataTypes.JSON, allowNull: true },
}, {
    sequelize,
    modelName: 'Vehicle',
    tableName: 'vehicles',
    timestamps: true,
});

module.exports = Vehicle;
