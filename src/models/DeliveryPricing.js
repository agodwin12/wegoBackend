'use strict';

const { Model, DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    class DeliveryPricing extends Model {
        static associate(models) {
            // A pricing zone has many surge rules
            DeliveryPricing.hasMany(models.DeliverySurgeRule, {
                foreignKey: 'delivery_pricing_id',
                as: 'surgeRules',
            });

            // A pricing zone has many deliveries
            DeliveryPricing.hasMany(models.Delivery, {
                foreignKey: 'pricing_zone_id',
                as: 'deliveries',
            });

            // Created by an employee
            DeliveryPricing.belongsTo(models.Employee, {
                foreignKey: 'created_by',
                as: 'createdBy',
            });
        }

        // ─── INSTANCE METHODS ──────────────────────────────────────────────────────

        /**
         * Calculate the price for a delivery
         * @param {number} distanceKm - Distance from Google Maps
         * @param {string} packageSize - 'small' | 'medium' | 'large'
         * @param {number} surgeMultiplier - From active surge rule (default 1.00)
         * @returns {object} Full price breakdown
         */
        calculatePrice(distanceKm, packageSize, surgeMultiplier = 1.00) {
            const baseFee = parseFloat(this.base_fee);
            const perKmRate = parseFloat(this.per_km_rate);
            const commissionPct = parseFloat(this.commission_percentage);
            const minimumPrice = parseFloat(this.minimum_price);

            // Get size multiplier
            const sizeMultipliers = {
                small: parseFloat(this.size_multiplier_small),
                medium: parseFloat(this.size_multiplier_medium),
                large: parseFloat(this.size_multiplier_large),
            };
            const sizeMultiplier = sizeMultipliers[packageSize] || 1.00;

            // Core formula:
            // subtotal = base_fee + (distance * per_km_rate)
            // total = subtotal * size_multiplier * surge_multiplier
            const subtotal = baseFee + (distanceKm * perKmRate);
            let total = subtotal * sizeMultiplier * surgeMultiplier;

            // Apply minimum price floor
            total = Math.max(total, minimumPrice);

            // Round to nearest 50 XAF (cleaner UX for Cameroonian market)
            total = Math.ceil(total / 50) * 50;

            const commissionAmount = parseFloat((total * commissionPct / 100).toFixed(2));
            const driverPayout = parseFloat((total - commissionAmount).toFixed(2));

            return {
                distanceKm: parseFloat(distanceKm.toFixed(3)),
                baseFeeApplied: baseFee,
                perKmRateApplied: perKmRate,
                sizeMultiplierApplied: sizeMultiplier,
                surgeMultiplierApplied: surgeMultiplier,
                subtotal: parseFloat(subtotal.toFixed(2)),
                totalPrice: total,
                commissionPercentageApplied: commissionPct,
                commissionAmount,
                driverPayout,
                isSurging: surgeMultiplier > 1.00,
                isMinimuApplied: (subtotal * sizeMultiplier * surgeMultiplier) < minimumPrice,
            };
        }
    }

    DeliveryPricing.init(
        {
            id: {
                type: DataTypes.INTEGER,
                autoIncrement: true,
                primaryKey: true,
            },
            zone_name: {
                type: DataTypes.STRING(100),
                allowNull: false,
                validate: {
                    notEmpty: { msg: 'Zone name is required' },
                    len: { args: [2, 100], msg: 'Zone name must be between 2 and 100 characters' },
                },
            },
            zone_description: {
                type: DataTypes.STRING(255),
                allowNull: true,
            },
            base_fee: {
                type: DataTypes.DECIMAL(10, 2),
                allowNull: false,
                defaultValue: 500.00,
                validate: {
                    min: { args: [0], msg: 'Base fee cannot be negative' },
                    max: { args: [50000], msg: 'Base fee cannot exceed 50,000 XAF' },
                },
            },
            per_km_rate: {
                type: DataTypes.DECIMAL(10, 2),
                allowNull: false,
                defaultValue: 150.00,
                validate: {
                    min: { args: [0], msg: 'Per km rate cannot be negative' },
                    max: { args: [10000], msg: 'Per km rate cannot exceed 10,000 XAF' },
                },
            },
            size_multiplier_small: {
                type: DataTypes.DECIMAL(4, 2),
                allowNull: false,
                defaultValue: 1.00,
                validate: {
                    min: { args: [1.00], msg: 'Small multiplier cannot be less than 1.00' },
                    max: { args: [5.00], msg: 'Small multiplier cannot exceed 5.00' },
                },
            },
            size_multiplier_medium: {
                type: DataTypes.DECIMAL(4, 2),
                allowNull: false,
                defaultValue: 1.30,
                validate: {
                    min: { args: [1.00], msg: 'Medium multiplier cannot be less than 1.00' },
                    max: { args: [5.00], msg: 'Medium multiplier cannot exceed 5.00' },
                },
            },
            size_multiplier_large: {
                type: DataTypes.DECIMAL(4, 2),
                allowNull: false,
                defaultValue: 1.70,
                validate: {
                    min: { args: [1.00], msg: 'Large multiplier cannot be less than 1.00' },
                    max: { args: [5.00], msg: 'Large multiplier cannot exceed 5.00' },
                },
            },
            commission_percentage: {
                type: DataTypes.DECIMAL(5, 2),
                allowNull: false,
                defaultValue: 20.00,
                validate: {
                    min: { args: [0], msg: 'Commission cannot be negative' },
                    max: { args: [50], msg: 'Commission cannot exceed 50%' },
                },
            },
            minimum_price: {
                type: DataTypes.DECIMAL(10, 2),
                allowNull: false,
                defaultValue: 1000.00,
                validate: {
                    min: { args: [0], msg: 'Minimum price cannot be negative' },
                },
            },
            max_distance_km: {
                type: DataTypes.DECIMAL(6, 2),
                allowNull: false,
                defaultValue: 50.00,
                validate: {
                    min: { args: [1], msg: 'Max distance must be at least 1 km' },
                    max: { args: [500], msg: 'Max distance cannot exceed 500 km' },
                },
            },
            is_active: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: true,
            },
            created_by: {
                type: DataTypes.INTEGER,
                allowNull: true,
            },
        },
        {
            sequelize,
            modelName: 'DeliveryPricing',
            tableName: 'delivery_pricing',
            underscored: true,
            timestamps: true,
        }
    );

    return DeliveryPricing;
};