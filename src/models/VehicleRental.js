// wegobackend/src/models/VehicleRental.js

const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class VehicleRental extends Model {}

VehicleRental.init(
    {
        id: {
            type: DataTypes.STRING(36),
            primaryKey: true,
        },

        userId: {
            type: DataTypes.CHAR(36),
            allowNull: false,
            references: { model: 'accounts', key: 'uuid' },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
        },

        vehicleId: {
            type: DataTypes.STRING(36),
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

        // ✅ NEW: Payment Method
        paymentMethod: {
            type: DataTypes.ENUM('orange_money', 'mtn_momo', 'card', 'cash', 'bank_transfer'),
            allowNull: true,
        },

        // ✅ NEW: Transaction Reference
        transactionRef: {
            type: DataTypes.STRING(100),
            allowNull: true,
        },

        // ✅ NEW: Admin Notes
        adminNotes: {
            type: DataTypes.TEXT,
            allowNull: true,
        },

        // ✅ NEW: Rejection/Cancellation Reason
        cancellationReason: {
            type: DataTypes.TEXT,
            allowNull: true,
        },

        approvedByAdminId: {
            type: DataTypes.CHAR(36),
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