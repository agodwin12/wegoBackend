// src/models/Rating.js
const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class Rating extends Model {}
Rating.init({
    id: { type: DataTypes.STRING(36), primaryKey: true },
    tripId: { type: DataTypes.STRING(36), allowNull: false },
    raterId: { type: DataTypes.STRING(36), allowNull: false },
    rateeId: { type: DataTypes.STRING(36), allowNull: false },
    stars: { type: DataTypes.TINYINT, allowNull: false },
    tags: { type: DataTypes.JSON },
    comment: { type: DataTypes.STRING(1000) },
}, { sequelize, modelName: 'Rating', tableName: 'ratings', updatedAt: false,
    indexes: [{ unique: true, fields: ['tripId','raterId'] }]

});

module.exports = Rating;
