// src/models/Rating.js
const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class Rating extends Model {}

Rating.init({
    id: {
        type: DataTypes.CHAR(36),
        primaryKey: true,
    },
    trip_id: {
        type: DataTypes.CHAR(36),
        allowNull: false,
    },
    rated_by: {
        type: DataTypes.CHAR(36),
        allowNull: false,
    },
    rated_user: {
        type: DataTypes.CHAR(36),
        allowNull: false,
    },
    rating_type: {
        type: DataTypes.ENUM('DRIVER_TO_PASSENGER', 'PASSENGER_TO_DRIVER'),
        allowNull: false,
    },
    stars: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
    comment: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
}, {
    sequelize,
    modelName: 'Rating',
    tableName: 'ratings',
    underscored: true,
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
        { unique: true, fields: ['trip_id', 'rated_by'] }
    ]
});

module.exports = Rating;