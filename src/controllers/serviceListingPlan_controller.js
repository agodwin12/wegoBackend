'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE LISTING PLAN CONTROLLER
// controllers/serviceListingPlan_controller.js
//
// Backoffice-only. Admins manage the plan pricing table here.
//
// ENDPOINTS (all under /api/services/admin/plans):
//   GET    /                → getAllPlans       (all plans including inactive)
//   GET    /:id             → getPlanById
//   POST   /                → createPlan
//   PUT    /:id             → updatePlan
//   PATCH  /:id/toggle      → togglePlanStatus  (activate / deactivate)
//   DELETE /:id             → deletePlan        (only if no payments reference it)
//
// NOTE: The public GET /api/services/plans (active plans only) is handled by
//       serviceAdPayment_controller.getAvailablePlans — not this controller.
//       This controller is for the backoffice plan management screen.
// ═══════════════════════════════════════════════════════════════════════════════

const { ServiceListingPlan, ServiceAdPayment } = require('../models');
const { Op } = require('sequelize');

// ─────────────────────────────────────────────────────────────────────────────
// GET ALL PLANS (Backoffice — includes inactive)
// GET /api/services/admin/plans
// ─────────────────────────────────────────────────────────────────────────────

exports.getAllPlans = async (req, res) => {
    try {
        const plans = await ServiceListingPlan.findAll({
            order: [['display_order', 'ASC'], ['price_xaf', 'ASC']],
            include: [
                { association: 'creator', attributes: ['id', 'first_name', 'last_name', 'email'] },
                { association: 'updater', attributes: ['id', 'first_name', 'last_name', 'email'] },
            ],
        });

        // Attach usage count to each plan
        const planIds = plans.map(p => p.id);
        const usageCounts = await ServiceAdPayment.findAll({
            where:      { plan_id: planIds },
            attributes: ['plan_id', [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'count']],
            group:      ['plan_id'],
            raw:        true,
        });

        const usageMap = {};
        usageCounts.forEach(row => { usageMap[row.plan_id] = parseInt(row.count); });

        const result = plans.map(plan => ({
            ...plan.toJSON(),
            total_activations: usageMap[plan.id] || 0,
        }));

        return res.status(200).json({
            success: true,
            message: 'Plans retrieved successfully',
            data:    { plans: result },
        });

    } catch (err) {
        console.error('❌ [PLAN_CTRL] getAllPlans error:', err.message);
        return res.status(500).json({ success: false, message: 'Unable to retrieve plans.' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET PLAN BY ID
// GET /api/services/admin/plans/:id
// ─────────────────────────────────────────────────────────────────────────────

exports.getPlanById = async (req, res) => {
    try {
        const { id } = req.params;

        if (!id || isNaN(id)) {
            return res.status(400).json({ success: false, message: 'Invalid plan ID.' });
        }

        const plan = await ServiceListingPlan.findByPk(id, {
            include: [
                { association: 'creator', attributes: ['id', 'first_name', 'last_name', 'email'] },
                { association: 'updater', attributes: ['id', 'first_name', 'last_name', 'email'] },
            ],
        });

        if (!plan) {
            return res.status(404).json({ success: false, message: 'Plan not found.' });
        }

        const totalActivations = await ServiceAdPayment.count({ where: { plan_id: id } });
        const activeNow        = await ServiceAdPayment.count({ where: { plan_id: id, status: 'active' } });

        return res.status(200).json({
            success: true,
            data: {
                plan: {
                    ...plan.toJSON(),
                    total_activations: totalActivations,
                    active_now:        activeNow,
                },
            },
        });

    } catch (err) {
        console.error('❌ [PLAN_CTRL] getPlanById error:', err.message);
        return res.status(500).json({ success: false, message: 'Unable to retrieve plan.' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// CREATE PLAN
// POST /api/services/admin/plans
// ─────────────────────────────────────────────────────────────────────────────

exports.createPlan = async (req, res) => {
    try {
        const {
            plan_key,
            label_en,
            label_fr,
            description_en,
            description_fr,
            price_xaf,
            duration_days,
            max_photos,
            is_hero_placement,
            requires_admin_approval,
            boost_priority,
            is_highlighted,
            highlight_label_en,
            highlight_label_fr,
            display_order,
        } = req.body;

        const employeeId = req.user.id;

        // ── Validation ────────────────────────────────────────────────────────
        if (!plan_key || !/^[a-z0-9_]+$/.test(plan_key)) {
            return res.status(400).json({
                success: false,
                message: 'plan_key is required and must be lowercase letters, numbers, and underscores only.',
            });
        }

        if (!label_en || label_en.trim().length < 2) {
            return res.status(400).json({
                success: false,
                message: 'English label is required (minimum 2 characters).',
            });
        }

        if (!label_fr || label_fr.trim().length < 2) {
            return res.status(400).json({
                success: false,
                message: 'French label is required (minimum 2 characters).',
            });
        }

        if (price_xaf === undefined || price_xaf === null || isNaN(price_xaf) || price_xaf < 0) {
            return res.status(400).json({
                success: false,
                message: 'price_xaf is required and must be 0 or greater.',
            });
        }

        if (!duration_days || isNaN(duration_days) || duration_days < 1 || duration_days > 365) {
            return res.status(400).json({
                success: false,
                message: 'duration_days is required and must be between 1 and 365.',
            });
        }

        // ── Duplicate plan_key check ──────────────────────────────────────────
        const existing = await ServiceListingPlan.findOne({ where: { plan_key } });
        if (existing) {
            return res.status(409).json({
                success: false,
                message: `A plan with key "${plan_key}" already exists.`,
            });
        }

        // ── Hero plan must always require admin approval ───────────────────────
        const heroPlacement    = is_hero_placement === true || is_hero_placement === 'true';
        const adminApproval    = heroPlacement ? true : (requires_admin_approval === true || requires_admin_approval === 'true');

        const plan = await ServiceListingPlan.create({
            plan_key:               plan_key.trim(),
            label_en:               label_en.trim(),
            label_fr:               label_fr.trim(),
            description_en:         description_en ? description_en.trim() : null,
            description_fr:         description_fr ? description_fr.trim() : null,
            price_xaf:              parseInt(price_xaf),
            duration_days:          parseInt(duration_days),
            max_photos:             max_photos ? parseInt(max_photos) : 3,
            is_hero_placement:      heroPlacement,
            requires_admin_approval: adminApproval,
            boost_priority:         boost_priority !== undefined ? parseInt(boost_priority) : 0,
            is_highlighted:         is_highlighted === true || is_highlighted === 'true',
            highlight_label_en:     highlight_label_en ? highlight_label_en.trim() : null,
            highlight_label_fr:     highlight_label_fr ? highlight_label_fr.trim() : null,
            display_order:          display_order !== undefined ? parseInt(display_order) : 0,
            is_active:              true,
            created_by:             employeeId,
        });

        console.log(`✅ [PLAN_CTRL] Plan created: "${plan.plan_key}" (id: ${plan.id}) by employee #${employeeId}`);

        return res.status(201).json({
            success: true,
            message: 'Plan created successfully.',
            data:    { plan },
        });

    } catch (err) {
        console.error('❌ [PLAN_CTRL] createPlan error:', err.message);

        if (err.name === 'SequelizeUniqueConstraintError') {
            return res.status(409).json({ success: false, message: 'A plan with this key already exists.' });
        }
        if (err.name === 'SequelizeValidationError') {
            return res.status(400).json({
                success: false,
                message: 'Validation error.',
                errors:  err.errors.map(e => e.message),
            });
        }

        return res.status(500).json({ success: false, message: 'Unable to create plan.' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE PLAN
// PUT /api/services/admin/plans/:id
//
// NOTE: plan_key is immutable after creation — changing it would break
//       existing ServiceAdPayment.plan_key_snapshot references.
// ─────────────────────────────────────────────────────────────────────────────

exports.updatePlan = async (req, res) => {
    try {
        const { id }     = req.params;
        const employeeId = req.user.id;

        if (!id || isNaN(id)) {
            return res.status(400).json({ success: false, message: 'Invalid plan ID.' });
        }

        const plan = await ServiceListingPlan.findByPk(id);
        if (!plan) {
            return res.status(404).json({ success: false, message: 'Plan not found.' });
        }

        const {
            label_en,
            label_fr,
            description_en,
            description_fr,
            price_xaf,
            duration_days,
            max_photos,
            is_hero_placement,
            requires_admin_approval,
            boost_priority,
            is_highlighted,
            highlight_label_en,
            highlight_label_fr,
            display_order,
        } = req.body;

        // Validate fields that are being updated
        if (label_en !== undefined && label_en.trim().length < 2) {
            return res.status(400).json({ success: false, message: 'English label must be at least 2 characters.' });
        }

        if (label_fr !== undefined && label_fr.trim().length < 2) {
            return res.status(400).json({ success: false, message: 'French label must be at least 2 characters.' });
        }

        if (price_xaf !== undefined && (isNaN(price_xaf) || price_xaf < 0)) {
            return res.status(400).json({ success: false, message: 'price_xaf must be 0 or greater.' });
        }

        if (duration_days !== undefined && (isNaN(duration_days) || duration_days < 1 || duration_days > 365)) {
            return res.status(400).json({ success: false, message: 'duration_days must be between 1 and 365.' });
        }

        // Hero plans must always require admin approval
        const heroPlacement = is_hero_placement !== undefined
            ? (is_hero_placement === true || is_hero_placement === 'true')
            : plan.is_hero_placement;

        const adminApproval = heroPlacement ? true : (
            requires_admin_approval !== undefined
                ? (requires_admin_approval === true || requires_admin_approval === 'true')
                : plan.requires_admin_approval
        );

        await plan.update({
            label_en:               label_en               !== undefined ? label_en.trim()               : plan.label_en,
            label_fr:               label_fr               !== undefined ? label_fr.trim()               : plan.label_fr,
            description_en:         description_en         !== undefined ? (description_en ? description_en.trim() : null) : plan.description_en,
            description_fr:         description_fr         !== undefined ? (description_fr ? description_fr.trim() : null) : plan.description_fr,
            price_xaf:              price_xaf              !== undefined ? parseInt(price_xaf)             : plan.price_xaf,
            duration_days:          duration_days          !== undefined ? parseInt(duration_days)         : plan.duration_days,
            max_photos:             max_photos             !== undefined ? parseInt(max_photos)            : plan.max_photos,
            is_hero_placement:      heroPlacement,
            requires_admin_approval: adminApproval,
            boost_priority:         boost_priority         !== undefined ? parseInt(boost_priority)        : plan.boost_priority,
            is_highlighted:         is_highlighted         !== undefined ? (is_highlighted === true || is_highlighted === 'true') : plan.is_highlighted,
            highlight_label_en:     highlight_label_en     !== undefined ? (highlight_label_en ? highlight_label_en.trim() : null) : plan.highlight_label_en,
            highlight_label_fr:     highlight_label_fr     !== undefined ? (highlight_label_fr ? highlight_label_fr.trim() : null) : plan.highlight_label_fr,
            display_order:          display_order          !== undefined ? parseInt(display_order)         : plan.display_order,
            updated_by:             employeeId,
        });

        console.log(`✅ [PLAN_CTRL] Plan updated: "${plan.plan_key}" (id: ${plan.id}) by employee #${employeeId}`);

        return res.status(200).json({
            success: true,
            message: 'Plan updated successfully.',
            data:    { plan },
        });

    } catch (err) {
        console.error('❌ [PLAN_CTRL] updatePlan error:', err.message);

        if (err.name === 'SequelizeValidationError') {
            return res.status(400).json({
                success: false,
                message: 'Validation error.',
                errors:  err.errors.map(e => e.message),
            });
        }

        return res.status(500).json({ success: false, message: 'Unable to update plan.' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// TOGGLE PLAN STATUS (activate / deactivate)
// PATCH /api/services/admin/plans/:id/toggle
//
// Body: { is_active: true | false }
//
// Deactivated plans are hidden from the Flutter plan picker but existing
// subscriptions already using the plan are still honored.
// ─────────────────────────────────────────────────────────────────────────────

exports.togglePlanStatus = async (req, res) => {
    try {
        const { id }       = req.params;
        const { is_active } = req.body;
        const employeeId   = req.user.id;

        if (!id || isNaN(id)) {
            return res.status(400).json({ success: false, message: 'Invalid plan ID.' });
        }

        if (is_active === undefined || is_active === null) {
            return res.status(400).json({ success: false, message: 'is_active is required (true or false).' });
        }

        const plan = await ServiceListingPlan.findByPk(id);
        if (!plan) {
            return res.status(404).json({ success: false, message: 'Plan not found.' });
        }

        const newStatus = is_active === true || is_active === 'true';

        // Safety: cannot deactivate the free plan if it is the only active free plan
        if (!newStatus && plan.plan_key === 'free') {
            const otherFreePlans = await ServiceListingPlan.count({
                where: {
                    plan_key: 'free',
                    is_active: true,
                    id:        { [Op.ne]: plan.id },
                },
            });
            if (otherFreePlans === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Cannot deactivate the only free plan. At least one free plan must remain active.',
                });
            }
        }

        await plan.update({ is_active: newStatus, updated_by: employeeId });

        console.log(`✅ [PLAN_CTRL] Plan "${plan.plan_key}" ${newStatus ? 'activated' : 'deactivated'} by employee #${employeeId}`);

        return res.status(200).json({
            success: true,
            message: `Plan ${newStatus ? 'activated' : 'deactivated'} successfully.`,
            data: {
                id:        plan.id,
                plan_key:  plan.plan_key,
                is_active: plan.is_active,
            },
        });

    } catch (err) {
        console.error('❌ [PLAN_CTRL] togglePlanStatus error:', err.message);
        return res.status(500).json({ success: false, message: 'Unable to update plan status.' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE PLAN
// DELETE /api/services/admin/plans/:id
//
// Hard delete — only allowed if no ServiceAdPayments reference this plan.
// If payments exist, deactivate via toggle instead.
// ─────────────────────────────────────────────────────────────────────────────

exports.deletePlan = async (req, res) => {
    try {
        const { id }     = req.params;
        const employeeId = req.user.id;

        if (!id || isNaN(id)) {
            return res.status(400).json({ success: false, message: 'Invalid plan ID.' });
        }

        const plan = await ServiceListingPlan.findByPk(id);
        if (!plan) {
            return res.status(404).json({ success: false, message: 'Plan not found.' });
        }

        // Block deletion if any payments reference this plan
        const paymentCount = await ServiceAdPayment.count({ where: { plan_id: id } });
        if (paymentCount > 0) {
            return res.status(400).json({
                success: false,
                message: `Cannot delete this plan — ${paymentCount} payment record(s) reference it. Deactivate it instead.`,
                code:    'PLAN_HAS_PAYMENTS',
            });
        }

        // Block deletion of the only active free plan
        if (plan.plan_key === 'free') {
            return res.status(400).json({
                success: false,
                message: 'The free plan cannot be deleted. Deactivate it if needed.',
            });
        }

        await plan.destroy();

        console.log(`✅ [PLAN_CTRL] Plan "${plan.plan_key}" (id: ${id}) deleted by employee #${employeeId}`);

        return res.status(200).json({
            success: true,
            message: 'Plan deleted successfully.',
        });

    } catch (err) {
        console.error('❌ [PLAN_CTRL] deletePlan error:', err.message);
        return res.status(500).json({ success: false, message: 'Unable to delete plan.' });
    }
};

module.exports = exports;