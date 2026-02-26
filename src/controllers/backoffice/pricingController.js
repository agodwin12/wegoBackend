const PriceRule = require('../../models/PriceRule');
const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize');

// Get all price rules with pagination and filters
exports.getAllPriceRules = async (req, res) => {
    try {
        const { page = 1, limit = 10, city, status, sort = 'createdAt', order = 'DESC' } = req.query;

        const offset = (page - 1) * limit;

        const where = {};
        if (city) {
            where.city = { [Op.like]: `%${city}%` };
        }
        if (status) {
            where.status = status;
        }

        const { count, rows: priceRules } = await PriceRule.findAndCountAll({
            where,
            limit: parseInt(limit),
            offset: parseInt(offset),
            order: [[sort, order]]
            // Removed includes until columns are added to database
        });

        res.status(200).json({
            success: true,
            message: 'Price rules retrieved successfully',
            data: {
                priceRules,
                pagination: {
                    total: count,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    totalPages: Math.ceil(count / limit)
                }
            }
        });
    } catch (error) {
        console.error('❌ Error fetching price rules:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve price rules',
            error: error.message
        });
    }
};

// Get single price rule by ID
exports.getPriceRuleById = async (req, res) => {
    try {
        const { id } = req.params;

        const priceRule = await PriceRule.findByPk(id);

        if (!priceRule) {
            return res.status(404).json({
                success: false,
                message: 'Price rule not found'
            });
        }

        res.status(200).json({
            success: true,
            message: 'Price rule retrieved successfully',
            data: priceRule
        });
    } catch (error) {
        console.error('❌ Error fetching price rule:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve price rule',
            error: error.message
        });
    }
};

// Get price rule by city
exports.getPriceRuleByCity = async (req, res) => {
    try {
        const { city } = req.params;

        const priceRule = await PriceRule.findOne({
            where: {
                city: city,
                status: 'active'
            }
        });

        if (!priceRule) {
            return res.status(404).json({
                success: false,
                message: `No active price rule found for city: ${city}`
            });
        }

        res.status(200).json({
            success: true,
            message: 'Price rule retrieved successfully',
            data: priceRule
        });
    } catch (error) {
        console.error('❌ Error fetching price rule by city:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve price rule',
            error: error.message
        });
    }
};

// Create new price rule
exports.createPriceRule = async (req, res) => {
    try {
        const { city, base, per_km, per_min, min_fare, surge_mult, status = 'active' } = req.body;
        const employeeId = req.user.id;

        // Validation
        if (!city || !base || per_km === undefined || per_min === undefined || !min_fare) {
            return res.status(400).json({
                success: false,
                message: 'All required fields must be provided (city, base, per_km, per_min, min_fare)'
            });
        }

        // Check if active price rule already exists for this city
        const existingActiveRule = await PriceRule.findOne({
            where: {
                city: city,
                status: 'active'
            }
        });

        if (existingActiveRule && status === 'active') {
            return res.status(400).json({
                success: false,
                message: `An active price rule already exists for ${city}. Please deactivate it first or create this rule as inactive.`
            });
        }

        const priceRuleData = {
            id: uuidv4(),
            city,
            base,
            per_km,
            per_min,
            min_fare,
            surge_mult: surge_mult || 1.0,
            status
        };

        // Only add created_by if the column exists in database
        // Remove this check after running the migration
        // priceRuleData.created_by = employeeId;

        const priceRule = await PriceRule.create(priceRuleData);

        console.log('✅ Price rule created:', priceRule.id);

        res.status(201).json({
            success: true,
            message: 'Price rule created successfully',
            data: priceRule
        });
    } catch (error) {
        console.error('❌ Error creating price rule:', error);

        if (error.name === 'SequelizeValidationError') {
            return res.status(400).json({
                success: false,
                message: 'Validation error',
                errors: error.errors.map(e => ({
                    field: e.path,
                    message: e.message
                }))
            });
        }

        res.status(500).json({
            success: false,
            message: 'Failed to create price rule',
            error: error.message
        });
    }
};

// Update price rule
exports.updatePriceRule = async (req, res) => {
    try {
        const { id } = req.params;
        const { city, base, per_km, per_min, min_fare, surge_mult, status } = req.body;
        const employeeId = req.user.id;

        const priceRule = await PriceRule.findByPk(id);

        if (!priceRule) {
            return res.status(404).json({
                success: false,
                message: 'Price rule not found'
            });
        }

        // If activating this rule, check for other active rules in the same city
        if (status === 'active' && priceRule.status !== 'active') {
            const existingActiveRule = await PriceRule.findOne({
                where: {
                    city: city || priceRule.city,
                    status: 'active',
                    id: { [Op.ne]: id }
                }
            });

            if (existingActiveRule) {
                return res.status(400).json({
                    success: false,
                    message: `Another active price rule already exists for this city. Please deactivate it first.`
                });
            }
        }

        // Update fields
        if (city !== undefined) priceRule.city = city;
        if (base !== undefined) priceRule.base = base;
        if (per_km !== undefined) priceRule.per_km = per_km;
        if (per_min !== undefined) priceRule.per_min = per_min;
        if (min_fare !== undefined) priceRule.min_fare = min_fare;
        if (surge_mult !== undefined) priceRule.surge_mult = surge_mult;
        if (status !== undefined) priceRule.status = status;

        // Only set updated_by if column exists
        // Uncomment after running migration:
        // priceRule.updated_by = employeeId;

        await priceRule.save();

        console.log('✅ Price rule updated:', id);

        res.status(200).json({
            success: true,
            message: 'Price rule updated successfully',
            data: priceRule
        });
    } catch (error) {
        console.error('❌ Error updating price rule:', error);

        if (error.name === 'SequelizeValidationError') {
            return res.status(400).json({
                success: false,
                message: 'Validation error',
                errors: error.errors.map(e => ({
                    field: e.path,
                    message: e.message
                }))
            });
        }

        res.status(500).json({
            success: false,
            message: 'Failed to update price rule',
            error: error.message
        });
    }
};

// Delete price rule
exports.deletePriceRule = async (req, res) => {
    try {
        const { id } = req.params;

        const priceRule = await PriceRule.findByPk(id);

        if (!priceRule) {
            return res.status(404).json({
                success: false,
                message: 'Price rule not found'
            });
        }

        // Check if this is the only active rule for the city (optional business logic)
        if (priceRule.status === 'active') {
            return res.status(400).json({
                success: false,
                message: 'Cannot delete an active price rule. Please deactivate it first.'
            });
        }

        await priceRule.destroy();

        console.log('✅ Price rule deleted:', id);

        res.status(200).json({
            success: true,
            message: 'Price rule deleted successfully'
        });
    } catch (error) {
        console.error('❌ Error deleting price rule:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete price rule',
            error: error.message
        });
    }
};

// Toggle price rule status (activate/deactivate)
exports.togglePriceRuleStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const employeeId = req.user.id;

        const priceRule = await PriceRule.findByPk(id);

        if (!priceRule) {
            return res.status(404).json({
                success: false,
                message: 'Price rule not found'
            });
        }

        const newStatus = priceRule.status === 'active' ? 'inactive' : 'active';

        // If activating, check for other active rules in the same city
        if (newStatus === 'active') {
            const existingActiveRule = await PriceRule.findOne({
                where: {
                    city: priceRule.city,
                    status: 'active',
                    id: { [Op.ne]: id }
                }
            });

            if (existingActiveRule) {
                return res.status(400).json({
                    success: false,
                    message: `Another active price rule already exists for ${priceRule.city}. Please deactivate it first.`
                });
            }
        }

        priceRule.status = newStatus;
        // Uncomment after migration:
        // priceRule.updated_by = employeeId;
        await priceRule.save();

        console.log(`✅ Price rule status toggled to ${newStatus}:`, id);

        res.status(200).json({
            success: true,
            message: `Price rule ${newStatus === 'active' ? 'activated' : 'deactivated'} successfully`,
            data: priceRule
        });
    } catch (error) {
        console.error('❌ Error toggling price rule status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to toggle price rule status',
            error: error.message
        });
    }
};

// Calculate fare estimate (for testing/preview)
exports.calculateFareEstimate = async (req, res) => {
    try {
        const { city, distance_km, duration_min } = req.body;

        if (!city || !distance_km || !duration_min) {
            return res.status(400).json({
                success: false,
                message: 'City, distance_km, and duration_min are required'
            });
        }

        const priceRule = await PriceRule.findOne({
            where: {
                city: city,
                status: 'active'
            }
        });

        if (!priceRule) {
            return res.status(404).json({
                success: false,
                message: `No active price rule found for city: ${city}`
            });
        }

        const fareBreakdown = priceRule.getFareBreakdown(distance_km, duration_min);

        res.status(200).json({
            success: true,
            message: 'Fare calculated successfully',
            data: fareBreakdown
        });
    } catch (error) {
        console.error('❌ Error calculating fare:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to calculate fare',
            error: error.message
        });
    }
};

// Get all cities with active pricing
exports.getActiveCities = async (req, res) => {
    try {
        const cities = await PriceRule.findAll({
            where: {
                status: 'active'
            },
            attributes: ['city'],
            group: ['city'],
            order: [['city', 'ASC']]
        });

        const cityList = cities.map(rule => rule.city);

        res.status(200).json({
            success: true,
            message: 'Active cities retrieved successfully',
            data: cityList
        });
    } catch (error) {
        console.error('❌ Error fetching active cities:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve active cities',
            error: error.message
        });
    }
};