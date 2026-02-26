// backend/src/models/ServiceRating.js
// Service Rating Model for Services Marketplace

const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class ServiceRating extends Model {}

// ═══════════════════════════════════════════════════════════════════════
// MODEL DEFINITION
// ═══════════════════════════════════════════════════════════════════════

ServiceRating.init(
    {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },

        // Request Reference
        request_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            unique: true,
            comment: 'Service request ID (one rating per request)',
        },

        // Provider & Customer
        provider_id: {
            type: DataTypes.CHAR(36),
            allowNull: false,
            comment: 'Account UUID of service provider being rated',
        },

        customer_id: {
            type: DataTypes.CHAR(36),
            allowNull: false,
            comment: 'Account UUID of customer who rated',
        },

        listing_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            comment: 'Service listing ID',
        },

        // Overall Rating
        rating: {
            type: DataTypes.INTEGER,
            allowNull: false,
            validate: {
                min: 1,
                max: 5,
            },
            comment: 'Overall rating (1-5 stars)',
        },

        // Specific Ratings
        quality_rating: {
            type: DataTypes.INTEGER,
            allowNull: true,
            validate: {
                min: 1,
                max: 5,
            },
            comment: 'Quality of work rating',
        },

        professionalism_rating: {
            type: DataTypes.INTEGER,
            allowNull: true,
            validate: {
                min: 1,
                max: 5,
            },
            comment: 'Professionalism rating',
        },

        communication_rating: {
            type: DataTypes.INTEGER,
            allowNull: true,
            validate: {
                min: 1,
                max: 5,
            },
            comment: 'Communication rating',
        },

        value_rating: {
            type: DataTypes.INTEGER,
            allowNull: true,
            validate: {
                min: 1,
                max: 5,
            },
            comment: 'Value for money rating',
        },

        // Review
        review_text: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'Written review (optional, 10-500 chars if provided)',
        },

        review_photos: {
            type: DataTypes.JSON,
            allowNull: true,
            comment: 'Array of photo URLs (max 3)',
        },

        // Moderation
        is_verified: {
            type: DataTypes.BOOLEAN,
            defaultValue: true,
            comment: 'Verified as legitimate rating',
        },

        is_flagged: {
            type: DataTypes.BOOLEAN,
            defaultValue: false,
            comment: 'Flagged for inappropriate content',
        },

        flagged_reason: {
            type: DataTypes.TEXT,
            allowNull: true,
        },

        moderated_by: {
            type: DataTypes.INTEGER,
            allowNull: true,
            comment: 'Employee ID who moderated',
        },

        moderated_at: {
            type: DataTypes.DATE,
            allowNull: true,
        },

        // Provider Response
        provider_response: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'Provider can respond to review',
        },

        provider_responded_at: {
            type: DataTypes.DATE,
            allowNull: true,
        },

        // Helpfulness
        helpful_count: {
            type: DataTypes.INTEGER,
            defaultValue: 0,
            comment: 'Number of users who found this helpful',
        },

        // Soft Delete
        deleted_at: {
            type: DataTypes.DATE,
            allowNull: true,
        },
    },
    {
        sequelize,
        modelName: 'ServiceRating',
        tableName: 'service_ratings',
        timestamps: true,
        paranoid: true,
        underscored: true,
    }
);

module.exports = ServiceRating;