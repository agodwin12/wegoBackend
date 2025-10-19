const { VehicleCategory } = require('../../models');
const { v4: uuidv4 } = require('uuid');
const Joi = require('joi');

/**
 * Validation schema
 */
const categorySchema = Joi.object({
    name: Joi.string().max(64).required(),
    description: Joi.string().allow(null, ''),
    sortOrder: Joi.number().integer().min(0).default(0),
    isActive: Joi.boolean().default(true)
});

/**
 * Create category
 */
async function createCategory(req, res, next) {
    try {
        console.log("Incoming request to createCategory:", req.body);

        const { error, value } = categorySchema.validate(req.body, { stripUnknown: true });
        if (error) {
            console.log("Validation error in createCategory:", error.details);
            return res.status(400).json({ error: error.details[0].message });
        }

        const slug = value.name.toLowerCase().replace(/\s+/g, '-');

        const category = await VehicleCategory.create({
            id: uuidv4(),
            name: value.name,
            slug,
            description: value.description,
            sortOrder: value.sortOrder,
            isActive: value.isActive
        });

        console.log("Category created:", category.toJSON());
        res.json({ message: 'Category created successfully', category });
    } catch (err) {
        console.error("Error in createCategory:", err);
        next(err);
    }
}

/**
 * List all categories
 */
async function listCategories(req, res, next) {
    try {
        console.log("Fetching categories...");
        const categories = await VehicleCategory.findAll({ order: [['sortOrder', 'ASC']] });
        res.json(categories);
    } catch (err) {
        console.error("Error in listCategories:", err);
        next(err);
    }
}

/**
 * Get single category
 */
async function getCategory(req, res, next) {
    try {
        const category = await VehicleCategory.findByPk(req.params.id);
        if (!category) return res.status(404).json({ error: 'Category not found' });
        res.json(category);
    } catch (err) {
        console.error("Error in getCategory:", err);
        next(err);
    }
}

/**
 * Update category
 */
async function updateCategory(req, res, next) {
    try {
        console.log("Updating category:", req.params.id);

        const category = await VehicleCategory.findByPk(req.params.id);
        if (!category) return res.status(404).json({ error: 'Category not found' });

        const { error, value } = categorySchema.validate(req.body, { stripUnknown: true });
        if (error) {
            console.log("Validation error in updateCategory:", error.details);
            return res.status(400).json({ error: error.details[0].message });
        }

        if (value.name) {
            value.slug = value.name.toLowerCase().replace(/\s+/g, '-');
        }

        await category.update(value);

        console.log("Category updated:", category.toJSON());
        res.json({ message: 'Category updated successfully', category });
    } catch (err) {
        console.error("Error in updateCategory:", err);
        next(err);
    }
}

/**
 * Delete category
 */
async function deleteCategory(req, res, next) {
    try {
        console.log("Deleting category:", req.params.id);

        const category = await VehicleCategory.findByPk(req.params.id);
        if (!category) return res.status(404).json({ error: 'Category not found' });

        await category.destroy();

        console.log("Category deleted:", req.params.id);
        res.json({ message: 'Category deleted successfully' });
    } catch (err) {
        console.error("Error in deleteCategory:", err);
        next(err);
    }
}

module.exports = {
    createCategory,
    listCategories,
    getCategory,
    updateCategory,
    deleteCategory
};
