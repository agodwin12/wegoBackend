// src/models/DriverProfile.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const DriverProfile = sequelize.define('DriverProfile', {
    account_id: {
        type: DataTypes.CHAR(36),
        primaryKey: true,
        allowNull: false,
        references: {
            model: 'accounts',
            key: 'uuid',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
    },

    // ═══════════════════════════════════════════════════════════════════
    // IDENTITY & VERIFICATION
    // ═══════════════════════════════════════════════════════════════════
    cni_number: {
        type: DataTypes.STRING(64),
        allowNull: false,
        comment: 'National ID card number'
    },
    license_number: {
        type: DataTypes.STRING(64),
        allowNull: false,
        comment: 'Driver license number'
    },
    license_expiry: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        comment: 'Driver license expiration date'
    },

    // ✅ NEW: Document upload URLs
    license_document_url: {
        type: DataTypes.STRING(255),
        allowNull: true,
        comment: 'URL to uploaded driver license document/photo'
    },

    insurance_number: {
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: 'Insurance policy number'
    },
    insurance_expiry: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        comment: 'Insurance expiration date'
    },

    // ✅ NEW: Insurance document URL
    insurance_document_url: {
        type: DataTypes.STRING(255),
        allowNull: true,
        comment: 'URL to uploaded insurance document/photo'
    },

    verification_state: {
        type: DataTypes.ENUM('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED'),
        allowNull: false,
        defaultValue: 'PENDING',
        comment: 'Driver verification status'
    },

    // ═══════════════════════════════════════════════════════════════════
    // RATING & PERFORMANCE
    // ═══════════════════════════════════════════════════════════════════
    rating_avg: {
        type: DataTypes.DECIMAL(3, 2),
        allowNull: false,
        defaultValue: 0.00,
        validate: {
            min: 0.00,
            max: 5.00
        },
        comment: 'Average driver rating (0.00 - 5.00)'
    },
    rating_count: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
        comment: 'Total number of ratings received'
    },

    // ═══════════════════════════════════════════════════════════════════
    // VEHICLE INFORMATION (CRITICAL FOR PASSENGER IDENTIFICATION)
    // ═══════════════════════════════════════════════════════════════════
    vehicle_type: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: 'Vehicle category (Economy, Comfort, Luxury)',
        validate: {
            isIn: [['Economy', 'Comfort', 'Luxury', 'Standard']]
        }
    },
    vehicle_make_model: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: 'Vehicle make and model (e.g., "Toyota Corolla", "Honda Civic")'
    },
    vehicle_color: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: 'Vehicle color (e.g., "Black", "White", "Silver", "Blue")'
    },
    vehicle_year: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: 'Vehicle manufacturing year (e.g., 2020)',
        validate: {
            min: 1990,
            max: new Date().getFullYear() + 1
        }
    },
    vehicle_plate: {
        type: DataTypes.STRING(32),
        allowNull: true,
        unique: true,
        comment: 'Vehicle license plate number'
    },

    // ✅ UPDATED: Vehicle photo URL (this was already here but keeping it for clarity)
    vehicle_photo_url: {
        type: DataTypes.STRING(255),
        allowNull: true,
        comment: 'URL to vehicle photo'
    },

    // ═══════════════════════════════════════════════════════════════════
    // STATUS & LOCATION
    // ═══════════════════════════════════════════════════════════════════
    status: {
        type: DataTypes.ENUM('offline', 'online', 'on_trip', 'suspended'),
        defaultValue: 'offline',
        comment: 'Current driver status'
    },
    current_lat: {
        type: DataTypes.DECIMAL(10, 7),
        allowNull: true,
        comment: 'Current latitude position'
    },
    current_lng: {
        type: DataTypes.DECIMAL(10, 7),
        allowNull: true,
        comment: 'Current longitude position'
    },
}, {
    tableName: 'driver_profiles',
    timestamps: true,
    underscored: true,
    indexes: [
        {
            name: 'idx_driver_status',
            fields: ['status']
        },
        {
            name: 'idx_driver_verification',
            fields: ['verification_state']
        },
        {
            name: 'idx_driver_rating',
            fields: ['rating_avg']
        },
        {
            name: 'idx_vehicle_plate',
            unique: true,
            fields: ['vehicle_plate']
        }
    ]
});

module.exports = DriverProfile;