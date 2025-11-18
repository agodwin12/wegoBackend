// src/models/Trip.js
const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class Trip extends Model {}

Trip.init({
    id: {
        type: DataTypes.CHAR(36),
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4
    },

    passengerId: {
        type: DataTypes.CHAR(36),  // ✅ Changed from STRING to CHAR for consistency
        allowNull: false,
        field: 'passengerId',
        references: {
            model: 'accounts',
            key: 'uuid'
        }
    },

    driverId: {
        type: DataTypes.CHAR(36),  // ✅ Changed from STRING to CHAR for consistency
        allowNull: true,
        field: 'driverId',
        references: {
            model: 'accounts',
            key: 'uuid'
        }
    },

    status: {
        type: DataTypes.ENUM(
            'DRAFT',
            'SEARCHING',
            'MATCHED',
            'DRIVER_ASSIGNED',
            'DRIVER_EN_ROUTE',
            'DRIVER_ARRIVED',
            'IN_PROGRESS',
            'COMPLETED',
            'CANCELED',
            'NO_DRIVERS'
        ),
        allowNull: false,
        defaultValue: 'SEARCHING',
        field: 'status'
    },

    pickupLat: {
        type: DataTypes.DECIMAL(10, 7),
        allowNull: false,
        field: 'pickupLat'
    },

    pickupLng: {
        type: DataTypes.DECIMAL(10, 7),
        allowNull: false,
        field: 'pickupLng'
    },

    pickupAddress: {
        type: DataTypes.STRING(255),
        field: 'pickupAddress'
    },

    dropoffLat: {
        type: DataTypes.DECIMAL(10, 7),
        allowNull: false,
        field: 'dropoffLat'
    },

    dropoffLng: {
        type: DataTypes.DECIMAL(10, 7),
        allowNull: false,
        field: 'dropoffLng'
    },

    dropoffAddress: {
        type: DataTypes.STRING(255),
        field: 'dropoffAddress'
    },

    routePolyline: {
        type: DataTypes.TEXT,
        field: 'routePolyline'
    },

    distanceM: {
        type: DataTypes.INTEGER,
        field: 'distanceM'
    },

    durationS: {
        type: DataTypes.INTEGER,
        field: 'durationS'
    },

    fareEstimate: {
        type: DataTypes.INTEGER,
        field: 'fareEstimate'
    },

    fareFinal: {
        type: DataTypes.INTEGER,
        field: 'fareFinal'
    },

    paymentMethod: {
        type: DataTypes.ENUM('CASH', 'MOMO', 'OM'),
        allowNull: false,
        defaultValue: 'CASH',
        field: 'paymentMethod'
    },

    cancelReason: {
        type: DataTypes.STRING(120),
        field: 'cancelReason'
    },

    canceledBy: {
        type: DataTypes.ENUM('PASSENGER', 'DRIVER', 'SYSTEM'),
        allowNull: true,
        field: 'canceledBy'
    },

    driverAssignedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'driverAssignedAt'
    },

    driverEnRouteAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'driverEnRouteAt'
    },

    driverArrivedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'driverArrivedAt'
    },

    tripStartedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'tripStartedAt'
    },

    tripCompletedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'tripCompletedAt'
    },

    // ✅ ADD MISSING FIELD
    matchedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'matchedAt'
    },

    canceledAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'canceledAt'
    },

    // ✅ ADD MISSING FIELDS FOR DRIVER LOCATION
    driverLocationLat: {
        type: DataTypes.DECIMAL(10, 7),
        allowNull: true,
        field: 'driverLocationLat'
    },

    driverLocationLng: {
        type: DataTypes.DECIMAL(10, 7),
        allowNull: true,
        field: 'driverLocationLng'
    },

    createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'createdAt'
    },

    updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'updatedAt'
    }
}, {
    sequelize,
    modelName: 'Trip',
    tableName: 'trips',
    underscored: false,
    timestamps: true,
    indexes: [
        { fields: ['passengerId', 'createdAt'] },
        { fields: ['driverId', 'status'] },
        { fields: ['status'] },
        { fields: ['tripCompletedAt'] }
    ]
});

module.exports = Trip;