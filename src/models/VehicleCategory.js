// wegobackend/src/models/VehicleCategory.js

const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class VehicleCategory extends Model {
    // Class method to get active categories
    static async getActiveCategories() {
        return await this.findAll({
            where: { isActive: true },
            order: [['sortOrder', 'ASC'], ['name', 'ASC']]
        });
    }

    // Class method to get category by slug
    static async findBySlug(slug) {
        return await this.findOne({ where: { slug } });
    }
}

VehicleCategory.init({
    id: {
        type: DataTypes.STRING(36),
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
    },
    name: {
        type: DataTypes.STRING(64),
        allowNull: false,
        unique: true,
        validate: {
            notEmpty: { msg: 'Category name is required' },
            len: {
                args: [2, 64],
                msg: 'Category name must be between 2 and 64 characters'
            }
        }
    },
    slug: {
        type: DataTypes.STRING(64),
        allowNull: false,
        unique: true,
        validate: {
            notEmpty: { msg: 'Slug is required' },
            is: {
                args: /^[a-z0-9-]+$/,
                msg: 'Slug must contain only lowercase letters, numbers, and hyphens'
            }
        }
    },
    description: {
        type: DataTypes.STRING(255),
        allowNull: true,
    },
    basePricePerDay: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
        defaultValue: 0.00,
        validate: {
            min: {
                args: [0],
                msg: 'Base price must be a positive number'
            }
        }
    },
    icon: {
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: 'Icon identifier (e.g., directions_car, electric_car)'
    },
    isActive: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        comment: 'Whether this category is active and visible to users'
    },
    sortOrder: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: 'Display order (lower numbers appear first)'
    }
}, {
    sequelize,
    modelName: 'VehicleCategory',
    tableName: 'vehicle_categories',
    timestamps: true,
    underscored: true,
    hooks: {
        beforeValidate: (category) => {
            // Trim whitespace
            if (category.name) category.name = category.name.trim();
            if (category.slug) category.slug = category.slug.trim().toLowerCase();
            if (category.description) category.description = category.description.trim();
        }
    }
});

module.exports = VehicleCategory;