'use strict';

const { Model, DataTypes } = require('sequelize');
const { v4: uuidv4 } = require('uuid');

module.exports = (sequelize) => {
    class CouponUsage extends Model {
        static associate(models) {
            // Association with Coupon
            CouponUsage.belongsTo(models.Coupon, {
                foreignKey: 'coupon_id',
                as: 'coupon'
            });

            // Association with User (passenger)
            CouponUsage.belongsTo(models.User, {
                foreignKey: 'user_id',
                as: 'user'
            });

            // Association with Trip
            CouponUsage.belongsTo(models.Trip, {
                foreignKey: 'trip_id',
                as: 'trip'
            });
        }
    }

    CouponUsage.init(
        {
            id: {
                type: DataTypes.STRING(36),
                primaryKey: true,
                defaultValue: () => uuidv4()
            },
            coupon_id: {
                type: DataTypes.STRING(36),
                allowNull: false
            },
            user_id: {
                type: DataTypes.STRING(36),
                allowNull: false
            },
            trip_id: {
                type: DataTypes.STRING(36),
                allowNull: true
            },
            discount_applied: {
                type: DataTypes.INTEGER,
                allowNull: false,
                validate: {
                    min: 0,
                    isInt: true
                }
            },
            used_at: {
                type: DataTypes.DATE,
                allowNull: false,
                defaultValue: DataTypes.NOW
            }
        },
        {
            sequelize,
            modelName: 'CouponUsage',
            tableName: 'coupon_usage',
            timestamps: false // This table doesn't need createdAt/updatedAt since we have used_at
        }
    );

    return CouponUsage;
};