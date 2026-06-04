'use strict';

const { DataTypes, Model } = require('sequelize');

module.exports = (sequelize) => {

    class ServiceListingPlan extends Model {

        static associate(models) {
            if (models.Employee) {
                ServiceListingPlan.belongsTo(models.Employee, {
                    foreignKey:  'created_by',
                    as:          'creator',
                    constraints: false,
                });
                ServiceListingPlan.belongsTo(models.Employee, {
                    foreignKey:  'updated_by',
                    as:          'updater',
                    constraints: false,
                });
            }
            if (models.ServiceAdPayment) {
                ServiceListingPlan.hasMany(models.ServiceAdPayment, {
                    foreignKey: 'plan_id',
                    as:         'adPayments',
                });
            }
            if (models.ServiceListing) {
                ServiceListingPlan.hasMany(models.ServiceListing, {
                    foreignKey:  'current_plan_id',
                    as:          'activeListings',
                    constraints: false,
                });
            }
        }
    }

    ServiceListingPlan.init(
        {
            id: {
                type:          DataTypes.INTEGER,
                primaryKey:    true,
                autoIncrement: true,
            },

            // ── Identity ──────────────────────────────────────────────────────
            plan_key: {
                type:      DataTypes.STRING(50),
                allowNull: false,
                unique:    true,
                comment:   'Machine-readable key e.g. "free", "basic", "pro", "hero"',
                validate: {
                    is: {
                        args: [/^[a-z0-9_]+$/],
                        msg:  'plan_key must be lowercase letters, numbers, and underscores only',
                    },
                },
            },

            label_en: {
                type:      DataTypes.STRING(80),
                allowNull: false,
                comment:   'Display label shown to providers (English)',
            },

            label_fr: {
                type:      DataTypes.STRING(80),
                allowNull: false,
                comment:   'Display label shown to providers (French)',
            },

            description_en: {
                type:      DataTypes.STRING(300),
                allowNull: true,
            },

            description_fr: {
                type:      DataTypes.STRING(300),
                allowNull: true,
            },

            // ── Pricing ───────────────────────────────────────────────────────
            price_xaf: {
                type:         DataTypes.INTEGER,
                allowNull:    false,
                defaultValue: 0,
                comment:      'Price in XAF. 0 = free plan.',
            },

            // ── Plan Rules ────────────────────────────────────────────────────
            duration_days: {
                type:         DataTypes.INTEGER,
                allowNull:    false,
                defaultValue: 30,
                comment:      'How many days the listing stays active after payment',
            },

            max_photos: {
                type:         DataTypes.INTEGER,
                allowNull:    false,
                defaultValue: 3,
                comment:      'Maximum number of photos the listing can have on this plan',
            },

            is_hero_placement: {
                type:         DataTypes.BOOLEAN,
                allowNull:    false,
                defaultValue: false,
                comment:      'Whether this plan includes hero/featured carousel placement',
            },

            requires_admin_approval: {
                type:         DataTypes.BOOLEAN,
                allowNull:    false,
                defaultValue: true,
                comment:      'Whether the listing must be approved by admin before going live',
            },

            boost_priority: {
                type:         DataTypes.INTEGER,
                allowNull:    false,
                defaultValue: 0,
                comment:      '0 = no boost | 1 = standard | 2 = premium. Used in search ranking.',
            },

            // ── UI / Display ──────────────────────────────────────────────────
            is_highlighted: {
                type:         DataTypes.BOOLEAN,
                allowNull:    false,
                defaultValue: false,
                comment:      'Whether to show a highlight badge on this plan in the plan picker',
            },

            highlight_label_en: {
                type:      DataTypes.STRING(40),
                allowNull: true,
                comment:   'Badge text e.g. "Most Popular", "Best Value" (English)',
            },

            highlight_label_fr: {
                type:      DataTypes.STRING(40),
                allowNull: true,
                comment:   'Badge text (French)',
            },

            display_order: {
                type:         DataTypes.INTEGER,
                allowNull:    false,
                defaultValue: 0,
                comment:      'Sort order in the plan picker (lower = shown first)',
            },

            // ── Lifecycle ─────────────────────────────────────────────────────
            is_active: {
                type:         DataTypes.BOOLEAN,
                allowNull:    false,
                defaultValue: true,
                comment:      'Inactive plans are hidden from the Flutter plan picker',
            },

            // ── Audit ─────────────────────────────────────────────────────────
            created_by: {
                type:      DataTypes.INTEGER,
                allowNull: true,
                comment:   'Employee ID who created this plan',
            },

            updated_by: {
                type:      DataTypes.INTEGER,
                allowNull: true,
                comment:   'Employee ID who last updated this plan',
            },
        },
        {
            sequelize,
            modelName:   'ServiceListingPlan',
            tableName:   'service_listing_plans',
            timestamps:  true,
            underscored: true,
            indexes: [
                { unique: true, fields: ['plan_key'] },
                { fields: ['is_active'] },
                { fields: ['display_order'] },
                { fields: ['created_by'] },
                { fields: ['updated_by'] },
            ],
        }
    );

    return ServiceListingPlan;
};