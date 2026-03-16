// src/controllers/backoffice/deliveryAdmin.controller.js

const { Op } = require('sequelize');
const { DeliveryPricing, DeliverySurgeRule, Delivery, sequelize } = require('../../models');

// ═══════════════════════════════════════════════════════════════════════════════
// PRICING ZONES
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/services/admin/delivery/pricing
exports.getPricingZones = async (req, res) => {
    try {
        const zones = await DeliveryPricing.findAll({
            order: [['id', 'ASC']],
            include: [{ association: 'createdBy', attributes: ['id', 'first_name', 'last_name'] }],
        });

        // For each zone, count deliveries
        const zonesWithStats = await Promise.all(zones.map(async (zone) => {
            const totalDeliveries = await Delivery.count({ where: { pricing_zone_id: zone.id } });
            const completedDeliveries = await Delivery.count({ where: { pricing_zone_id: zone.id, status: 'delivered' } });
            const totalRevenue = await Delivery.sum('total_price', { where: { pricing_zone_id: zone.id, status: 'delivered' } }) || 0;
            const totalCommission = await Delivery.sum('commission_amount', { where: { pricing_zone_id: zone.id, status: 'delivered' } }) || 0;

            return {
                ...zone.toJSON(),
                stats: { totalDeliveries, completedDeliveries, totalRevenue, totalCommission },
            };
        }));

        return res.json({ success: true, zones: zonesWithStats });
    } catch (error) {
        console.error('❌ [DELIVERY ADMIN] getPricingZones error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch pricing zones' });
    }
};

// POST /api/services/admin/delivery/pricing
exports.createPricingZone = async (req, res) => {
    try {
        const {
            zone_name, zone_description,
            base_fee, per_km_rate,
            size_multiplier_small, size_multiplier_medium, size_multiplier_large,
            commission_percentage, minimum_price, max_distance_km,
            is_active,
        } = req.body;

        if (!zone_name || !base_fee || !per_km_rate || !commission_percentage) {
            return res.status(400).json({ success: false, message: 'zone_name, base_fee, per_km_rate, and commission_percentage are required' });
        }

        const zone = await DeliveryPricing.create({
            zone_name,
            zone_description:      zone_description || null,
            base_fee:              parseFloat(base_fee),
            per_km_rate:           parseFloat(per_km_rate),
            size_multiplier_small: parseFloat(size_multiplier_small || 1.00),
            size_multiplier_medium:parseFloat(size_multiplier_medium || 1.30),
            size_multiplier_large: parseFloat(size_multiplier_large || 1.70),
            commission_percentage: parseFloat(commission_percentage),
            minimum_price:         parseFloat(minimum_price || 1000),
            max_distance_km:       parseFloat(max_distance_km || 50),
            is_active:             is_active !== undefined ? is_active : true,
            created_by:            req.user.id,
        });

        return res.status(201).json({ success: true, message: 'Pricing zone created', zone });
    } catch (error) {
        console.error('❌ [DELIVERY ADMIN] createPricingZone error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to create pricing zone' });
    }
};

// PUT /api/services/admin/delivery/pricing/:id
exports.updatePricingZone = async (req, res) => {
    try {
        const zone = await DeliveryPricing.findByPk(req.params.id);
        if (!zone) return res.status(404).json({ success: false, message: 'Pricing zone not found' });

        const fields = [
            'zone_name', 'zone_description', 'base_fee', 'per_km_rate',
            'size_multiplier_small', 'size_multiplier_medium', 'size_multiplier_large',
            'commission_percentage', 'minimum_price', 'max_distance_km', 'is_active',
        ];

        const updates = {};
        fields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

        await zone.update(updates);
        return res.json({ success: true, message: 'Pricing zone updated', zone });
    } catch (error) {
        console.error('❌ [DELIVERY ADMIN] updatePricingZone error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to update pricing zone' });
    }
};

// DELETE /api/services/admin/delivery/pricing/:id
exports.deletePricingZone = async (req, res) => {
    try {
        const zone = await DeliveryPricing.findByPk(req.params.id);
        if (!zone) return res.status(404).json({ success: false, message: 'Pricing zone not found' });

        // Check if zone has deliveries
        const deliveryCount = await Delivery.count({ where: { pricing_zone_id: zone.id } });
        if (deliveryCount > 0) {
            return res.status(400).json({
                success: false,
                message: `Cannot delete — ${deliveryCount} deliveries reference this zone. Deactivate it instead.`,
            });
        }

        await zone.destroy();
        return res.json({ success: true, message: 'Pricing zone deleted' });
    } catch (error) {
        console.error('❌ [DELIVERY ADMIN] deletePricingZone error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to delete pricing zone' });
    }
};

// POST /api/services/admin/delivery/pricing/preview
// Preview price calculation with given settings (before saving)
exports.previewPrice = async (req, res) => {
    try {
        const { base_fee, per_km_rate, size_multiplier_small, size_multiplier_medium,
            size_multiplier_large, commission_percentage, minimum_price,
            distance_km, package_size, surge_multiplier } = req.body;

        const tempZone = DeliveryPricing.build({
            base_fee, per_km_rate,
            size_multiplier_small:  size_multiplier_small || 1.00,
            size_multiplier_medium: size_multiplier_medium || 1.30,
            size_multiplier_large:  size_multiplier_large || 1.70,
            commission_percentage,
            minimum_price: minimum_price || 1000,
        });

        const result = tempZone.calculatePrice(
            parseFloat(distance_km || 5),
            package_size || 'medium',
            parseFloat(surge_multiplier || 1.00)
        );

        return res.json({ success: true, preview: result });
    } catch (error) {
        console.error('❌ [DELIVERY ADMIN] previewPrice error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to calculate preview' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// SURGE RULES
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/services/admin/delivery/surge
exports.getSurgeRules = async (req, res) => {
    try {
        const rules = await DeliverySurgeRule.findAll({
            order: [['priority', 'DESC'], ['start_time', 'ASC']],
            include: [
                { association: 'pricingZone', attributes: ['id', 'zone_name'] },
                { association: 'createdBy', attributes: ['id', 'first_name', 'last_name'] },
            ],
        });

        // Mark which rules are currently active
        const rulesWithStatus = rules.map(rule => ({
            ...rule.toJSON(),
            isCurrentlyActive: rule.isCurrentlyActive(),
            daysLabel:         rule.getDaysLabel(),
        }));

        // Also return weekly calendar view
        const calendar = await DeliverySurgeRule.getWeeklyCalendar();

        return res.json({ success: true, rules: rulesWithStatus, calendar });
    } catch (error) {
        console.error('❌ [DELIVERY ADMIN] getSurgeRules error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch surge rules' });
    }
};

// POST /api/services/admin/delivery/surge
exports.createSurgeRule = async (req, res) => {
    try {
        const { name, description, days_of_week, start_time, end_time, multiplier, delivery_pricing_id, priority, is_active } = req.body;

        if (!name || !days_of_week || !start_time || !end_time || !multiplier) {
            return res.status(400).json({ success: false, message: 'name, days_of_week, start_time, end_time, and multiplier are required' });
        }

        if (parseFloat(multiplier) < 1.00 || parseFloat(multiplier) > 3.00) {
            return res.status(400).json({ success: false, message: 'Multiplier must be between 1.00 and 3.00' });
        }

        const rule = await DeliverySurgeRule.create({
            name,
            description:          description || null,
            days_of_week:         Array.isArray(days_of_week) ? days_of_week : JSON.parse(days_of_week),
            start_time,
            end_time,
            multiplier:           parseFloat(multiplier),
            delivery_pricing_id:  delivery_pricing_id || null,
            priority:             parseInt(priority || 1),
            is_active:            is_active !== undefined ? is_active : true,
            created_by:           req.user.id,
        });

        return res.status(201).json({ success: true, message: 'Surge rule created', rule });
    } catch (error) {
        console.error('❌ [DELIVERY ADMIN] createSurgeRule error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to create surge rule' });
    }
};

// PUT /api/services/admin/delivery/surge/:id
exports.updateSurgeRule = async (req, res) => {
    try {
        const rule = await DeliverySurgeRule.findByPk(req.params.id);
        if (!rule) return res.status(404).json({ success: false, message: 'Surge rule not found' });

        const fields = ['name', 'description', 'days_of_week', 'start_time', 'end_time', 'multiplier', 'delivery_pricing_id', 'priority', 'is_active'];
        const updates = {};
        fields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

        await rule.update(updates);

        return res.json({
            success: true,
            message: 'Surge rule updated',
            rule: {
                ...rule.toJSON(),
                isCurrentlyActive: rule.isCurrentlyActive(),
                daysLabel:         rule.getDaysLabel(),
            },
        });
    } catch (error) {
        console.error('❌ [DELIVERY ADMIN] updateSurgeRule error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to update surge rule' });
    }
};

// DELETE /api/services/admin/delivery/surge/:id
exports.deleteSurgeRule = async (req, res) => {
    try {
        const rule = await DeliverySurgeRule.findByPk(req.params.id);
        if (!rule) return res.status(404).json({ success: false, message: 'Surge rule not found' });

        await rule.destroy();
        return res.json({ success: true, message: 'Surge rule deleted' });
    } catch (error) {
        console.error('❌ [DELIVERY ADMIN] deleteSurgeRule error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to delete surge rule' });
    }
};

// GET /api/services/admin/delivery/surge/active
// Check what surge is active RIGHT NOW — used for the live indicator in backoffice
exports.getActiveSurge = async (req, res) => {
    try {
        const { zone_id } = req.query;
        const { rule, multiplier } = await DeliverySurgeRule.getActiveSurge(zone_id ? parseInt(zone_id) : null);

        return res.json({
            success: true,
            surgeActive: multiplier > 1.00,
            multiplier,
            rule: rule ? {
                id:         rule.id,
                name:       rule.name,
                multiplier: parseFloat(rule.multiplier),
                start_time: rule.start_time,
                end_time:   rule.end_time,
                daysLabel:  rule.getDaysLabel(),
            } : null,
        });
    } catch (error) {
        console.error('❌ [DELIVERY ADMIN] getActiveSurge error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to check active surge' });
    }
};