// src/models/VehicleCategory.js
const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class VehicleCategory extends Model {}

VehicleCategory.init({
    id: {
        type: DataTypes.STRING(36), // uuid v4 string
        primaryKey: true,
        allowNull: false,
    },
    name: {
        type: DataTypes.STRING(64),
        allowNull: false,
        validate: {
            notEmpty: {
                msg: 'Category name cannot be empty'
            },
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
            notEmpty: {
                msg: 'Slug cannot be empty'
            },
            isLowercase: {
                msg: 'Slug must be lowercase'
            },
            is: {
                args: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
                msg: 'Slug must contain only lowercase letters, numbers, and hyphens'
            }
        }
    },
    description: {
        type: DataTypes.STRING(255),
        allowNull: true,
        validate: {
            len: {
                args: [0, 255],
                msg: 'Description cannot exceed 255 characters'
            }
        }
    },
    icon: {
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: 'Icon identifier (e.g., directions_car, electric_car, car_rental, local_shipping)',
        validate: {
            len: {
                args: [0, 64],
                msg: 'Icon identifier cannot exceed 64 characters'
            }
        }
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
        comment: 'Display order (lower numbers appear first)',
        validate: {
            isInt: {
                msg: 'Sort order must be an integer'
            },
            min: {
                args: [0],
                msg: 'Sort order cannot be negative'
            }
        }
    },
}, {
    sequelize,
    modelName: 'VehicleCategory',
    tableName: 'vehicle_categories',
    timestamps: true,
    underscored: true,
    indexes: [
        {
            unique: true,
            fields: ['slug'],
            name: 'unique_vehicle_category_slug'
        },
        {
            fields: ['is_active'], // ✅ Changed from 'isActive' to 'is_active'
            name: 'idx_vehicle_category_is_active'
        },
        {
            fields: ['sort_order'], // ✅ Changed from 'sortOrder' to 'sort_order'
            name: 'idx_vehicle_category_sort_order'
        }
    ],
    hooks: {
        beforeValidate: (category, options) => {
            // Auto-generate slug from name if not provided
            if (category.name && !category.slug) {
                category.slug = category.name
                    .toLowerCase()
                    .trim()
                    .replace(/[^\w\s-]/g, '') // Remove special characters
                    .replace(/[\s_-]+/g, '-')  // Replace spaces/underscores with hyphens
                    .replace(/^-+|-+$/g, '');  // Remove leading/trailing hyphens
            }
        },
        beforeCreate: (category, options) => {
            // Ensure slug is lowercase
            if (category.slug) {
                category.slug = category.slug.toLowerCase();
            }
        },
        beforeUpdate: (category, options) => {
            // Ensure slug is lowercase on update
            if (category.slug) {
                category.slug = category.slug.toLowerCase();
            }
        }
    }
});

/**
 * Instance Methods
 */

// Activate category
VehicleCategory.prototype.activate = async function() {
    this.isActive = true;
    return await this.save();
};

// Deactivate category
VehicleCategory.prototype.deactivate = async function() {
    this.isActive = false;
    return await this.save();
};

// Update sort order
VehicleCategory.prototype.updateSortOrder = async function(newOrder) {
    this.sortOrder = newOrder;
    return await this.save();
};

/**
 * Class Methods
 */

// Get all active categories ordered by sortOrder
VehicleCategory.getActiveCategories = async function() {
    return await VehicleCategory.findAll({
        where: { isActive: true },
        order: [['sortOrder', 'ASC'], ['name', 'ASC']],
        attributes: ['id', 'name', 'slug', 'description', 'icon', 'sortOrder']
    });
};

// Find category by slug
VehicleCategory.findBySlug = async function(slug) {
    return await VehicleCategory.findOne({
        where: { slug: slug.toLowerCase() }
    });
};

// Get category with vehicle count
VehicleCategory.getCategoryWithVehicleCount = async function(categoryId) {
    const { Vehicle } = require('./index');
    return await VehicleCategory.findByPk(categoryId, {
        include: [{
            model: Vehicle,
            as: 'vehicles',
            attributes: [],
            where: { availableForRent: true },
            required: false
        }],
        attributes: {
            include: [
                [
                    sequelize.fn('COUNT', sequelize.col('vehicles.id')),
                    'vehicleCount'
                ]
            ]
        },
        group: ['VehicleCategory.id']
    });
};

// Reorder categories
VehicleCategory.reorderCategories = async function(categoryIdsInOrder) {
    const transaction = await sequelize.transaction();

    try {
        for (let i = 0; i < categoryIdsInOrder.length; i++) {
            await VehicleCategory.update(
                { sortOrder: i },
                {
                    where: { id: categoryIdsInOrder[i] },
                    transaction
                }
            );
        }

        await transaction.commit();
        return true;
    } catch (error) {
        await transaction.rollback();
        throw error;
    }
};

/**
 * Associations
 * These are defined in models/index.js
 */

module.exports = VehicleCategory;