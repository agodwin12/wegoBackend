// src/models/TripEvent.js
const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class TripEvent extends Model {}
TripEvent.init({
    id: { type: DataTypes.STRING(36), primaryKey: true },
    tripId: { type: DataTypes.STRING(36), allowNull: false },
    type: { type: DataTypes.STRING(64), allowNull: false },
    payload: { type: DataTypes.JSON },
}, { sequelize, modelName: 'TripEvent', tableName: 'trip_events', updatedAt: false });

module.exports = TripEvent;
