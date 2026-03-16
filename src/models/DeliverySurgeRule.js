'use strict';

const { Model, DataTypes, Op } = require('sequelize');

module.exports = (sequelize) => {
    class DeliverySurgeRule extends Model {
        static associate(models) {
            // A surge rule optionally belongs to a specific pricing zone
            // NULL = applies globally
            DeliverySurgeRule.belongsTo(models.DeliveryPricing, {
                foreignKey: 'delivery_pricing_id',
                as: 'pricingZone',
            });

            // Created by an employee
            DeliverySurgeRule.belongsTo(models.Employee, {
                foreignKey: 'created_by',
                as: 'createdBy',
            });
        }

        // ─── STATIC METHODS ────────────────────────────────────────────────────────

        /**
         * Find the currently active surge rule for a given pricing zone
         * Called at booking time to determine if surge applies right now
         *
         * Logic:
         * 1. Get current day of week and time
         * 2. Find all active rules that match today + current time window
         * 3. Filter by zone (zone-specific rules + global rules)
         * 4. Return the one with highest priority
         * 5. If no match → return null (no surge, multiplier = 1.00)
         *
         * @param {number|null} pricingZoneId - The zone ID, or null for global
         * @returns {object} { rule, multiplier } or { rule: null, multiplier: 1.00 }
         */
        static async getActiveSurge(pricingZoneId = null) {
            try {
                const now = new Date();

                // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
                const currentDay = now.getDay();

                // Format current time as "HH:MM" for comparison
                const hours = String(now.getHours()).padStart(2, '0');
                const minutes = String(now.getMinutes()).padStart(2, '0');
                const currentTime = `${hours}:${minutes}`;

                debugPrint(`🕐 [SURGE] Checking surge for zone=${pricingZoneId}, day=${currentDay}, time=${currentTime}`);

                // Fetch all active surge rules
                // We filter in JS rather than SQL because days_of_week is JSON
                const allActiveRules = await DeliverySurgeRule.findAll({
                    where: {
                        is_active: true,
                        // Only fetch rules for this zone OR global rules (NULL)
                        [Op.or]: [
                            { delivery_pricing_id: null },           // Global rules
                            ...(pricingZoneId ? [{ delivery_pricing_id: pricingZoneId }] : []),
                        ],
                    },
                    order: [['priority', 'DESC']], // Highest priority first
                });

                if (!allActiveRules.length) {
                    debugPrint('🕐 [SURGE] No active rules found → no surge');
                    return { rule: null, multiplier: 1.00 };
                }

                // Filter rules that match current day AND current time window
                const matchingRules = allActiveRules.filter((rule) => {
                    const daysOfWeek = Array.isArray(rule.days_of_week)
                        ? rule.days_of_week
                        : JSON.parse(rule.days_of_week || '[]');

                    const dayMatches = daysOfWeek.includes(currentDay);

                    // Handle overnight rules e.g. 22:00 → 02:00
                    let timeMatches = false;
                    if (rule.start_time <= rule.end_time) {
                        // Normal range e.g. 07:00 → 09:30
                        timeMatches = currentTime >= rule.start_time && currentTime <= rule.end_time;
                    } else {
                        // Overnight range e.g. 22:00 → 02:00
                        timeMatches = currentTime >= rule.start_time || currentTime <= rule.end_time;
                    }

                    return dayMatches && timeMatches;
                });

                if (!matchingRules.length) {
                    debugPrint(`🕐 [SURGE] No rules match current time window → no surge`);
                    return { rule: null, multiplier: 1.00 };
                }

                // Rules are already sorted by priority DESC — take the first one
                const winningRule = matchingRules[0];
                const multiplier = parseFloat(winningRule.multiplier);

                debugPrint(`⚡ [SURGE] Active surge: "${winningRule.name}" → ${multiplier}x (priority ${winningRule.priority})`);

                return {
                    rule: winningRule,
                    multiplier,
                };
            } catch (error) {
                // Non-fatal — if surge check fails, default to no surge
                // Never block a booking because of a surge rule error
                console.error('❌ [SURGE] Error checking surge rules:', error.message);
                return { rule: null, multiplier: 1.00 };
            }
        }

        /**
         * Get all surge rules formatted for the backoffice weekly calendar view
         * Groups rules by day of week for easy display
         * @returns {object} Rules grouped by day number (0-6)
         */
        static async getWeeklyCalendar() {
            const rules = await DeliverySurgeRule.findAll({
                order: [['priority', 'DESC'], ['start_time', 'ASC']],
            });

            const calendar = {
                0: [], // Sunday
                1: [], // Monday
                2: [], // Tuesday
                3: [], // Wednesday
                4: [], // Thursday
                5: [], // Friday
                6: [], // Saturday
            };

            const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

            rules.forEach((rule) => {
                const daysOfWeek = Array.isArray(rule.days_of_week)
                    ? rule.days_of_week
                    : JSON.parse(rule.days_of_week || '[]');

                daysOfWeek.forEach((day) => {
                    if (calendar[day] !== undefined) {
                        calendar[day].push({
                            id: rule.id,
                            name: rule.name,
                            startTime: rule.start_time,
                            endTime: rule.end_time,
                            multiplier: parseFloat(rule.multiplier),
                            priority: rule.priority,
                            isActive: rule.is_active,
                            isGlobal: rule.delivery_pricing_id === null,
                            pricingZoneId: rule.delivery_pricing_id,
                        });
                    }
                });
            });

            return {
                calendar,
                dayNames,
                totalRules: rules.length,
                activeRules: rules.filter((r) => r.is_active).length,
            };
        }

        // ─── INSTANCE METHODS ──────────────────────────────────────────────────────

        /**
         * Check if this rule is currently active right now
         * Useful for real-time status display in backoffice
         */
        isCurrentlyActive() {
            if (!this.is_active) return false;

            const now = new Date();
            const currentDay = now.getDay();
            const hours = String(now.getHours()).padStart(2, '0');
            const minutes = String(now.getMinutes()).padStart(2, '0');
            const currentTime = `${hours}:${minutes}`;

            const daysOfWeek = Array.isArray(this.days_of_week)
                ? this.days_of_week
                : JSON.parse(this.days_of_week || '[]');

            const dayMatches = daysOfWeek.includes(currentDay);

            let timeMatches = false;
            if (this.start_time <= this.end_time) {
                timeMatches = currentTime >= this.start_time && currentTime <= this.end_time;
            } else {
                timeMatches = currentTime >= this.start_time || currentTime <= this.end_time;
            }

            return dayMatches && timeMatches;
        }

        /**
         * Human-readable days string for display
         * e.g. [1,2,3,4,5] → "Mon, Tue, Wed, Thu, Fri"
         */
        getDaysLabel() {
            const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            const daysOfWeek = Array.isArray(this.days_of_week)
                ? this.days_of_week
                : JSON.parse(this.days_of_week || '[]');

            return daysOfWeek
                .sort((a, b) => a - b)
                .map((d) => dayNames[d])
                .join(', ');
        }
    }

    DeliverySurgeRule.init(
        {
            id: {
                type: DataTypes.INTEGER,
                autoIncrement: true,
                primaryKey: true,
            },
            name: {
                type: DataTypes.STRING(100),
                allowNull: false,
                validate: {
                    notEmpty: { msg: 'Surge rule name is required' },
                    len: { args: [2, 100], msg: 'Name must be between 2 and 100 characters' },
                },
            },
            description: {
                type: DataTypes.STRING(255),
                allowNull: true,
            },
            days_of_week: {
                type: DataTypes.JSON,
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
                type: DataTypes.STRING(5),
                allowNull: false,
                validate: {
                    is: {
                        args: /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/,
                        msg: 'Start time must be in HH:MM format',
                    },
                },
            },
            end_time: {
                type: DataTypes.STRING(5),
                allowNull: false,
                validate: {
                    is: {
                        args: /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/,
                        msg: 'End time must be in HH:MM format',
                    },
                },
            },
            multiplier: {
                type: DataTypes.DECIMAL(4, 2),
                allowNull: false,
                defaultValue: 1.30,
                validate: {
                    min: { args: [1.00], msg: 'Multiplier cannot be less than 1.00 (no discounts)' },
                    max: { args: [3.00], msg: 'Multiplier cannot exceed 3.00 (safety cap)' },
                },
            },
            delivery_pricing_id: {
                type: DataTypes.INTEGER,
                allowNull: true,
            },
            priority: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 1,
                validate: {
                    min: { args: [1], msg: 'Priority must be at least 1' },
                    max: { args: [100], msg: 'Priority cannot exceed 100' },
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
            modelName: 'DeliverySurgeRule',
            tableName: 'delivery_surge_rules',
            underscored: true,
            timestamps: true,
        }
    );

    return DeliverySurgeRule;
};