// src/models/passengerProfile.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PassengerProfile = sequelize.define(
    'PassengerProfile',
    {
        account_id: {
            type: DataTypes.CHAR(36),      // ✅ matches Account.uuid type
            allowNull: false,
            primaryKey: true,
        },
        address_text: { type: DataTypes.STRING(255), allowNull: true },
        notes: { type: DataTypes.STRING(255), allowNull: true },
    },
    {
        tableName: 'passenger_profiles',
        timestamps: true,
    }
);

module.exports = PassengerProfile;
