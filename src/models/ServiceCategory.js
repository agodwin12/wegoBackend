// backend/src/models/ServiceCategory.js
// Service Category Model for Services Marketplace

const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class ServiceCategory extends Model {}

// ═══════════════════════════════════════════════════════════════════════
// MODEL DEFINITION
// ═══════════════════════════════════════════════════════════════════════

ServiceCategory.init(
    {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },

        // Category Names (Bilingual - French & English)
        name_fr: {
            type: DataTypes.STRING(200),
            allowNull: false,
            comment: 'Category name in French',
        },

        name_en: {
            type: DataTypes.STRING(200),
            allowNull: false,
            comment: 'Category name in English',
        },

        // Descriptions (Bilingual)
        description_fr: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'Category description in French',
        },

        description_en: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'Category description in English',
        },

        // Category Hierarchy
        parent_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
            comment: 'Parent category ID for subcategories',
        },

        // Icon/Image
        icon_url: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'Cloudflare R2 URL for category icon/image',
        },

        // Display & Status
        display_order: {
            type: DataTypes.INTEGER,
            defaultValue: 0,
            comment: 'Order for displaying categories',
        },

        status: {
            type: DataTypes.ENUM('active', 'inactive'),
            defaultValue: 'active',
            allowNull: false,
        },

        // Metadata
        created_by: {
            type: DataTypes.INTEGER,
            allowNull: true,
            comment: 'Employee ID who created this category',
        },

        updated_by: {
            type: DataTypes.INTEGER,
            allowNull: true,
            comment: 'Employee ID who last updated this category',
        },

        // Soft Delete
        deleted_at: {
            type: DataTypes.DATE,
            allowNull: true,
        },
    },
    {
        sequelize,
        modelName: 'ServiceCategory',
        tableName: 'service_categories',
        timestamps: true,
        paranoid: true,
        underscored: true,
    }
);

module.exports = ServiceCategory;