// backend/models/EarningRule.js
'use strict';

const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class EarningRule extends Model {

    isDateValid() {
        const now = new Date();
        if (this.validFrom && now < new Date(this.validFrom)) return false;
        if (this.validTo   && now > new Date(this.validTo))   return false;
        return true;
    }

    matchesContext(context) {
        const c = this.conditions;
        if (!c || Object.keys(c).length === 0) return true;

        if (c.city !== undefined && c.city !== context.city) return false;

        if (c.hour_from !== undefined && c.hour_to !== undefined) {
            const h    = context.tripHour;
            const from = c.hour_from;
            const to   = c.hour_to;
            const inWindow = from > to
                ? (h >= from || h < to)
                : (h >= from && h < to);
            if (!inWindow) return false;
        }

        if (c.day_of_week !== undefined) {
            const allowed = Array.isArray(c.day_of_week) ? c.day_of_week : [c.day_of_week];
            if (!allowed.includes(context.tripDayOfWeek)) return false;
        }

        if (c.min_fare        !== undefined && (context.fare       || 0) < c.min_fare)       return false;
        if (c.max_fare        !== undefined && (context.fare       || 0) > c.max_fare)       return false;
        if (c.min_distance_m  !== undefined && (context.distanceM  || 0) < c.min_distance_m) return false;
        if (c.payment_method  !== undefined && c.payment_method  !== context.paymentMethod)  return false;
        if (c.driver_tier     !== undefined && c.driver_tier     !== context.driverTier)     return false;
        if (c.pickup_zone     !== undefined && c.pickup_zone     !== context.pickupZone)     return false;

        return true;
    }
}

EarningRule.init(
    {
        id: {
            type:         DataTypes.CHAR(36),
            primaryKey:   true,
            defaultValue: DataTypes.UUIDV4,
        },
        name: {
            type:      DataTypes.STRING(150),
            allowNull: false,
        },
        description: {
            type:      DataTypes.TEXT,
            allowNull: true,
        },
        type: {
            type: DataTypes.ENUM(
                'COMMISSION_PERCENT',
                'BONUS_FLAT',
                'BONUS_MULTIPLIER',
                'PENALTY'
            ),
            allowNull: false,
        },
        value: {
            type:      DataTypes.DECIMAL(10, 4),
            allowNull: false,
        },
        conditions: {
            type:         DataTypes.JSON,
            allowNull:    false,
            defaultValue: {},
        },
        priority: {
            type:         DataTypes.INTEGER,
            allowNull:    false,
            defaultValue: 0,
        },
        appliesTo: {
            type:         DataTypes.ENUM('RIDE', 'RENTAL', 'ALL'),
            allowNull:    false,
            defaultValue: 'ALL',
        },
        validFrom: {
            type:      DataTypes.DATEONLY,
            allowNull: true,
        },
        validTo: {
            type:      DataTypes.DATEONLY,
            allowNull: true,
        },
        isActive: {
            type:         DataTypes.BOOLEAN,
            allowNull:    false,
            defaultValue: true,
        },

        // ─────────────────────────────────────────────────────────────
        // ⚠️  INTEGER — matches employees.id (auto-increment int PK)
        //     No `references` here — DB-level FK skipped intentionally.
        //     The JS association in index.js handles eager-loading.
        //     This prevents errno 150 when earning_rules is created
        //     before employees in the sync order.
        // ─────────────────────────────────────────────────────────────
        createdBy: {
            type:      DataTypes.INTEGER,
            allowNull: true,
        },
        updatedBy: {
            type:      DataTypes.INTEGER,
            allowNull: true,
        },

        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
    },
    {
        sequelize,
        modelName:   'EarningRule',
        tableName:   'earning_rules',
        underscored: false,
        timestamps:  true,
        indexes: [
            { fields: ['isActive', 'type'],     name: 'earning_rules_active_type'  },
            { fields: ['validFrom', 'validTo'], name: 'earning_rules_date_range'   },
            { fields: ['appliesTo'],            name: 'earning_rules_applies_to'   },
            { fields: ['priority'],             name: 'earning_rules_priority'     },
            { fields: ['createdBy'],            name: 'earning_rules_created_by'   },
        ],
    }
);

module.exports = EarningRule;