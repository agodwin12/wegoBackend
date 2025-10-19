const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class VehicleCategory extends Model {}

VehicleCategory.init({
    id: {
        type: DataTypes.STRING(36), // uuid v4 string
        primaryKey: true,
    },
    name: {
        type: DataTypes.STRING(64),
        allowNull: false,
    },
    slug: {
        type: DataTypes.STRING(64),
        allowNull: false,
        unique: true,
    },
    description: {
        type: DataTypes.STRING(255),
        allowNull: true,
    },
    icon: {
        type: DataTypes.STRING(64), // optional (e.g., 'car-sports', 'car-suv', etc.)
        allowNull: true,
    },
    isActive: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
    },
    sortOrder: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
    },
}, {
    sequelize,
    modelName: 'VehicleCategory',
    tableName: 'vehicle_categories',
    timestamps: true,
});

module.exports = VehicleCategory;
