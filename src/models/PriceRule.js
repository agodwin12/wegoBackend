// models/PriceRule.js

'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PriceRule = sequelize.define(
    'PriceRule',
    {
        id: {
            type: DataTypes.UUID,
            defaultValue: DataTypes.UUIDV4,
            primaryKey: true,
        },
        city: {
            type: DataTypes.STRING(100),
            allowNull: false,
            validate: {
                notEmpty: true,
            },
        },
        vehicle_type: {
            type: DataTypes.ENUM('economy', 'comfort', 'luxury'),
            allowNull: false,
            defaultValue: 'economy',
            comment: 'Vehicle category this pricing applies to',
        },
        base: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: false,
            comment: 'Base fare amount in XAF',
            validate: { min: 0 },
        },
        per_km: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: false,
            comment: 'Cost per kilometer in XAF',
            validate: { min: 0 },
        },
        per_min: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: false,
            comment: 'Cost per minute in XAF',
            validate: { min: 0 },
        },
        min_fare: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: false,
            comment: 'Minimum fare amount in XAF',
            validate: { min: 0 },
        },
        surge_mult: {
            type: DataTypes.DECIMAL(4, 2),
            allowNull: false,
            defaultValue: 1.0,
            comment: 'Surge pricing multiplier (>= 1.0)',
            validate: { min: 1.0 },
        },
        status: {
            type: DataTypes.ENUM('active', 'inactive'),
            allowNull: false,
            defaultValue: 'active',
        },
        created_by: {
            type: DataTypes.INTEGER,
            allowNull: true,
            comment: 'Employee ID who created this rule',
        },
        updated_by: {
            type: DataTypes.INTEGER,
            allowNull: true,
            comment: 'Employee ID who last updated this rule',
        },
    },
    {
        tableName: 'price_rules',
        timestamps: true,
        underscored: false,
        indexes: [
            // One row per city + vehicle_type combination
            {
                unique: true,
                fields: ['city', 'vehicle_type'],
                name: 'price_rules_city_vehicle_type_unique',
            },
            {
                unique: false,
                fields: ['vehicle_type'],
                name: 'price_rules_vehicle_type_idx',
            },
            {
                unique: false,
                fields: ['status'],
            },
            {
                unique: false,
                fields: ['city', 'status'],
            },
        ],
    }
);

// ═══════════════════════════════════════════════════════════════
// INSTANCE METHODS
// ═══════════════════════════════════════════════════════════════

/**
 * Calculate full fare breakdown for a trip
 * @param {number} distance_km
 * @param {number} duration_min
 * @returns {object}
 */
PriceRule.prototype.getFareBreakdown = function (distance_km, duration_min) {
    const base         = parseFloat(this.base);
    const distanceFare = parseFloat(distance_km)  * parseFloat(this.per_km);
    const timeFare     = parseFloat(duration_min) * parseFloat(this.per_min);
    const subtotal     = base + distanceFare + timeFare;
    const beforeSurge  = Math.max(subtotal, parseFloat(this.min_fare));
    const total        = Math.round(beforeSurge * parseFloat(this.surge_mult));

    return {
        vehicle_type:     this.vehicle_type,
        base_fare:        parseFloat(base.toFixed(2)),
        distance_fare:    parseFloat(distanceFare.toFixed(2)),
        time_fare:        parseFloat(timeFare.toFixed(2)),
        subtotal:         parseFloat(subtotal.toFixed(2)),
        min_fare:         parseFloat(this.min_fare),
        surge_multiplier: parseFloat(this.surge_mult),
        fare_estimate:    total,
        breakdown: {
            distance_km:  parseFloat(distance_km),
            duration_min: parseFloat(duration_min),
        },
    };
};

/**
 * Simple fare calculation (backward compatibility)
 * @param {number} distance_km
 * @param {number} duration_min
 * @returns {number}
 */
PriceRule.prototype.calculateFare = function (distance_km, duration_min) {
    return this.getFareBreakdown(distance_km, duration_min).fare_estimate;
};

/**
 * Safe object for API responses
 */
PriceRule.prototype.toSafeObject = function () {
    return {
        id:           this.id,
        city:         this.city,
        vehicle_type: this.vehicle_type,
        base:         parseFloat(this.base),
        per_km:       parseFloat(this.per_km),
        per_min:      parseFloat(this.per_min),
        min_fare:     parseFloat(this.min_fare),
        surge_mult:   parseFloat(this.surge_mult),
        status:       this.status,
        createdAt:    this.createdAt,
        updatedAt:    this.updatedAt,
    };
};

// ═══════════════════════════════════════════════════════════════
// CLASS METHODS
// ═══════════════════════════════════════════════════════════════

/**
 * Find active price rule for a specific city + vehicle type
 * @param {string} city
 * @param {string} vehicleType  'economy' | 'comfort' | 'luxury'
 * @returns {Promise<PriceRule|null>}
 */
PriceRule.findActiveByCity = async function (city, vehicleType = 'economy') {
    return await this.findOne({
        where: {
            city,
            vehicle_type: vehicleType,
            status: 'active',
        },
    });
};

/**
 * Find all active rules for a city (all 3 vehicle types)
 * @param {string} city
 * @returns {Promise<PriceRule[]>}
 */
PriceRule.findAllActiveByCity = async function (city) {
    return await this.findAll({
        where: {
            city,
            status: 'active',
        },
        order: [['vehicle_type', 'ASC']],
    });
};

/**
 * Get all active cities that have pricing configured
 * @returns {Promise<string[]>}
 */
PriceRule.getActiveCities = async function () {
    const rules = await this.findAll({
        where: { status: 'active' },
        attributes: ['city'],
        group: ['city'],
        order: [['city', 'ASC']],
    });
    return rules.map((r) => r.city);
};

/**
 * Check if a city has all 3 vehicle types configured
 * @param {string} city
 * @returns {Promise<boolean>}
 */
PriceRule.isCityFullyConfigured = async function (city) {
    const count = await this.count({
        where: {
            city,
            status: 'active',
        },
    });
    return count >= 3;
};

/**
 * Deactivate all active rules for a city (optionally filter by vehicle type)
 * @param {string} city
 * @param {number} employeeId
 * @param {string|null} vehicleType  pass null to deactivate all types
 * @returns {Promise<number>} rows affected
 */
PriceRule.deactivateAllForCity = async function (
    city,
    employeeId,
    vehicleType = null
) {
    const where = { city, status: 'active' };
    if (vehicleType) where.vehicle_type = vehicleType;

    const [affectedCount] = await this.update(
        { status: 'inactive', updated_by: employeeId },
        { where }
    );
    return affectedCount;
};

module.exports = PriceRule;