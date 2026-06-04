// src/controllers/backoffice/broadcast_controller.js
'use strict';

//
// ═══════════════════════════════════════════════════════════════════════
// BROADCAST CONTROLLER — Backoffice mass notification management
// ═══════════════════════════════════════════════════════════════════════
//
// Endpoints:
//   POST   /api/backoffice/broadcasts           — create (immediate or scheduled)
//   GET    /api/backoffice/broadcasts           — list all broadcasts
//   GET    /api/backoffice/broadcasts/:id       — single broadcast detail
//   DELETE /api/backoffice/broadcasts/:id       — cancel a scheduled broadcast
//
// ═══════════════════════════════════════════════════════════════════════

const { Op } = require('sequelize');
const BroadcastMessage   = require('../../models/BroadcastMessage');
const NotificationService = require('../../services/NotificationService');

// ═══════════════════════════════════════════════════════════════════════
// CREATE BROADCAST
// POST /api/backoffice/broadcasts
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   POST /api/backoffice/broadcasts
 * @desc    Create a new broadcast. If scheduled_at is in the future the
 *          broadcast is saved as SCHEDULED and the cron picks it up.
 *          If scheduled_at is null or in the past it fires immediately.
 * @access  Backoffice — super_admin, admin, manager
 */
exports.createBroadcast = async (req, res) => {
    try {
        const employeeId             = req.user.id;
        const { title, body, target_type, data, scheduled_at } = req.body;

        console.log(`📢 [BROADCAST] Creating broadcast by employee ${employeeId} → ${target_type}`);

        // ── Determine if immediate or scheduled ───────────────────────
        const isScheduled = scheduled_at && new Date(scheduled_at) > new Date();

        const broadcast = await BroadcastMessage.create({
            title,
            body,
            target_type,
            data:         data || null,
            status:       'SCHEDULED',
            scheduled_at: isScheduled ? new Date(scheduled_at) : null,
            created_by:   employeeId,
        });

        console.log(`✅ [BROADCAST] Broadcast #${broadcast.id} created — ${isScheduled ? `scheduled for ${scheduled_at}` : 'sending immediately'}`);

        // ── Fire immediately if not scheduled ─────────────────────────
        if (!isScheduled) {
            // Fire and forget — don't block the HTTP response
            NotificationService.sendBroadcast(broadcast).catch(err => {
                console.error(`❌ [BROADCAST] Immediate fan-out failed for #${broadcast.id}:`, err.message);
            });
        }

        return res.status(201).json({
            success: true,
            message: isScheduled
                ? `Broadcast scheduled for ${new Date(scheduled_at).toISOString()}.`
                : 'Broadcast is being sent now.',
            data: {
                id:           broadcast.id,
                title:        broadcast.title,
                target_type:  broadcast.target_type,
                status:       broadcast.status,
                scheduled_at: broadcast.scheduled_at,
                created_at:   broadcast.created_at,
            },
        });

    } catch (error) {
        console.error('❌ [BROADCAST] createBroadcast error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to create broadcast.',
            error:   process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// LIST BROADCASTS
// GET /api/backoffice/broadcasts
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   GET /api/backoffice/broadcasts
 * @desc    Paginated list of all broadcasts, newest first.
 *          Filterable by status and target_type.
 * @access  Backoffice — all roles
 * @query   page, limit, status, target_type
 */
exports.listBroadcasts = async (req, res) => {
    try {
        const page  = Math.max(1, parseInt(req.query.page)  || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const offset = (page - 1) * limit;

        // ── Optional filters ──────────────────────────────────────────
        const where = {};
        if (req.query.status)      where.status      = req.query.status;
        if (req.query.target_type) where.target_type = req.query.target_type;

        const { count, rows } = await BroadcastMessage.findAndCountAll({
            where,
            order:   [['created_at', 'DESC']],
            limit,
            offset,
        });

        return res.status(200).json({
            success: true,
            data: {
                broadcasts: rows,
                pagination: {
                    total:       count,
                    page,
                    limit,
                    total_pages: Math.ceil(count / limit),
                    has_next:    page * limit < count,
                },
            },
        });

    } catch (error) {
        console.error('❌ [BROADCAST] listBroadcasts error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch broadcasts.',
            error:   process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET SINGLE BROADCAST
// GET /api/backoffice/broadcasts/:id
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   GET /api/backoffice/broadcasts/:id
 * @desc    Full detail of a single broadcast including creator info.
 * @access  Backoffice — all roles
 */
exports.getBroadcast = async (req, res) => {
    try {
        const { id } = req.params;

        const broadcast = await BroadcastMessage.findByPk(id);

        if (!broadcast) {
            return res.status(404).json({
                success: false,
                message: 'Broadcast not found.',
            });
        }

        return res.status(200).json({
            success: true,
            data: broadcast,
        });

    } catch (error) {
        console.error('❌ [BROADCAST] getBroadcast error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch broadcast.',
            error:   process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// CANCEL BROADCAST
// DELETE /api/backoffice/broadcasts/:id
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   DELETE /api/backoffice/broadcasts/:id
 * @desc    Cancel a scheduled broadcast. Only SCHEDULED broadcasts can
 *          be cancelled — SENT and already-cancelled ones cannot.
 * @access  Backoffice — super_admin, admin, manager
 */
exports.cancelBroadcast = async (req, res) => {
    try {
        const employeeId = req.user.id;
        const { id }     = req.params;

        const broadcast = await BroadcastMessage.findByPk(id);

        if (!broadcast) {
            return res.status(404).json({
                success: false,
                message: 'Broadcast not found.',
            });
        }

        if (!broadcast.isCancellable) {
            return res.status(400).json({
                success: false,
                message: `Broadcast cannot be cancelled — current status is "${broadcast.status}".`,
            });
        }

        await broadcast.update({
            status:       'CANCELLED',
            cancelled_by: employeeId,
            cancelled_at: new Date(),
        });

        console.log(`✅ [BROADCAST] Broadcast #${id} cancelled by employee ${employeeId}`);

        return res.status(200).json({
            success: true,
            message: 'Broadcast cancelled successfully.',
        });

    } catch (error) {
        console.error('❌ [BROADCAST] cancelBroadcast error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to cancel broadcast.',
            error:   process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};