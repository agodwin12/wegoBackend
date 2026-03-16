// backend/src/controllers/serviceCategory.controller.js
// Service Category Controller - Admin/Employee Management

const { ServiceCategory, Employee, ServiceListing } = require('../models');
const { uploadFileToR2, deleteFile } = require('../middleware/upload');
const { Op } = require('sequelize');

// ═══════════════════════════════════════════════════════════════════════
// GET ALL CATEGORIES (Public - with pagination)
// GET /api/services/categories
// ═══════════════════════════════════════════════════════════════════════

exports.getAllCategories = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const offset = (page - 1) * limit;

        const { count, rows: categories } = await ServiceCategory.findAndCountAll({
            where: { status: 'active' },
            limit,
            offset,
            order: [
                ['parent_id', 'ASC'],
                ['display_order', 'ASC'],
                ['name_en', 'ASC']
            ],
        });

        // Group categories by parent
        const parentCategories = categories.filter(cat => cat.parent_id === null);
        const result = parentCategories.map(parent => {
            const subcategories = categories.filter(cat => cat.parent_id === parent.id);

            return {
                id: parent.id,
                name_en: parent.name_en,
                name_fr: parent.name_fr,
                description_en: parent.description_en,
                description_fr: parent.description_fr,
                icon_url: parent.icon_url,
                display_order: parent.display_order,
                is_active: parent.status === 'active',
                active_listings_count: 0, // TODO: Add count query
                created_at: parent.created_at,
                updated_at: parent.updated_at,
                subcategories: subcategories.map(sub => ({
                    id: sub.id,
                    name_en: sub.name_en,
                    name_fr: sub.name_fr,
                    description_en: sub.description_en,
                    description_fr: sub.description_fr,
                    icon_url: sub.icon_url,
                    parent_id: sub.parent_id,
                    display_order: sub.display_order,
                    is_active: sub.status === 'active',
                    active_listings_count: 0, // TODO: Add count query
                    created_at: sub.created_at,
                    updated_at: sub.updated_at,
                }))
            };
        });

        const totalPages = Math.ceil(count / limit);

        res.status(200).json({
            success: true,
            message: 'Categories retrieved successfully',
            data: {
                categories: result  // ✅ FIXED: Wrapped in object
            },
            pagination: {
                total: count,
                page,
                limit,
                totalPages,
                hasNext: page < totalPages,
                hasPrev: page > 1,
            }
        });

    } catch (error) {
        console.error('❌ [SERVICE_CATEGORY_CONTROLLER] Error in getAllCategories:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve categories. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET PARENT CATEGORIES ONLY (with pagination)
// GET /api/services/categories/parents
// ═══════════════════════════════════════════════════════════════════════

exports.getParentCategories = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;

        const { count, rows: categories } = await ServiceCategory.findAndCountAll({
            where: {
                parent_id: null,
                status: 'active',
            },
            limit,
            offset,
            order: [['display_order', 'ASC'], ['name_en', 'ASC']],
        });

        const result = categories.map(cat => ({
            id: cat.id,
            name_en: cat.name_en,
            name_fr: cat.name_fr,
            description_en: cat.description_en,
            description_fr: cat.description_fr,
            icon_url: cat.icon_url,
            parent_id: null,
            display_order: cat.display_order,
            is_active: cat.status === 'active',
            active_listings_count: 0, // TODO: Add count query
            created_at: cat.created_at,
            updated_at: cat.updated_at,
        }));

        const totalPages = Math.ceil(count / limit);

        res.status(200).json({
            success: true,
            message: 'Parent categories retrieved successfully',
            data: {
                categories: result  // ✅ FIXED: Wrapped in object
            },
            pagination: {
                total: count,
                page,
                limit,
                totalPages,
                hasNext: page < totalPages,
                hasPrev: page > 1,
            }
        });

    } catch (error) {
        console.error('❌ [SERVICE_CATEGORY_CONTROLLER] Error in getParentCategories:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve parent categories. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET SUBCATEGORIES BY PARENT ID (with pagination)
// GET /api/services/categories/:parentId/subcategories
// ═══════════════════════════════════════════════════════════════════════

exports.getSubcategories = async (req, res) => {
    try {
        const { parentId } = req.params;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;

        // Validate parentId
        if (!parentId || isNaN(parentId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid parent category ID. Please provide a valid numeric ID.',
            });
        }

        // Check if parent exists
        const parentCategory = await ServiceCategory.findByPk(parentId);
        if (!parentCategory) {
            return res.status(404).json({
                success: false,
                message: 'Parent category not found. The specified category does not exist.',
            });
        }

        const { count, rows: categories } = await ServiceCategory.findAndCountAll({
            where: {
                parent_id: parentId,
                status: 'active',
            },
            limit,
            offset,
            order: [['display_order', 'ASC'], ['name_en', 'ASC']],
        });

        const result = categories.map(cat => ({
            id: cat.id,
            name_en: cat.name_en,
            name_fr: cat.name_fr,
            description_en: cat.description_en,
            description_fr: cat.description_fr,
            icon_url: cat.icon_url,
            parent_id: cat.parent_id,
            display_order: cat.display_order,
            is_active: cat.status === 'active',
            active_listings_count: 0, // TODO: Add count query
            created_at: cat.created_at,
            updated_at: cat.updated_at,
        }));

        const totalPages = Math.ceil(count / limit);

        res.status(200).json({
            success: true,
            message: 'Subcategories retrieved successfully',
            data: {
                categories: result  // ✅ FIXED: Wrapped in object
            },
            pagination: {
                total: count,
                page,
                limit,
                totalPages,
                hasNext: page < totalPages,
                hasPrev: page > 1,
            }
        });

    } catch (error) {
        console.error('❌ [SERVICE_CATEGORY_CONTROLLER] Error in getSubcategories:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve subcategories. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET SINGLE CATEGORY BY ID
// GET /api/services/categories/:id
// ═══════════════════════════════════════════════════════════════════════

exports.getCategoryById = async (req, res) => {
    try {
        const { id } = req.params;

        // Validate ID
        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid category ID. Please provide a valid numeric ID.',
            });
        }

        const category = await ServiceCategory.findByPk(id, {
            include: [
                {
                    model: ServiceCategory,
                    as: 'subcategories',
                    where: { status: 'active' },
                    required: false,
                    attributes: ['id', 'name_en', 'name_fr', 'description_en', 'description_fr', 'icon_url', 'display_order'],
                }
            ]
        });

        if (!category) {
            return res.status(404).json({
                success: false,
                message: 'Category not found. The specified category does not exist.',
            });
        }

        res.status(200).json({
            success: true,
            message: 'Category retrieved successfully',
            data: {
                category: {
                    id: category.id,
                    name_en: category.name_en,
                    name_fr: category.name_fr,
                    description_en: category.description_en,
                    description_fr: category.description_fr,
                    parent_id: category.parent_id,
                    icon_url: category.icon_url,
                    display_order: category.display_order,
                    is_active: category.status === 'active',
                    status: category.status,
                    subcategories: category.subcategories || [],
                    created_at: category.created_at,
                    updated_at: category.updated_at,
                }
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_CATEGORY_CONTROLLER] Error in getCategoryById:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve category. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// CREATE CATEGORY (Admin/Employee Only)
// POST /api/services/categories
// ═══════════════════════════════════════════════════════════════════════

exports.createCategory = async (req, res) => {
    try {
        const {
            name_en,
            description_en,
            parent_id,
            display_order,
            status,
        } = req.body;

        // Validation
        if (!name_en || name_en.trim().length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Category name is required. Please provide a valid category name.',
            });
        }

        if (name_en.length < 3) {
            return res.status(400).json({
                success: false,
                message: 'Category name is too short. Please provide at least 3 characters.',
            });
        }

        if (name_en.length > 200) {
            return res.status(400).json({
                success: false,
                message: 'Category name is too long. Maximum 200 characters allowed.',
            });
        }

        // Check if parent exists (if parent_id provided)
        if (parent_id) {
            const parentCategory = await ServiceCategory.findByPk(parent_id);
            if (!parentCategory) {
                return res.status(404).json({
                    success: false,
                    message: 'Parent category not found. Please select a valid parent category.',
                });
            }

            // Check if parent is also a subcategory (max 2 levels)
            if (parentCategory.parent_id !== null) {
                return res.status(400).json({
                    success: false,
                    message: 'Cannot create nested subcategories. Maximum category depth is 2 levels.',
                });
            }
        }

        // Check for duplicate category name
        const existingCategory = await ServiceCategory.findOne({
            where: {
                name_en: name_en.trim(),
                parent_id: parent_id || null,
            }
        });

        if (existingCategory) {
            return res.status(409).json({
                success: false,
                message: 'A category with this name already exists. Please use a different name.',
            });
        }

        // Handle icon upload if file provided
        let icon_url = null;
        if (req.file) {
            try {
                icon_url = await uploadFileToR2(req.file, 'service-categories');
            } catch (uploadError) {
                console.error('❌ [SERVICE_CATEGORY_CONTROLLER] Icon upload failed:', uploadError);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to upload category icon. Please try again or contact support.',
                });
            }
        }

        // Create category
        const category = await ServiceCategory.create({
            name_en: name_en.trim(),
            name_fr: name_en.trim(), // Temporary - will add translation later
            description_en: description_en ? description_en.trim() : null,
            description_fr: description_en ? description_en.trim() : null, // Temporary
            parent_id: parent_id || null,
            icon_url,
            display_order: display_order || 0,
            status: status || 'active',
            created_by: req.user.id, // Employee ID from auth middleware
        });

        console.log('✅ [SERVICE_CATEGORY_CONTROLLER] Category created:', category.id);

        res.status(201).json({
            success: true,
            message: 'Category created successfully',
            data: {
                category: {
                    id: category.id,
                    name_en: category.name_en,
                    name_fr: category.name_fr,
                    description_en: category.description_en,
                    description_fr: category.description_fr,
                    parent_id: category.parent_id,
                    icon_url: category.icon_url,
                    display_order: category.display_order,
                    status: category.status,
                    created_at: category.created_at,
                }
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_CATEGORY_CONTROLLER] Error in createCategory:', error);

        // Handle specific database errors
        if (error.name === 'SequelizeValidationError') {
            return res.status(400).json({
                success: false,
                message: 'Validation error. Please check your input and try again.',
                errors: error.errors.map(e => e.message),
            });
        }

        if (error.name === 'SequelizeUniqueConstraintError') {
            return res.status(409).json({
                success: false,
                message: 'A category with this information already exists.',
            });
        }

        res.status(500).json({
            success: false,
            message: 'Unable to create category. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// UPDATE CATEGORY (Admin/Employee Only)
// PUT /api/services/categories/:id
// ═══════════════════════════════════════════════════════════════════════

exports.updateCategory = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            name_en,
            description_en,
            parent_id,
            display_order,
            status,
        } = req.body;

        // Validate ID
        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid category ID. Please provide a valid numeric ID.',
            });
        }

        const category = await ServiceCategory.findByPk(id);

        if (!category) {
            return res.status(404).json({
                success: false,
                message: 'Category not found. The specified category does not exist.',
            });
        }

        // Validate name if provided
        if (name_en !== undefined) {
            if (!name_en || name_en.trim().length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Category name cannot be empty.',
                });
            }

            if (name_en.length < 3) {
                return res.status(400).json({
                    success: false,
                    message: 'Category name is too short. Please provide at least 3 characters.',
                });
            }

            if (name_en.length > 200) {
                return res.status(400).json({
                    success: false,
                    message: 'Category name is too long. Maximum 200 characters allowed.',
                });
            }
        }

        // Check if trying to set itself as parent
        if (parent_id && parseInt(parent_id) === parseInt(id)) {
            return res.status(400).json({
                success: false,
                message: 'A category cannot be its own parent. Please select a different parent.',
            });
        }

        // Check if parent exists (if parent_id provided)
        if (parent_id) {
            const parentCategory = await ServiceCategory.findByPk(parent_id);
            if (!parentCategory) {
                return res.status(404).json({
                    success: false,
                    message: 'Parent category not found. Please select a valid parent category.',
                });
            }

            // Check if parent is also a subcategory (max 2 levels)
            if (parentCategory.parent_id !== null) {
                return res.status(400).json({
                    success: false,
                    message: 'Cannot create nested subcategories. Maximum category depth is 2 levels.',
                });
            }

            // Check for circular reference
            if (parentCategory.parent_id === parseInt(id)) {
                return res.status(400).json({
                    success: false,
                    message: 'Circular reference detected. The selected parent is a child of this category.',
                });
            }
        }

        // Handle icon upload if new file provided
        let icon_url = category.icon_url;
        if (req.file) {
            try {
                // Delete old icon if exists
                if (category.icon_url) {
                    await deleteFile(category.icon_url).catch(err => {
                        console.warn('⚠️ Failed to delete old icon:', err);
                    });
                }
                icon_url = await uploadFileToR2(req.file, 'service-categories');
            } catch (uploadError) {
                console.error('❌ [SERVICE_CATEGORY_CONTROLLER] Icon upload failed:', uploadError);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to upload new category icon. Please try again.',
                });
            }
        }

        // Update category
        await category.update({
            name_en: name_en ? name_en.trim() : category.name_en,
            name_fr: name_en ? name_en.trim() : category.name_fr, // Temporary
            description_en: description_en !== undefined ? (description_en ? description_en.trim() : null) : category.description_en,
            description_fr: description_en !== undefined ? (description_en ? description_en.trim() : null) : category.description_fr, // Temporary
            parent_id: parent_id !== undefined ? parent_id : category.parent_id,
            icon_url,
            display_order: display_order !== undefined ? display_order : category.display_order,
            status: status || category.status,
            updated_by: req.user.id, // Employee ID from auth middleware
        });

        console.log('✅ [SERVICE_CATEGORY_CONTROLLER] Category updated:', category.id);

        res.status(200).json({
            success: true,
            message: 'Category updated successfully',
            data: {
                category: {
                    id: category.id,
                    name_en: category.name_en,
                    name_fr: category.name_fr,
                    description_en: category.description_en,
                    description_fr: category.description_fr,
                    parent_id: category.parent_id,
                    icon_url: category.icon_url,
                    display_order: category.display_order,
                    status: category.status,
                    updated_at: category.updated_at,
                }
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_CATEGORY_CONTROLLER] Error in updateCategory:', error);

        if (error.name === 'SequelizeValidationError') {
            return res.status(400).json({
                success: false,
                message: 'Validation error. Please check your input and try again.',
                errors: error.errors.map(e => e.message),
            });
        }

        res.status(500).json({
            success: false,
            message: 'Unable to update category. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// DELETE CATEGORY (Admin/Employee Only - Soft Delete)
// DELETE /api/services/categories/:id
// ═══════════════════════════════════════════════════════════════════════

exports.deleteCategory = async (req, res) => {
    try {
        const { id } = req.params;

        // Validate ID
        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid category ID. Please provide a valid numeric ID.',
            });
        }

        const category = await ServiceCategory.findByPk(id);

        if (!category) {
            return res.status(404).json({
                success: false,
                message: 'Category not found. The specified category does not exist.',
            });
        }

        // Check if category has subcategories
        const subcategoriesCount = await ServiceCategory.count({
            where: { parent_id: id },
        });

        if (subcategoriesCount > 0) {
            return res.status(400).json({
                success: false,
                message: `Cannot delete this category. It has ${subcategoriesCount} subcategory(ies). Please delete or move the subcategories first.`,
            });
        }

        // Check if category has active moderation
        const activeListingsCount = await ServiceListing.count({
            where: {
                category_id: id,
                status: ['pending', 'approved', 'active'],
            },
        });

        if (activeListingsCount > 0) {
            return res.status(400).json({
                success: false,
                message: `Cannot delete this category. It has ${activeListingsCount} active service listing(s). Please remove or reassign the listings first.`,
            });
        }

        // Soft delete
        await category.destroy();

        console.log('✅ [SERVICE_CATEGORY_CONTROLLER] Category deleted:', id);

        res.status(200).json({
            success: true,
            message: 'Category deleted successfully',
        });

    } catch (error) {
        console.error('❌ [SERVICE_CATEGORY_CONTROLLER] Error in deleteCategory:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to delete category. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET ALL CATEGORIES (Public - with pagination)
// GET /api/services/categories
// ═══════════════════════════════════════════════════════════════════════

exports.getAllCategories = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const offset = (page - 1) * limit;

        const { count, rows: categories } = await ServiceCategory.findAndCountAll({
            where: { status: 'active' },
            limit,
            offset,
            order: [
                ['parent_id', 'ASC'],
                ['display_order', 'ASC'],
                ['name_en', 'ASC']
            ],
        });

        // ─────────────────────────────────────────────────────────────────
        // GET ACTIVE LISTING COUNTS IN ONE QUERY (not hardcoded 0)
        // ─────────────────────────────────────────────────────────────────

        const categoryIds = categories.map(cat => cat.id);

        const listingCounts = await ServiceListing.findAll({
            where: {
                category_id: categoryIds,
                status: 'active',
            },
            attributes: [
                'category_id',
                [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'count']
            ],
            group: ['category_id'],
            raw: true,
        });

        // Build a map for quick lookup: { categoryId -> count }
        const countMap = {};
        listingCounts.forEach(row => {
            countMap[row.category_id] = parseInt(row.count);
        });

        // ─────────────────────────────────────────────────────────────────
        // GROUP INTO PARENT + SUBCATEGORIES
        // ─────────────────────────────────────────────────────────────────

        const parentCategories = categories.filter(cat => cat.parent_id === null);

        const result = parentCategories.map(parent => {
            const subcategories = categories.filter(cat => cat.parent_id === parent.id);

            // Parent count = its own listings + all subcategory listings
            const subcategoryIds = subcategories.map(s => s.id);
            const parentListingCount = (countMap[parent.id] || 0) +
                subcategoryIds.reduce((sum, subId) => sum + (countMap[subId] || 0), 0);

            return {
                id: parent.id,
                name_en: parent.name_en,
                name_fr: parent.name_fr,
                description_en: parent.description_en,
                description_fr: parent.description_fr,
                icon_url: parent.icon_url,
                display_order: parent.display_order,
                is_active: parent.status === 'active',
                active_listings_count: parentListingCount,
                created_at: parent.created_at,
                updated_at: parent.updated_at,
                subcategories: subcategories.map(sub => ({
                    id: sub.id,
                    name_en: sub.name_en,
                    name_fr: sub.name_fr,
                    description_en: sub.description_en,
                    description_fr: sub.description_fr,
                    icon_url: sub.icon_url,
                    parent_id: sub.parent_id,
                    display_order: sub.display_order,
                    is_active: sub.status === 'active',
                    active_listings_count: countMap[sub.id] || 0,
                    created_at: sub.created_at,
                    updated_at: sub.updated_at,
                }))
            };
        });

        const totalPages = Math.ceil(count / limit);

        res.status(200).json({
            success: true,
            message: 'Categories retrieved successfully',
            data: { categories: result },
            pagination: {
                total: count,
                page,
                limit,
                totalPages,
                hasNext: page < totalPages,
                hasPrev: page > 1,
            }
        });

    } catch (error) {
        console.error('❌ [SERVICE_CATEGORY_CONTROLLER] Error in getAllCategories:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve categories. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET PARENT CATEGORIES ONLY (with pagination)
// GET /api/services/categories/parents
// ═══════════════════════════════════════════════════════════════════════

exports.getParentCategories = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;

        const { count, rows: categories } = await ServiceCategory.findAndCountAll({
            where: {
                parent_id: null,
                status: 'active',
            },
            limit,
            offset,
            order: [['display_order', 'ASC'], ['name_en', 'ASC']],
        });

        // ─────────────────────────────────────────────────────────────────
        // GET ACTIVE LISTING COUNTS FOR THESE PARENT CATEGORIES
        // Includes listings in their subcategories too
        // ─────────────────────────────────────────────────────────────────

        const parentIds = categories.map(cat => cat.id);

        // Get all subcategory IDs for these parents
        const subcategories = await ServiceCategory.findAll({
            where: {
                parent_id: parentIds,
                status: 'active',
            },
            attributes: ['id', 'parent_id'],
            raw: true,
        });

        // All category IDs to count listings for
        const allCategoryIds = [
            ...parentIds,
            ...subcategories.map(s => s.id),
        ];

        const listingCounts = await ServiceListing.findAll({
            where: {
                category_id: allCategoryIds,
                status: 'active',
            },
            attributes: [
                'category_id',
                [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'count']
            ],
            group: ['category_id'],
            raw: true,
        });

        // Build count map
        const countMap = {};
        listingCounts.forEach(row => {
            countMap[row.category_id] = parseInt(row.count);
        });

        // Build subcategory map: parentId -> [subIds]
        const subMap = {};
        subcategories.forEach(sub => {
            if (!subMap[sub.parent_id]) subMap[sub.parent_id] = [];
            subMap[sub.parent_id].push(sub.id);
        });

        const result = categories.map(cat => {
            const subIds = subMap[cat.id] || [];
            const totalCount = (countMap[cat.id] || 0) +
                subIds.reduce((sum, subId) => sum + (countMap[subId] || 0), 0);

            return {
                id: cat.id,
                name_en: cat.name_en,
                name_fr: cat.name_fr,
                description_en: cat.description_en,
                description_fr: cat.description_fr,
                icon_url: cat.icon_url,
                parent_id: null,
                display_order: cat.display_order,
                is_active: cat.status === 'active',
                active_listings_count: totalCount,
                created_at: cat.created_at,
                updated_at: cat.updated_at,
            };
        });

        const totalPages = Math.ceil(count / limit);

        res.status(200).json({
            success: true,
            message: 'Parent categories retrieved successfully',
            data: { categories: result },
            pagination: {
                total: count,
                page,
                limit,
                totalPages,
                hasNext: page < totalPages,
                hasPrev: page > 1,
            }
        });

    } catch (error) {
        console.error('❌ [SERVICE_CATEGORY_CONTROLLER] Error in getParentCategories:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve parent categories. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET SUBCATEGORIES BY PARENT ID (with pagination)
// GET /api/services/categories/:parentId/subcategories
// ═══════════════════════════════════════════════════════════════════════

exports.getSubcategories = async (req, res) => {
    try {
        const { parentId } = req.params;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;

        if (!parentId || isNaN(parentId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid parent category ID. Please provide a valid numeric ID.',
            });
        }

        const parentCategory = await ServiceCategory.findByPk(parentId);
        if (!parentCategory) {
            return res.status(404).json({
                success: false,
                message: 'Parent category not found.',
            });
        }

        const { count, rows: categories } = await ServiceCategory.findAndCountAll({
            where: {
                parent_id: parentId,
                status: 'active',
            },
            limit,
            offset,
            order: [['display_order', 'ASC'], ['name_en', 'ASC']],
        });

        // ─────────────────────────────────────────────────────────────────
        // GET ACTIVE LISTING COUNTS FOR THESE SUBCATEGORIES
        // ─────────────────────────────────────────────────────────────────

        const subcategoryIds = categories.map(cat => cat.id);

        const listingCounts = await ServiceListing.findAll({
            where: {
                category_id: subcategoryIds,
                status: 'active',
            },
            attributes: [
                'category_id',
                [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'count']
            ],
            group: ['category_id'],
            raw: true,
        });

        const countMap = {};
        listingCounts.forEach(row => {
            countMap[row.category_id] = parseInt(row.count);
        });

        const result = categories.map(cat => ({
            id: cat.id,
            name_en: cat.name_en,
            name_fr: cat.name_fr,
            description_en: cat.description_en,
            description_fr: cat.description_fr,
            icon_url: cat.icon_url,
            parent_id: cat.parent_id,
            display_order: cat.display_order,
            is_active: cat.status === 'active',
            active_listings_count: countMap[cat.id] || 0,
            created_at: cat.created_at,
            updated_at: cat.updated_at,
        }));

        const totalPages = Math.ceil(count / limit);

        res.status(200).json({
            success: true,
            message: 'Subcategories retrieved successfully',
            data: { categories: result },
            pagination: {
                total: count,
                page,
                limit,
                totalPages,
                hasNext: page < totalPages,
                hasPrev: page > 1,
            }
        });

    } catch (error) {
        console.error('❌ [SERVICE_CATEGORY_CONTROLLER] Error in getSubcategories:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve subcategories. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// TOGGLE CATEGORY STATUS (Admin/Employee only)
// PATCH /api/services/categories/:id/toggle-status
// ═══════════════════════════════════════════════════════════════════════

exports.toggleStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { is_active } = req.body;

        console.log('🔄 [SERVICE_CATEGORY] Toggling category status...');
        console.log('   Category ID:', id);
        console.log('   New is_active value:', is_active);

        // Validate ID
        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid category ID. Please provide a valid numeric ID.',
            });
        }

        // Validate is_active field
        if (is_active === undefined || is_active === null) {
            return res.status(400).json({
                success: false,
                message: 'is_active field is required. Please provide true or false.',
            });
        }

        // Find category
        const category = await ServiceCategory.findByPk(id);

        if (!category) {
            return res.status(404).json({
                success: false,
                message: 'Category not found.',
            });
        }

        // ✅ FIX: Use status ENUM ('active'/'inactive') not a boolean field
        const newStatus = is_active === true || is_active === 'true' ? 'active' : 'inactive';

        await category.update({ status: newStatus });

        console.log('✅ [SERVICE_CATEGORY] Status toggled successfully');
        console.log('   Category:', category.name_en);
        console.log('   New Status:', category.status);

        res.status(200).json({
            success: true,
            message: `Category ${newStatus === 'active' ? 'activated' : 'deactivated'} successfully`,
            data: {
                id: category.id,
                name_en: category.name_en,
                name_fr: category.name_fr,
                status: category.status,
                is_active: category.status === 'active',
                updated_at: category.updated_at,
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_CATEGORY] Error in toggleStatus:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to update category status. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};


module.exports = exports;