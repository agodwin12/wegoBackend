// src/controllers/backoffice/deliveryDisputes.controller.js

const { Op } = require('sequelize');
const { DeliveryDispute, Delivery, Account, Driver, sequelize } = require('../../models');

// ═══════════════════════════════════════════════════════════════════════════════
// GET ALL DISPUTES (paginated + filtered)
// GET /api/backoffice/delivery/disputes
// ═══════════════════════════════════════════════════════════════════════════════
exports.getDisputes = async (req, res) => {
    try {
        const {
            page     = 1,
            limit    = 20,
            status   = '',
            priority = '',
            search   = '',
        } = req.query;

        const offset = (parseInt(page) - 1) * parseInt(limit);
        const where  = {};

        if (status)   where.status   = status;
        if (priority) where.priority = priority;

        if (search) {
            where[Op.or] = [
                { dispute_code:  { [Op.like]: `%${search}%` } },
                { description:   { [Op.like]: `%${search}%` } },
            ];
        }

        const { count, rows } = await DeliveryDispute.findAndCountAll({
            where,
            include: [
                {
                    association: 'delivery',
                    attributes:  ['id', 'delivery_code', 'total_price', 'payment_method', 'status'],
                },
                {
                    association: 'filedByUser',
                    attributes:  ['uuid', 'first_name', 'last_name', 'phone_e164'],
                },
                {
                    association: 'filedByDriver',
                    attributes:  ['id', 'phone', 'userId'],
                },
                {
                    association: 'assignedTo',
                    attributes:  ['id', 'first_name', 'last_name'],
                },
            ],
            order: [
                [sequelize.literal(`FIELD(priority, 'urgent', 'high', 'medium', 'low')`)],
                [sequelize.literal(`FIELD(status, 'open', 'investigating', 'awaiting_response', 'resolved', 'closed')`)],
                ['created_at', 'DESC'],
            ],
            limit:  parseInt(limit),
            offset,
        });

        // Enrich driver names
        const enriched = await Promise.all(rows.map(async (dispute) => {
            let driverName = null;
            if (dispute.filedByDriver?.userId) {
                const acc = await Account.findOne({
                    where:      { uuid: dispute.filedByDriver.userId },
                    attributes: ['first_name', 'last_name'],
                });
                if (acc) driverName = `${acc.first_name} ${acc.last_name}`.trim();
            }
            return { ...dispute.toJSON(), driverName };
        }));

        // Summary counts
        const [openCount, investigatingCount, awaitingCount, resolvedCount] = await Promise.all([
            DeliveryDispute.count({ where: { status: 'open' } }),
            DeliveryDispute.count({ where: { status: 'investigating' } }),
            DeliveryDispute.count({ where: { status: 'awaiting_response' } }),
            DeliveryDispute.count({ where: { status: 'resolved' } }),
        ]);

        return res.json({
            success:   true,
            disputes:  enriched,
            summary: { openCount, investigatingCount, awaitingCount, resolvedCount },
            pagination: {
                total:      count,
                page:       parseInt(page),
                limit:      parseInt(limit),
                totalPages: Math.ceil(count / parseInt(limit)),
            },
        });

    } catch (error) {
        console.error('❌ [DISPUTES] getDisputes error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch disputes' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET SINGLE DISPUTE
// GET /api/backoffice/delivery/disputes/:id
// ═══════════════════════════════════════════════════════════════════════════════
exports.getDispute = async (req, res) => {
    try {
        const dispute = await DeliveryDispute.findByPk(req.params.id, {
            include: [
                {
                    association: 'delivery',
                    include: [
                        { association: 'sender', attributes: ['uuid','first_name','last_name','phone_e164','avatar_url'] },
                        { association: 'driver', attributes: ['id','phone','rating','userId'] },
                    ],
                },
                { association: 'filedByUser',  attributes: ['uuid','first_name','last_name','phone_e164','avatar_url'] },
                { association: 'filedByDriver',attributes: ['id','phone','userId'] },
                { association: 'assignedTo',   attributes: ['id','first_name','last_name','email'] },
            ],
        });

        if (!dispute) {
            return res.status(404).json({ success: false, message: 'Dispute not found' });
        }

        // Get driver account name if driver filed
        let driverAccount = null;
        if (dispute.filedByDriver?.userId) {
            driverAccount = await Account.findOne({
                where:      { uuid: dispute.filedByDriver.userId },
                attributes: ['first_name', 'last_name', 'avatar_url'],
            });
        }

        const obj = dispute.toJSON();
        if (driverAccount) obj.driverAccountName = `${driverAccount.first_name} ${driverAccount.last_name}`.trim();
        if (driverAccount) obj.driverAvatarUrl   = driverAccount.avatar_url;

        return res.json({ success: true, dispute: obj });

    } catch (error) {
        console.error('❌ [DISPUTES] getDispute error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch dispute' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// ASSIGN DISPUTE TO SELF
// PATCH /api/backoffice/delivery/disputes/:id/assign
// ═══════════════════════════════════════════════════════════════════════════════
exports.assignDispute = async (req, res) => {
    try {
        const dispute = await DeliveryDispute.findByPk(req.params.id);
        if (!dispute) return res.status(404).json({ success: false, message: 'Dispute not found' });

        if (!dispute.isOpen()) {
            return res.status(400).json({ success: false, message: 'Dispute is already resolved or closed' });
        }

        await dispute.assignTo(req.user.id);

        return res.json({
            success: true,
            message: 'Dispute assigned to you',
            dispute: { id: dispute.id, status: dispute.status, assignedTo: req.user.id },
        });

    } catch (error) {
        console.error('❌ [DISPUTES] assignDispute error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to assign dispute' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// ADD ADMIN NOTE
// PATCH /api/backoffice/delivery/disputes/:id/note
// ═══════════════════════════════════════════════════════════════════════════════
exports.addNote = async (req, res) => {
    try {
        const { note } = req.body;
        if (!note?.trim()) {
            return res.status(400).json({ success: false, message: 'Note cannot be empty' });
        }

        const dispute = await DeliveryDispute.findByPk(req.params.id);
        if (!dispute) return res.status(404).json({ success: false, message: 'Dispute not found' });

        // Append note with timestamp and admin name
        const timestamp  = new Date().toLocaleString('en-GB');
        const adminLabel = `${req.user.first_name} ${req.user.last_name} (${timestamp})`;
        const newNote    = dispute.admin_notes
            ? `${dispute.admin_notes}\n\n[${adminLabel}]\n${note.trim()}`
            : `[${adminLabel}]\n${note.trim()}`;

        await dispute.update({ admin_notes: newNote });

        return res.json({ success: true, message: 'Note added', admin_notes: newNote });

    } catch (error) {
        console.error('❌ [DISPUTES] addNote error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to add note' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// UPDATE PRIORITY
// PATCH /api/backoffice/delivery/disputes/:id/priority
// ═══════════════════════════════════════════════════════════════════════════════
exports.updatePriority = async (req, res) => {
    try {
        const { priority } = req.body;
        if (!['low','medium','high','urgent'].includes(priority)) {
            return res.status(400).json({ success: false, message: 'Invalid priority' });
        }

        const dispute = await DeliveryDispute.findByPk(req.params.id);
        if (!dispute) return res.status(404).json({ success: false, message: 'Dispute not found' });

        await dispute.update({ priority });
        return res.json({ success: true, message: 'Priority updated', priority });

    } catch (error) {
        console.error('❌ [DISPUTES] updatePriority error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to update priority' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// RESOLVE DISPUTE
// POST /api/backoffice/delivery/disputes/:id/resolve
// ═══════════════════════════════════════════════════════════════════════════════
exports.resolveDispute = async (req, res) => {
    try {
        const { resolution_type, resolution_notes, refund_amount, admin_notes } = req.body;

        if (!resolution_type || !resolution_notes) {
            return res.status(400).json({ success: false, message: 'resolution_type and resolution_notes are required' });
        }

        const dispute = await DeliveryDispute.findByPk(req.params.id);
        if (!dispute) return res.status(404).json({ success: false, message: 'Dispute not found' });

        if (!dispute.isOpen()) {
            return res.status(400).json({ success: false, message: 'Dispute is already resolved or closed' });
        }

        await dispute.resolve({
            resolutionType:  resolution_type,
            resolutionNotes: resolution_notes,
            refundAmount:    parseFloat(refund_amount || 0),
            adminNotes:      admin_notes || dispute.admin_notes,
        });

        // If resolution involves a refund, update delivery payment status
        if (['full_refund', 'partial_refund'].includes(resolution_type)) {
            await Delivery.update(
                { payment_status: 'refunded' },
                { where: { id: dispute.delivery_id } }
            );
        }

        // If driver suspended, update their account
        if (resolution_type === 'driver_suspended' && dispute.filed_by_driver_id) {
            const driver  = await Driver.findByPk(dispute.filed_by_driver_id);
            if (driver) {
                const account = await Account.findOne({ where: { uuid: driver.userId } });
                if (account) await account.update({ status: 'SUSPENDED' });
            }
        }

        return res.json({
            success:         true,
            message:         'Dispute resolved successfully',
            resolutionType:  resolution_type,
            refundAmount:    parseFloat(refund_amount || 0),
        });

    } catch (error) {
        console.error('❌ [DISPUTES] resolveDispute error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to resolve dispute' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// CLOSE DISPUTE
// POST /api/backoffice/delivery/disputes/:id/close
// ═══════════════════════════════════════════════════════════════════════════════
exports.closeDispute = async (req, res) => {
    try {
        const dispute = await DeliveryDispute.findByPk(req.params.id);
        if (!dispute) return res.status(404).json({ success: false, message: 'Dispute not found' });

        if (dispute.status !== 'resolved') {
            return res.status(400).json({ success: false, message: 'Dispute must be resolved before closing' });
        }

        await dispute.close();
        return res.json({ success: true, message: 'Dispute closed' });

    } catch (error) {
        console.error('❌ [DISPUTES] closeDispute error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to close dispute' });
    }
};