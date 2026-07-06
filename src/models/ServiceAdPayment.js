'use strict';

const { DataTypes, Model } = require('sequelize');

module.exports = (sequelize) => {

    class ServiceAdPayment extends Model {

        static associate(models) {
            if (models.ServiceListing) {
                ServiceAdPayment.belongsTo(models.ServiceListing, {
                    foreignKey:  'listing_id',
                    as:          'listing',
                    constraints: false,
                });
            }
            if (models.ServiceListingPlan) {
                ServiceAdPayment.belongsTo(models.ServiceListingPlan, {
                    foreignKey:  'plan_id',
                    as:          'plan',
                    constraints: false,
                });
            }
            if (models.WegoPayment) {
                ServiceAdPayment.belongsTo(models.WegoPayment, {
                    foreignKey:  'wego_payment_id',
                    targetKey:   'id',
                    as:          'wegoPayment',
                    constraints: false,
                });
            }
            if (models.Account) {
                ServiceAdPayment.belongsTo(models.Account, {
                    foreignKey:  'paid_by',
                    targetKey:   'uuid',
                    as:          'payer',
                    constraints: false,
                });
            }
            if (models.Employee) {
                ServiceAdPayment.belongsTo(models.Employee, {
                    foreignKey:  'hero_reviewed_by',
                    as:          'heroReviewer',
                    constraints: false,
                });
            }
        }
    }

    ServiceAdPayment.init(
        {
            id: {
                type:          DataTypes.INTEGER,
                primaryKey:    true,
                autoIncrement: true,
            },
            listing_id: {
                type:      DataTypes.INTEGER,
                allowNull: true,  // NULL = provider-level subscription (not tied to one listing)
            },
            paid_by: {
                type:      DataTypes.CHAR(36),
                allowNull: false,
            },
            plan_id: {
                type:      DataTypes.INTEGER,
                allowNull: true,
            },
            plan_key_snapshot: {
                type:      DataTypes.STRING(50),
                allowNull: true,
            },
            duration_days_snapshot: {
                type:         DataTypes.INTEGER,
                allowNull:    false,
                defaultValue: 30,
            },
            is_hero_placement_snapshot: {
                type:         DataTypes.BOOLEAN,
                allowNull:    false,
                defaultValue: false,
            },
            amount_snapshot: {
                type:      DataTypes.DECIMAL(10, 2),
                allowNull: true,
            },
            status: {
                type: DataTypes.ENUM(
                    'pending_payment',
                    'active',
                    'hero_pending',
                    'expired',
                    'refunded',
                    'cancelled'
                ),
                allowNull:    false,
                defaultValue: 'pending_payment',
            },
            wego_payment_id: {
                type:      DataTypes.CHAR(36),
                allowNull: true,
            },
            plan_starts_at: {
                type:      DataTypes.DATE,
                allowNull: true,
            },
            plan_expires_at: {
                type:      DataTypes.DATE,
                allowNull: true,
            },
            notes: {
                type:      DataTypes.STRING(300),
                allowNull: true,
            },
            hero_reviewed_by: {
                type:      DataTypes.INTEGER,
                allowNull: true,
            },
        },
        {
            sequelize,
            modelName:   'ServiceAdPayment',
            tableName:   'service_ad_payments',
            timestamps:  true,
            underscored: true,
            indexes: [
                { fields: ['listing_id'] },
                { fields: ['paid_by'] },
                { fields: ['status'] },
                { fields: ['wego_payment_id'] },
                { fields: ['plan_expires_at'] },
                { fields: ['plan_id'] },
                { fields: ['hero_reviewed_by'] },
            ],
        }
    );

    return ServiceAdPayment;
};