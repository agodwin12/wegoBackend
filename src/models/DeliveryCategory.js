// src/models/DeliveryCategory.js

const { DataTypes, Model } = require('sequelize');

module.exports = (sequelize) => {
    class DeliveryCategory extends Model {
        static associate(models) {
            if (models.Employee) {
                DeliveryCategory.belongsTo(models.Employee, {
                    foreignKey: 'created_by',
                    as:         'createdByEmployee',
                });
            }
        }
    }

    DeliveryCategory.init({
        id: {
            type:          DataTypes.INTEGER.UNSIGNED,
            autoIncrement: true,
            primaryKey:    true,
        },

        // Slug used in API and Flutter — e.g. 'document', 'food'
        key_name: {
            type:      DataTypes.STRING(50),
            allowNull: false,
            unique:    true,
            validate: {
                is:       { args: [/^[a-z0-9_]+$/], msg: 'key_name must be lowercase letters, numbers, underscores only' },
                notEmpty: { msg: 'key_name is required' },
            },
        },

        name_fr: {
            type:      DataTypes.STRING(100),
            allowNull: false,
            validate: { notEmpty: { msg: 'French name is required' } },
        },

        name_en: {
            type:      DataTypes.STRING(100),
            allowNull: false,
            validate: { notEmpty: { msg: 'English name is required' } },
        },

        emoji: {
            type:         DataTypes.STRING(10),
            allowNull:    false,
            defaultValue: '📦',
        },

        is_active: {
            type:         DataTypes.BOOLEAN,
            allowNull:    false,
            defaultValue: true,
        },

        display_order: {
            type:         DataTypes.INTEGER,
            allowNull:    false,
            defaultValue: 0,
        },

        created_by: {
            type:      DataTypes.INTEGER.UNSIGNED,
            allowNull: true,
        },

    }, {
        sequelize,
        modelName:   'DeliveryCategory',
        tableName:   'delivery_categories',
        timestamps:  true,
        underscored: true,
    });

    return DeliveryCategory;
};