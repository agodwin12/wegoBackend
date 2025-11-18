// src/models/rating.model.js

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/**
 * Rating Model
 * Stores ratings between drivers and passengers
 */
const Rating = sequelize.define('Rating', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
    },

    // Trip reference
    tripId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'trip_id',
    },

    // Who gave the rating
    ratedBy: {
        type: DataTypes.UUID,
        allowNull: false,
        comment: 'UUID of account who gave the rating',
        field: 'rated_by',
    },

    // Who received the rating
    ratedUser: {
        type: DataTypes.UUID,
        allowNull: false,
        comment: 'UUID of account who received the rating',
        field: 'rated_user',
    },

    // Rating type
    ratingType: {
        type: DataTypes.ENUM('DRIVER_TO_PASSENGER', 'PASSENGER_TO_DRIVER'),
        allowNull: false,
        comment: 'Type of rating',
        field: 'rating_type',
    },

    // Star rating (1-5)
    stars: {
        type: DataTypes.INTEGER,
        allowNull: false,
        validate: {
            min: 1,
            max: 5,
        },
        comment: 'Star rating from 1 to 5',
    },

    // Optional comment
    comment: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'Optional text comment',
    },

    // Timestamps
    createdAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        field: 'created_at',
    },

    updatedAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        field: 'updated_at',
    },
}, {
    sequelize,
    modelName: 'Rating',
    tableName: 'ratings',
    timestamps: true,
    underscored: true,
    indexes: [
        {
            fields: ['trip_id', 'rating_type'],
            unique: true,
            name: 'idx_ratings_trip_type',
        },
        {
            fields: ['rated_user'],
            name: 'idx_ratings_rated_user',
        },
        {
            fields: ['rated_by'],
            name: 'idx_ratings_rated_by',
        },
    ],
});

module.exports = Rating;