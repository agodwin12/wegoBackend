// src/controllers/notification_controller.js
'use strict';

//
// ═══════════════════════════════════════════════════════════════════════
// NOTIFICATION CONTROLLER — User notification inbox
// ═══════════════════════════════════════════════════════════════════════
//
// Endpoints:
//   GET    /api/notifications                — paginated inbox list
//   GET    /api/notifications/unread-count   — badge count for Flutter nav bar
//   PATCH  /api/notifications/:id/read       — mark single notification as read
//   PATCH  /api/notifications/read-all       — mark all as read
//
// ═══════════════════════════════════════════════════════════════════════

const { Op } = require('sequelize');
const Notification = require('../models/Notification');

// ═══════════════════════════════════════════════════════════════════════
// GET INBOX
// GET /api/notifications
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   GET /api/notifications
 * @desc    Paginated list of notifications for the authenticated user.
 *          Only returns non-expired notifications, newest first.
 * @access  Private
 * @query   page     (default 1)
 * @query   limit    (default 20, max 50)
 * @query   unread   (optional boolean — filter to unread only)
 */
exports.getInbox = async (req, res) => {
    try {
        const accountUuid = req.user.uuid;

        // ── Pagination ────────────────────────────────────────────────
        const page  = Math.max(1, parseInt(req.query.page)  || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const offset = (page - 1) * limit;

        // ── Optional unread filter ────────────────────────────────────
        const where = {
            account_uuid: accountUuid,
            expires_at:   { [Op.gt]: new Date() },
        };

        if (req.query.unread === 'true') {
            where.is_read = false;
        }

        const { count, rows } = await Notification.findAndCountAll({
            where,
            order:  [['created_at', 'DESC']],
            limit,
            offset,
            attributes: [
                'id', 'title', 'body', 'type', 'data',
                'is_read', 'read_at', 'created_at', 'expires_at',
            ],
        });

        console.log(`✅ [NOTIFICATIONS] Fetched ${rows.length} notifications for account ${accountUuid}`);

        return res.status(200).json({
            success: true,
            data: {
                notifications: rows,
                pagination: {
                    total:        count,
                    page,
                    limit,
                    total_pages:  Math.ceil(count / limit),
                    has_next:     page * limit < count,
                },
            },
        });

    } catch (error) {
        console.error('❌ [NOTIFICATIONS] getInbox error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch notifications.',
            error:   process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET UNREAD COUNT
// GET /api/notifications/unread-count
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   GET /api/notifications/unread-count
 * @desc    Returns the unread notification count for the nav bar badge.
 *          Flutter polls or calls this after receiving a push.
 * @access  Private
 */
exports.getUnreadCount = async (req, res) => {
    try {
        const accountUuid = req.user.uuid;

        const count = await Notification.unreadCount(accountUuid);

        return res.status(200).json({
            success: true,
            data: { unread_count: count },
        });

    } catch (error) {
        console.error('❌ [NOTIFICATIONS] getUnreadCount error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch unread count.',
            error:   process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// MARK SINGLE AS READ
// PATCH /api/notifications/:id/read
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   PATCH /api/notifications/:id/read
 * @desc    Mark a single notification as read.
 *          Scoped to the authenticated user — cannot mark another user's notification.
 * @access  Private
 */
exports.markAsRead = async (req, res) => {
    try {
        const accountUuid = req.user.uuid;
        const { id }      = req.params;

        const notification = await Notification.findOne({
            where: {
                id,
                account_uuid: accountUuid,
            },
        });

        if (!notification) {
            return res.status(404).json({
                success: false,
                message: 'Notification not found.',
            });
        }

        await notification.markAsRead();

        console.log(`✅ [NOTIFICATIONS] Marked as read: ${id} for account ${accountUuid}`);

        return res.status(200).json({
            success: true,
            message: 'Notification marked as read.',
        });

    } catch (error) {
        console.error('❌ [NOTIFICATIONS] markAsRead error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to mark notification as read.',
            error:   process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// MARK ALL AS READ
// PATCH /api/notifications/read-all
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   PATCH /api/notifications/read-all
 * @desc    Mark all unread notifications as read for the authenticated user.
 * @access  Private
 */
exports.markAllAsRead = async (req, res) => {
    try {
        const accountUuid = req.user.uuid;

        const [affectedRows] = await Notification.markAllRead(accountUuid);

        console.log(`✅ [NOTIFICATIONS] Marked ${affectedRows} notification(s) as read for account ${accountUuid}`);

        return res.status(200).json({
            success: true,
            message: 'All notifications marked as read.',
            data:    { updated: affectedRows },
        });

    } catch (error) {
        console.error('❌ [NOTIFICATIONS] markAllAsRead error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to mark all notifications as read.',
            error:   process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};