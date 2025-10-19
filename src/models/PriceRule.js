const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class PriceRule extends Model {}
PriceRule.init({
    id: { type: DataTypes.STRING(36), primaryKey: true },
    city: { type: DataTypes.STRING(64), allowNull: false },
    base: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 3000 }, // initial fare
    per_km: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    per_min: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    min_fare: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 3000 },
    surge_mult: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 1.0 },
}, { sequelize, modelName: 'PriceRule', tableName: 'price_rules',
    indexes: [{ fields: ['city','createdAt'] }]
});

module.exports = PriceRule;
