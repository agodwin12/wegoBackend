// src/models/Driver.js
const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class Driver extends Model {}

Driver.init({
    id: {
        type:       DataTypes.STRING(36),
        primaryKey: true,
    },
    userId: {
        type:      DataTypes.STRING(36),
        allowNull: false,
    },
    status: {
        type:         DataTypes.ENUM('offline', 'online', 'busy'),
        defaultValue: 'offline',
    },
    lat: {
        type: DataTypes.DECIMAL(10, 7),
    },
    lng: {
        type: DataTypes.DECIMAL(10, 7),
    },
    heading: {
        type: DataTypes.FLOAT,
    },
    phone: {
        type: DataTypes.STRING(32),
    },
    rating: {
        type:         DataTypes.FLOAT,
        defaultValue: 5.0,
    },
    vehicleId: {
        type: DataTypes.STRING(36),
    },

    // ─── Vehicle info ─────────────────────────────────────────────────────────
    // Used by delivery agents who don't have a Vehicle record in the vehicles table.
    // Regular drivers get vehicle info from the Vehicle model via vehicleId.
    vehicle_make_model: {
        type:         DataTypes.STRING(150),
        allowNull:    true,
        defaultValue: null,
    },

    lastHeartbeat: {
        type: DataTypes.DATE,
    },

    // ─── DELIVERY MODE TOGGLE ─────────────────────────────────────────────────
    // 'ride'     → receives trip booking requests (default)
    // 'delivery' → receives delivery requests only
    //
    // ⚠️  This column requires migration — run:
    //    npx sequelize-cli db:migrate
    current_mode: {
        type:         DataTypes.ENUM('ride', 'delivery'),
        allowNull:    false,
        defaultValue: 'ride',
    },

}, {
    sequelize,
    modelName: 'Driver',
    tableName: 'drivers',
    underscored: false,

    indexes: [
        { fields: ['status'] },
        { fields: ['lastHeartbeat'] },
        { fields: ['current_mode'] },
        { fields: ['status', 'current_mode'] },
    ],
});

module.exports = Driver;