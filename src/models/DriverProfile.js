const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const DriverProfile = sequelize.define('DriverProfile', {
    account_id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    cni_number: { type: DataTypes.STRING(64), allowNull: false },
    license_number: { type: DataTypes.STRING(64), allowNull: false },
    license_expiry: { type: DataTypes.DATEONLY, allowNull: false },
    insurance_number: { type: DataTypes.STRING(64), allowNull: true },
    insurance_expiry: { type: DataTypes.DATEONLY, allowNull: true },
    rating_avg: { type: DataTypes.DECIMAL(3,2), allowNull: false, defaultValue: 0.00 },
    rating_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    vehicle_type: { type: DataTypes.STRING(50), allowNull: true },
    vehicle_plate: { type: DataTypes.STRING(32), allowNull: true },
    avatar_url: { type: DataTypes.STRING(255), allowNull: true },
    status: { type: DataTypes.ENUM('offline','online','on_trip','suspended'), defaultValue: 'offline' },
    current_lat: { type: DataTypes.DECIMAL(10,7), allowNull: true },
    current_lng: { type: DataTypes.DECIMAL(10,7), allowNull: true },
    verification_state: { type: DataTypes.ENUM('UNVERIFIED','PENDING','VERIFIED','REJECTED'), allowNull: false, defaultValue: 'PENDING' },
}, {
    tableName: 'driver_profiles',
});

module.exports = DriverProfile;
