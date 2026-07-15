// src/controllers/backoffice/rideSurgeController.js
//
// Backoffice CRUD for ride-hailing surge rules. Twin of the delivery surge
// admin endpoints, but scoped by city + optional vehicle type.
//
//   GET    /api/backoffice/ride-surge          list + weekly calendar
//   GET    /api/backoffice/ride-surge/active    what's firing right now
//   POST   /api/backoffice/ride-surge          create
//   PUT    /api/backoffice/ride-surge/:id       update (also used to toggle)
//   DELETE /api/backoffice/ride-surge/:id       delete

'use strict';

const { RideSurgeRule } = require('../../models');

const VEHICLE_TYPES = ['economy', 'comfort', 'luxury'];

// GET /api/backoffice/ride-surge
exports.getSurgeRules = async (req, res) => {
    try {
        const rules = await RideSurgeRule.findAll({
            order: [['priority', 'DESC'], ['start_time', 'ASC']],
            include: [
                { association: 'createdBy', attributes: ['id', 'first_name', 'last_name'] },
            ],
        });

        const rulesWithStatus = rules.map((rule) => ({
            ...rule.toJSON(),
            isCurrentlyActive: rule.isCurrentlyActive(),
            daysLabel:         rule.getDaysLabel(),
        }));

        const calendar = await RideSurgeRule.getWeeklyCalendar();

        return res.json({ success: true, rules: rulesWithStatus, calendar });
    } catch (error) {
        console.error('❌ [RIDE SURGE] getSurgeRules error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch surge rules' });
    }
};

// GET /api/backoffice/ride-surge/active?city=Douala&vehicle_type=economy
exports.getActiveSurge = async (req, res) => {
    try {
        const { city, vehicle_type } = req.query;
        const { rule, multiplier } = await RideSurgeRule.getActiveSurge(
            city || null,
            vehicle_type || null,
        );

        return res.json({
            success:     true,
            surgeActive: multiplier > 1.00,
            multiplier,
            rule: rule ? {
                id:           rule.id,
                name:         rule.name,
                multiplier:   parseFloat(rule.multiplier),
                start_time:   rule.start_time,
                end_time:     rule.end_time,
                city:         rule.city,
                vehicle_type: rule.vehicle_type,
                daysLabel:    rule.getDaysLabel(),
            } : null,
        });
    } catch (error) {
        console.error('❌ [RIDE SURGE] getActiveSurge error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to check active surge' });
    }
};

// POST /api/backoffice/ride-surge
exports.createSurgeRule = async (req, res) => {
    try {
        const { name, description, days_of_week, start_time, end_time, multiplier, city, vehicle_type, priority, is_active } = req.body;

        if (!name || !days_of_week || !start_time || !end_time || !multiplier) {
            return res.status(400).json({ success: false, message: 'name, days_of_week, start_time, end_time, and multiplier are required' });
        }
        if (parseFloat(multiplier) < 1.00 || parseFloat(multiplier) > 3.00) {
            return res.status(400).json({ success: false, message: 'Multiplier must be between 1.00 and 3.00' });
        }
        if (vehicle_type && !VEHICLE_TYPES.includes(vehicle_type)) {
            return res.status(400).json({ success: false, message: `vehicle_type must be one of: ${VEHICLE_TYPES.join(', ')}` });
        }

        const rule = await RideSurgeRule.create({
            name,
            description:   description || null,
            days_of_week: Array.isArray(days_of_week) ? days_of_week : JSON.parse(days_of_week),
            start_time,
            end_time,
            multiplier:   parseFloat(multiplier),
            city:         city || null,
            vehicle_type: vehicle_type || null,
            priority:     parseInt(priority || 1),
            is_active:    is_active !== undefined ? is_active : true,
            created_by:   req.user.id,
        });

        return res.status(201).json({ success: true, message: 'Surge rule created', rule });
    } catch (error) {
        console.error('❌ [RIDE SURGE] createSurgeRule error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to create surge rule' });
    }
};

// PUT /api/backoffice/ride-surge/:id  (also used to toggle is_active)
exports.updateSurgeRule = async (req, res) => {
    try {
        const rule = await RideSurgeRule.findByPk(req.params.id);
        if (!rule) return res.status(404).json({ success: false, message: 'Surge rule not found' });

        if (req.body.multiplier !== undefined) {
            const m = parseFloat(req.body.multiplier);
            if (m < 1.00 || m > 3.00) {
                return res.status(400).json({ success: false, message: 'Multiplier must be between 1.00 and 3.00' });
            }
        }
        if (req.body.vehicle_type && !VEHICLE_TYPES.includes(req.body.vehicle_type)) {
            return res.status(400).json({ success: false, message: `vehicle_type must be one of: ${VEHICLE_TYPES.join(', ')}` });
        }

        const fields = ['name', 'description', 'days_of_week', 'start_time', 'end_time', 'multiplier', 'city', 'vehicle_type', 'priority', 'is_active'];
        const updates = {};
        fields.forEach((f) => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

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
        console.error('❌ [RIDE SURGE] updateSurgeRule error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to update surge rule' });
    }
};

// DELETE /api/backoffice/ride-surge/:id
exports.deleteSurgeRule = async (req, res) => {
    try {
        const rule = await RideSurgeRule.findByPk(req.params.id);
        if (!rule) return res.status(404).json({ success: false, message: 'Surge rule not found' });

        await rule.destroy();
        return res.json({ success: true, message: 'Surge rule deleted' });
    } catch (error) {
        console.error('❌ [RIDE SURGE] deleteSurgeRule error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to delete surge rule' });
    }
};
