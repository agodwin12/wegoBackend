// src/models/Vehicle.js
const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class Vehicle extends Model {}

Vehicle.init({
    id: {
        type: DataTypes.STRING(36),
        primaryKey: true,
    },
    plate: {
        type: DataTypes.STRING(24),
        allowNull: false,
        unique: true,
    },
    makeModel: {
        type: DataTypes.STRING(64),
        allowNull: true,
    },
    color: {
        type: DataTypes.STRING(32),
        allowNull: true,
    },
    region: {
        type: DataTypes.STRING(64),
        allowNull: false,
        defaultValue: 'Littoral', // Regions: Littoral, Centre, Ouest, etc.
    },
    seats: {
        type: DataTypes.INTEGER,
        defaultValue: 4,
    },
    partnerId: {
        type: DataTypes.CHAR(36),
        allowNull: false, // Vehicle ALWAYS belongs to a partner
        references: { model: 'accounts', key: 'uuid' },
    },
    postedByEmployeeId: {
        type: DataTypes.CHAR(36),
        allowNull: true, // Employee who posted the vehicle
        references: { model: 'accounts', key: 'uuid' },
    },
    categoryId: {
        type: DataTypes.STRING(36),
        allowNull: true,
        references: { model: 'vehicle_categories', key: 'id' },
    },
    availableForRent: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
    },
    rentalPricePerHour: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
    },
    rentalPricePerDay: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
    },
    rentalPricePerWeek: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
    },
    rentalPricePerMonth: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
    },
    rentalCurrency: {
        type: DataTypes.STRING(10),
        defaultValue: 'XAF',
    },
    images: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: [],
    },
}, {
    sequelize,
    modelName: 'Vehicle',
    tableName: 'vehicles',
    timestamps: true,
    underscored: true,
});

module.exports = Vehicle;