// backend/src/models/ServiceListing.js
// Service Listing Model for Services Marketplace

const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class ServiceListing extends Model {}

// ═══════════════════════════════════════════════════════════════════════
// MODEL DEFINITION
// ═══════════════════════════════════════════════════════════════════════

ServiceListing.init(
    {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },

        listing_id: {
            type: DataTypes.STRING(50),
            unique: true,
            allowNull: false,
            comment: 'Unique listing identifier (e.g., LIST-20241218-12345)',
        },

        // Provider Information
        provider_id: {
            type: DataTypes.CHAR(36),
            allowNull: false,
            comment: 'Account UUID of service provider',
        },

        // Category
        category_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            comment: 'Service category ID',
        },

        // Service Details
        title: {
            type: DataTypes.STRING(200),
            allowNull: false,
            comment: 'Service title (min 10, max 200 chars)',
        },

        description: {
            type: DataTypes.TEXT,
            allowNull: false,
            comment: 'Service description (min 50, max 2000 chars)',
        },

        // Pricing
        pricing_type: {
            type: DataTypes.ENUM('hourly', 'fixed', 'negotiable'),
            allowNull: false,
            defaultValue: 'fixed',
        },

        hourly_rate: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: true,
            comment: 'Hourly rate in FCFA',
        },

        minimum_charge: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: true,
            comment: 'Minimum charge for hourly services',
        },

        fixed_price: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: true,
            comment: 'Fixed price in FCFA',
        },

        // Location
        city: {
            type: DataTypes.STRING(100),
            allowNull: false,
        },

        neighborhoods: {
            type: DataTypes.JSON,
            allowNull: true,
            comment: 'Array of neighborhoods served',
        },

        service_radius_km: {
            type: DataTypes.INTEGER,
            allowNull: true,
            comment: 'Service radius in kilometers',
        },

        // Photos
        photos: {
            type: DataTypes.JSON,
            allowNull: true,
            comment: 'Array of photo URLs (max 5)',
        },

        // Availability
        available_days: {
            type: DataTypes.JSON,
            allowNull: true,
            comment: 'Array of available days',
        },

        available_hours: {
            type: DataTypes.STRING(100),
            allowNull: true,
            comment: 'Available hours (e.g., "08:00-18:00")',
        },

        emergency_service: {
            type: DataTypes.BOOLEAN,
            defaultValue: false,
            comment: 'Offers 24/7 emergency service',
        },

        // Experience & Portfolio
        years_experience: {
            type: DataTypes.INTEGER,
            allowNull: true,
        },

        certifications: {
            type: DataTypes.TEXT,
            allowNull: true,
        },

        portfolio_links: {
            type: DataTypes.JSON,
            allowNull: true,
            comment: 'Array of portfolio URLs',
        },

        // Status & Moderation
        status: {
            type: DataTypes.ENUM('pending', 'approved', 'active', 'rejected', 'inactive', 'deleted'),
            defaultValue: 'pending',
            allowNull: false,
        },

        rejection_reason: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'Reason for rejection (if rejected)',
        },

        approved_by: {
            type: DataTypes.INTEGER,
            allowNull: true,
            comment: 'Employee ID who approved',
        },

        approved_at: {
            type: DataTypes.DATE,
            allowNull: true,
        },

        rejected_by: {
            type: DataTypes.INTEGER,
            allowNull: true,
            comment: 'Employee ID who rejected',
        },

        rejected_at: {
            type: DataTypes.DATE,
            allowNull: true,
        },

        // Statistics
        view_count: {
            type: DataTypes.INTEGER,
            defaultValue: 0,
        },

        contact_count: {
            type: DataTypes.INTEGER,
            defaultValue: 0,
            comment: 'Number of times contacted',
        },

        booking_count: {
            type: DataTypes.INTEGER,
            defaultValue: 0,
            comment: 'Number of completed bookings',
        },

        // Rating
        average_rating: {
            type: DataTypes.DECIMAL(3, 2),
            allowNull: true,
            comment: 'Average rating (0.00 - 5.00)',
        },

        total_reviews: {
            type: DataTypes.INTEGER,
            defaultValue: 0,
        },

        // Soft Delete
        deleted_at: {
            type: DataTypes.DATE,
            allowNull: true,
        },
    },
    {
        sequelize,
        modelName: 'ServiceListing',
        tableName: 'service_listings',
        timestamps: true,
        paranoid: true,
        underscored: true,
    }
);

module.exports = ServiceListing;