// src/controllers/backoffice/deliveryCategories.controller.js

const { DeliveryCategory, sequelize } = require('../../models');
const { Op } = require('sequelize');

// ═══════════════════════════════════════════════════════════════════════════════
// GET ALL CATEGORIES (backoffice)
// GET /api/backoffice/delivery/categories
// ═══════════════════════════════════════════════════════════════════════════════
exports.getCategories = async (req, res) => {
    try {
        const categories = await DeliveryCategory.findAll({
            order: [
                ['display_order', 'ASC'],
                ['name_en',       'ASC'],
            ],
            include: [
                {
                    association: 'createdByEmployee',
                    attributes:  ['id', 'first_name', 'last_name'],
                    required:    false,
                },
            ],
        });

        return res.json({ success: true, categories });

    } catch (error) {
        console.error('❌ [DELIVERY CATEGORIES] getCategories error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch categories' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// CREATE CATEGORY
// POST /api/backoffice/delivery/categories
// ═══════════════════════════════════════════════════════════════════════════════
exports.createCategory = async (req, res) => {
    try {
        const {
            key_name,
            name_fr,
            name_en,
            emoji,
            display_order,
        } = req.body;

        if (!key_name || !name_fr || !name_en) {
            return res.status(400).json({
                success: false,
                message: 'key_name, name_fr, and name_en are required',
            });
        }

        // Normalize key_name: lowercase, spaces → underscores
        const normalizedKey = key_name.trim().toLowerCase().replace(/\s+/g, '_');

        // Check uniqueness
        const existing = await DeliveryCategory.findOne({ where: { key_name: normalizedKey } });
        if (existing) {
            return res.status(409).json({
                success: false,
                message: `A category with key "${normalizedKey}" already exists`,
            });
        }

        const category = await DeliveryCategory.create({
            key_name:      normalizedKey,
            name_fr:       name_fr.trim(),
            name_en:       name_en.trim(),
            emoji:         emoji?.trim() || '📦',
            is_active:     true,
            display_order: display_order ? parseInt(display_order) : 99,
            created_by:    req.user.id,
        });

        console.log(`✅ [DELIVERY CATEGORIES] Created: ${normalizedKey} by employee ${req.user.id}`);

        return res.status(201).json({
            success:  true,
            message:  `Category "${name_en}" created successfully`,
            category,
        });

    } catch (error) {
        // Sequelize validation errors
        if (error.name === 'SequelizeValidationError') {
            return res.status(400).json({
                success: false,
                message: error.errors[0]?.message || 'Validation error',
            });
        }
        console.error('❌ [DELIVERY CATEGORIES] createCategory error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to create category' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// UPDATE CATEGORY
// PUT /api/backoffice/delivery/categories/:id
// ═══════════════════════════════════════════════════════════════════════════════
exports.updateCategory = async (req, res) => {
    try {
        const { id } = req.params;
        const { name_fr, name_en, emoji, display_order } = req.body;

        const category = await DeliveryCategory.findByPk(id);
        if (!category) {
            return res.status(404).json({ success: false, message: 'Category not found' });
        }

        const updates = {};
        if (name_fr       !== undefined) updates.name_fr       = name_fr.trim();
        if (name_en       !== undefined) updates.name_en       = name_en.trim();
        if (emoji         !== undefined) updates.emoji         = emoji.trim();
        if (display_order !== undefined) updates.display_order = parseInt(display_order);

        await category.update(updates);

        console.log(`✅ [DELIVERY CATEGORIES] Updated: ${category.key_name} by employee ${req.user.id}`);

        return res.json({
            success:  true,
            message:  'Category updated',
            category,
        });

    } catch (error) {
        console.error('❌ [DELIVERY CATEGORIES] updateCategory error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to update category' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// TOGGLE ACTIVE STATUS
// PATCH /api/backoffice/delivery/categories/:id/toggle
// ═══════════════════════════════════════════════════════════════════════════════
exports.toggleCategory = async (req, res) => {
    try {
        const { id } = req.params;

        const category = await DeliveryCategory.findByPk(id);
        if (!category) {
            return res.status(404).json({ success: false, message: 'Category not found' });
        }

        // Prevent deactivating the last active category
        if (category.is_active) {
            const activeCount = await DeliveryCategory.count({ where: { is_active: true } });
            if (activeCount <= 1) {
                return res.status(400).json({
                    success: false,
                    message: 'Cannot deactivate the last active category',
                });
            }
        }

        await category.update({ is_active: !category.is_active });

        const action = category.is_active ? 'activated' : 'deactivated';
        console.log(`✅ [DELIVERY CATEGORIES] ${action}: ${category.key_name} by employee ${req.user.id}`);

        return res.json({
            success:   true,
            message:   `Category ${action}`,
            is_active: category.is_active,
        });

    } catch (error) {
        console.error('❌ [DELIVERY CATEGORIES] toggleCategory error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to toggle category' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// REORDER CATEGORIES
// POST /api/backoffice/delivery/categories/reorder
// Body: { orders: [{ id: 1, display_order: 1 }, { id: 2, display_order: 2 }, ...] }
// ═══════════════════════════════════════════════════════════════════════════════
exports.reorderCategories = async (req, res) => {
    try {
        const { orders } = req.body;

        if (!Array.isArray(orders) || orders.length === 0) {
            return res.status(400).json({ success: false, message: 'orders array is required' });
        }

        const t = await sequelize.transaction();
        try {
            await Promise.all(
                orders.map(({ id, display_order }) =>
                    DeliveryCategory.update(
                        { display_order: parseInt(display_order) },
                        { where: { id }, transaction: t }
                    )
                )
            );
            await t.commit();
        } catch (err) {
            await t.rollback();
            throw err;
        }

        return res.json({ success: true, message: 'Categories reordered' });

    } catch (error) {
        console.error('❌ [DELIVERY CATEGORIES] reorderCategories error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to reorder categories' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE CATEGORY
// DELETE /api/backoffice/delivery/categories/:id
// Only allowed if no deliveries use this category
// ═══════════════════════════════════════════════════════════════════════════════
exports.deleteCategory = async (req, res) => {
    try {
        const { id } = req.params;

        const category = await DeliveryCategory.findByPk(id);
        if (!category) {
            return res.status(404).json({ success: false, message: 'Category not found' });
        }

        // Check if any deliveries use this category
        const { Delivery } = require('../../models');
        const usageCount = await Delivery.count({
            where: { package_category: category.key_name },
        });

        if (usageCount > 0) {
            return res.status(400).json({
                success: false,
                message: `Cannot delete — ${usageCount} delivery${usageCount > 1 ? 'ies' : ''} use this category. Deactivate it instead.`,
            });
        }

        await category.destroy();
        console.log(`✅ [DELIVERY CATEGORIES] Deleted: ${category.key_name} by employee ${req.user.id}`);

        return res.json({ success: true, message: 'Category deleted' });

    } catch (error) {
        console.error('❌ [DELIVERY CATEGORIES] deleteCategory error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to delete category' });
    }
};