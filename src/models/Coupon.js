'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const { v4: uuidv4 } = require('uuid');

const Coupon = sequelize.define(
    'Coupon',
    {
        id: {
            type: DataTypes.STRING(36),
            primaryKey: true,
            defaultValue: () => uuidv4()
        },
        code: {
            type: DataTypes.STRING(20),
            allowNull: false,
            unique: true,
            validate: {
                notEmpty: true,
                isUppercase: true,
                len: [3, 20]
            },
            set(value) {
                // Always store codes in uppercase
                this.setDataValue('code', value.toUpperCase());
            }
        },
        description: {
            type: DataTypes.STRING(255),
            allowNull: true
        },
        discount_type: {
            type: DataTypes.ENUM('percentage', 'fixed'),
            allowNull: false,
            defaultValue: 'percentage',
            validate: {
                isIn: [['percentage', 'fixed']]
            }
        },
        discount_value: {
            type: DataTypes.INTEGER,
            allowNull: false,
            validate: {
                min: 1,
                isInt: true,
                customValidation(value) {
                    if (this.discount_type === 'percentage' && (value < 1 || value > 100)) {
                        throw new Error('Percentage discount must be between 1 and 100');
                    }
                    if (this.discount_type === 'fixed' && value < 100) {
                        throw new Error('Fixed discount must be at least 100 FCFA');
                    }
                }
            }
        },
        max_discount_amount: {
            type: DataTypes.INTEGER,
            allowNull: true,
            validate: {
                min: 100,
                isInt: true
            }
        },
        min_trip_amount: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0,
            validate: {
                min: 0,
                isInt: true
            }
        },
        usage_limit_total: {
            type: DataTypes.INTEGER,
            allowNull: true,
            validate: {
                min: 1,
                isInt: true
            }
        },
        usage_limit_per_user: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 1,
            validate: {
                min: 1,
                isInt: true
            }
        },
        used_count: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0,
            validate: {
                min: 0,
                isInt: true
            }
        },
        valid_from: {
            type: DataTypes.DATE,
            allowNull: false,
            validate: {
                isDate: true
            }
        },
        valid_until: {
            type: DataTypes.DATE,
            allowNull: false,
            validate: {
                isDate: true,
                isAfterValidFrom(value) {
                    if (value <= this.valid_from) {
                        throw new Error('valid_until must be after valid_from');
                    }
                }
            }
        },
        applicable_to: {
            type: DataTypes.ENUM('all', 'new_users', 'specific_users'),
            allowNull: false,
            defaultValue: 'all',
            validate: {
                isIn: [['all', 'new_users', 'specific_users']]
            }
        },
        is_active: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: true
        },
        created_by: {
            type: DataTypes.INTEGER,
            allowNull: false,
            comment: 'Employee ID who created this coupon'
        }
    },
    {
        sequelize,
        modelName: 'Coupon',
        tableName: 'coupons',
        timestamps: true
    }
);

/* ================================
   INSTANCE METHODS
================================= */

/**
 * Check if coupon is valid
 * @returns {boolean}
 */
Coupon.prototype.isValid = function() {
    const now = new Date();
    return (
        this.is_active &&
        now >= this.valid_from &&
        now <= this.valid_until &&
        (this.usage_limit_total === null || this.used_count < this.usage_limit_total)
    );
};

/**
 * Check if user can use this coupon
 * @param {string} userId - User UUID
 * @param {object} models - Sequelize models object
 * @returns {Promise<boolean>}
 */
Coupon.prototype.canBeUsedByUser = async function(userId, models) {
    if (!this.isValid()) return false;

    // Check per-user usage limit
    if (models.CouponUsage) {
        const userUsageCount = await models.CouponUsage.count({
            where: {
                coupon_id: this.id,
                user_id: userId
            }
        });

        if (userUsageCount >= this.usage_limit_per_user) {
            return false;
        }
    }

    // Check if coupon is for new users only
    if (this.applicable_to === 'new_users' && models.Trip) {
        const tripCount = await models.Trip.count({
            where: {
                passenger_id: userId,
                status: 'completed'
            }
        });

        if (tripCount > 0) {
            return false;
        }
    }

    return true;
};

/**
 * Calculate discount for a given trip amount
 * @param {number} tripAmount - Trip amount in FCFA
 * @returns {number} Discount amount
 */
Coupon.prototype.calculateDiscount = function(tripAmount) {
    if (tripAmount < this.min_trip_amount) {
        return 0;
    }

    let discount = 0;

    if (this.discount_type === 'percentage') {
        discount = Math.floor((tripAmount * this.discount_value) / 100);

        // Apply max discount cap if set
        if (this.max_discount_amount && discount > this.max_discount_amount) {
            discount = this.max_discount_amount;
        }
    } else if (this.discount_type === 'fixed') {
        discount = this.discount_value;
    }

    // Ensure discount doesn't exceed trip amount
    return Math.min(discount, tripAmount);
};

/**
 * Increment used count
 * @returns {Promise<void>}
 */
Coupon.prototype.incrementUsage = async function() {
    this.used_count += 1;
    await this.save();
};

/**
 * Get safe object representation
 * @returns {object}
 */
Coupon.prototype.toSafeObject = function() {
    const data = this.toJSON();
    return {
        ...data,
        is_valid: this.isValid(),
        usage_percentage: this.usage_limit_total
            ? Math.round((this.used_count / this.usage_limit_total) * 100)
            : null
    };
};

/* ================================
   CLASS METHODS
================================= */

/**
 * Find active coupons
 * @returns {Promise<Coupon[]>}
 */
Coupon.findActive = async function() {
    const now = new Date();
    return await this.findAll({
        where: {
            is_active: true,
            valid_from: { [sequelize.Sequelize.Op.lte]: now },
            valid_until: { [sequelize.Sequelize.Op.gte]: now }
        }
    });
};

/**
 * Find coupon by code
 * @param {string} code - Coupon code
 * @returns {Promise<Coupon|null>}
 */
Coupon.findByCode = async function(code) {
    return await this.findOne({
        where: {
            code: code.toUpperCase()
        }
    });
};

/**
 * Generate unique coupon code
 * @param {number} length - Code length (default 8)
 * @returns {Promise<string>}
 */
Coupon.generateUniqueCode = async function(length = 8) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

    let isUnique = false;
    let code = '';
    let attempts = 0;

    while (!isUnique && attempts < 20) {
        code = 'WEGO-';
        for (let i = 0; i < length; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }

        const existing = await this.findByCode(code);
        if (!existing) {
            isUnique = true;
        }
        attempts++;
    }

    return code;
};

module.exports = Coupon;