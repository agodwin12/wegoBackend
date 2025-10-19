// src/models/VehicleRental.js
const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class VehicleRental extends Model {}

VehicleRental.init(
    {
        id: {
            type: DataTypes.STRING(36), // UUID string
            primaryKey: true,
        },

        // Passenger renting the vehicle
        userId: {
            type: DataTypes.CHAR(36), // matches Account.uuid
            allowNull: false,
            references: { model: 'accounts', key: 'uuid' },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
        },

        // Vehicle being rented
        vehicleId: {
            type: DataTypes.STRING(36), // matches Vehicle.id
            allowNull: false,
            references: { model: 'vehicles', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
        },

        rentalType: {
            type: DataTypes.ENUM('HOUR', 'DAY', 'WEEK', 'MONTH'),
            allowNull: false,
        },

        startDate: { type: DataTypes.DATE, allowNull: false },
        endDate: { type: DataTypes.DATE, allowNull: false },

        status: {
            type: DataTypes.ENUM('PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED'),
            defaultValue: 'PENDING',
        },

        totalPrice: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: false,
            defaultValue: 0.0,
        },

        paymentStatus: {
            type: DataTypes.ENUM('unpaid', 'paid', 'refunded'),
            defaultValue: 'unpaid',
        },

        // Admin approver
        approvedByAdminId: {
            type: DataTypes.CHAR(36), // matches Account.uuid
            allowNull: true,
            references: { model: 'accounts', key: 'uuid' },
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL',
        },
    },
    {
        sequelize,
        modelName: 'VehicleRental',
        tableName: 'vehicle_rentals',
        timestamps: true,
        underscored: true,
    }
);

module.exports = VehicleRental;
