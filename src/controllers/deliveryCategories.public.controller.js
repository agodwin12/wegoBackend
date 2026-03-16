// src/controllers/deliveryCategories.public.controller.js
// Public endpoint — no auth needed — Flutter fetches this to populate category selector

const { DeliveryCategory } = require('../models');

// ═══════════════════════════════════════════════════════════════════════════════
// GET ACTIVE CATEGORIES (public — Flutter)
// GET /api/deliveries/categories
// ═══════════════════════════════════════════════════════════════════════════════
exports.getActiveCategories = async (req, res) => {
    try {
        const categories = await DeliveryCategory.findAll({
            where:  { is_active: true },
            order:  [['display_order', 'ASC'], ['name_en', 'ASC']],
            attributes: ['id', 'key_name', 'name_fr', 'name_en', 'emoji'],
        });

        // Shape matches what Flutter expects
        const formatted = categories.map(c => ({
            value:   c.key_name,
            label:   c.name_en,
            labelFr: c.name_fr,
            emoji:   c.emoji,
        }));

        return res.json({ success: true, categories: formatted });

    } catch (error) {
        console.error('❌ [CATEGORIES] getActiveCategories error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch categories' });
    }
};