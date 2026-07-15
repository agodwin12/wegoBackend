'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// RIDE SURGE RULE
// ═══════════════════════════════════════════════════════════════════════════════
// Scheduled surge windows for ride-hailing — the twin of DeliverySurgeRule, but
// scoped by CITY + optional VEHICLE_TYPE (rides are city-level, no pricing zones).
//
//   • city         NULL  → applies to every city (global)
//   • vehicle_type NULL  → applies to every vehicle type in that city
//
// getActiveSurge(city, vehicleType) returns the highest-priority rule firing
// right now, or {rule:null, multiplier:1.00} when nothing matches. It never
// throws — a surge lookup must never block a fare quote.
// ═══════════════════════════════════════════════════════════════════════════════

const { Model, DataTypes, Op } = require('sequelize');

const _log = (...args) => {
    if (process.env.NODE_ENV !== 'production') console.log(...args);
};

module.exports = (sequelize) => {
    class RideSurgeRule extends Model {
        static associate(models) {
            RideSurgeRule.belongsTo(models.Employee, {
                foreignKey: 'created_by',
                as: 'createdBy',
            });
        }

        // ─── STATIC METHODS ────────────────────────────────────────────────────────

        /**
         * Find the currently-firing ride surge rule for a city + vehicle type.
         * @param {string|null} city
         * @param {string|null} vehicleType  'economy' | 'comfort' | 'luxury'
         * @returns {{ rule: RideSurgeRule|null, multiplier: number }}
         */
        static async getActiveSurge(city = null, vehicleType = null) {
            try {
                const now         = new Date();
                const currentDay  = now.getDay(); // 0 = Sun … 6 = Sat
                const hours       = String(now.getHours()).padStart(2, '0');
                const minutes     = String(now.getMinutes()).padStart(2, '0');
                const currentTime = `${hours}:${minutes}`;

                const rules = await RideSurgeRule.findAll({
                    where: {
                        is_active: true,
                        // A rule matches the requested city, or is global (city NULL).
                        [Op.or]: [
                            { city: null },
                            ...(city ? [{ city }] : []),
                        ],
                    },
                    order: [['priority', 'DESC']],
                });

                if (!rules.length) return { rule: null, multiplier: 1.00 };

                const matching = rules.filter((rule) => {
                    // vehicle_type NULL = applies to all types; else must match.
                    if (vehicleType && rule.vehicle_type && rule.vehicle_type !== vehicleType) {
                        return false;
                    }

                    const days = Array.isArray(rule.days_of_week)
                        ? rule.days_of_week
                        : JSON.parse(rule.days_of_week || '[]');
                    if (!days.includes(currentDay)) return false;

                    // Handle overnight windows e.g. 22:00 → 02:00
                    if (rule.start_time <= rule.end_time) {
                        return currentTime >= rule.start_time && currentTime <= rule.end_time;
                    }
                    return currentTime >= rule.start_time || currentTime <= rule.end_time;
                });

                if (!matching.length) return { rule: null, multiplier: 1.00 };

                const winning = matching[0]; // already priority DESC
                _log(`⚡ [RIDE SURGE] Active: "${winning.name}" → ${parseFloat(winning.multiplier)}x (city=${city}, veh=${vehicleType})`);
                return { rule: winning, multiplier: parseFloat(winning.multiplier) };

            } catch (error) {
                // Never block a quote because of a surge error (e.g. table missing).
                console.error('❌ [RIDE SURGE] getActiveSurge error:', error.message);
                return { rule: null, multiplier: 1.00 };
            }
        }

        /**
         * All rules grouped by day of week for the backoffice weekly calendar.
         */
        static async getWeeklyCalendar() {
            const rules = await RideSurgeRule.findAll({
                order: [['priority', 'DESC'], ['start_time', 'ASC']],
            });

            const calendar = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
            const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

            rules.forEach((rule) => {
                const days = Array.isArray(rule.days_of_week)
                    ? rule.days_of_week
                    : JSON.parse(rule.days_of_week || '[]');

                days.forEach((day) => {
                    if (calendar[day] !== undefined) {
                        calendar[day].push({
                            id:           rule.id,
                            name:         rule.name,
                            startTime:    rule.start_time,
                            endTime:      rule.end_time,
                            multiplier:   parseFloat(rule.multiplier),
                            priority:     rule.priority,
                            isActive:     rule.is_active,
                            city:         rule.city,
                            vehicleType:  rule.vehicle_type,
                            isGlobal:     rule.city === null,
                        });
                    }
                });
            });

            return {
                calendar,
                dayNames,
                totalRules:  rules.length,
                activeRules: rules.filter((r) => r.is_active).length,
            };
        }

        // ─── INSTANCE METHODS ──────────────────────────────────────────────────────

        isCurrentlyActive() {
            if (!this.is_active) return false;

            const now         = new Date();
            const currentDay  = now.getDay();
            const hours       = String(now.getHours()).padStart(2, '0');
            const minutes     = String(now.getMinutes()).padStart(2, '0');
            const currentTime = `${hours}:${minutes}`;

            const days = Array.isArray(this.days_of_week)
                ? this.days_of_week
                : JSON.parse(this.days_of_week || '[]');
            if (!days.includes(currentDay)) return false;

            if (this.start_time <= this.end_time) {
                return currentTime >= this.start_time && currentTime <= this.end_time;
            }
            return currentTime >= this.start_time || currentTime <= this.end_time;
        }

        getDaysLabel() {
            const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            const days = Array.isArray(this.days_of_week)
                ? this.days_of_week
                : JSON.parse(this.days_of_week || '[]');
            return days.sort((a, b) => a - b).map((d) => dayNames[d]).join(', ');
        }
    }

    RideSurgeRule.init(
        {
            id: {
                type:          DataTypes.INTEGER,
                autoIncrement: true,
                primaryKey:    true,
            },
            name: {
                type:      DataTypes.STRING(100),
                allowNull: false,
                validate: {
                    notEmpty: { msg: 'Surge rule name is required' },
                    len:      { args: [2, 100], msg: 'Name must be between 2 and 100 characters' },
                },
            },
            description: {
                type:      DataTypes.STRING(255),
                allowNull: true,
            },
            days_of_week: {
                type:      DataTypes.JSON,
                allowNull: false,
                validate: {
                    isValidDays(value) {
                        const days = Array.isArray(value) ? value : JSON.parse(value || '[]');
                        if (!days.length) throw new Error('At least one day must be selected');
                        if (days.some((d) => d < 0 || d > 6)) {
                            throw new Error('Days must be between 0 (Sunday) and 6 (Saturday)');
                        }
                    },
                },
            },
            start_time: {
                type:      DataTypes.STRING(5),
                allowNull: false,
                validate: {
                    is: { args: /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/, msg: 'Start time must be in HH:MM format' },
                },
            },
            end_time: {
                type:      DataTypes.STRING(5),
                allowNull: false,
                validate: {
                    is: { args: /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/, msg: 'End time must be in HH:MM format' },
                },
            },
            multiplier: {
                type:         DataTypes.DECIMAL(4, 2),
                allowNull:    false,
                defaultValue: 1.30,
                validate: {
                    min: { args: [1.00], msg: 'Multiplier cannot be less than 1.00' },
                    max: { args: [3.00], msg: 'Multiplier cannot exceed 3.00' },
                },
            },
            // NULL = applies to every city (global).
            city: {
                type:      DataTypes.STRING(100),
                allowNull: true,
            },
            // NULL = applies to every vehicle type in the city.
            vehicle_type: {
                type:      DataTypes.ENUM('economy', 'comfort', 'luxury'),
                allowNull: true,
            },
            priority: {
                type:         DataTypes.INTEGER,
                allowNull:    false,
                defaultValue: 1,
                validate: {
                    min: { args: [1],   msg: 'Priority must be at least 1' },
                    max: { args: [100], msg: 'Priority cannot exceed 100' },
                },
            },
            is_active: {
                type:         DataTypes.BOOLEAN,
                allowNull:    false,
                defaultValue: true,
            },
            created_by: {
                type:      DataTypes.INTEGER,
                allowNull: true,
            },
        },
        {
            sequelize,
            modelName:   'RideSurgeRule',
            tableName:   'ride_surge_rules',
            underscored: true,
            timestamps:  true,
        }
    );

    return RideSurgeRule;
};
