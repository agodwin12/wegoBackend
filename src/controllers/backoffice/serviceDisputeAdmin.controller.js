// backend/src/controllers/backoffice/serviceDisputeAdmin.controller.js
// Service Dispute Admin Controller - Backoffice Dispute Management

const {
    ServiceDispute,
    ServiceRequest,
    ServiceListing,
    ServiceCategory,
    Account,
    Employee,
} = require('../../models');
const { Op } = require('sequelize');
const sequelize = require('sequelize');

// ═══════════════════════════════════════════════════════════════════════
// GET ALL DISPUTES (Admin - List with filters)
// GET /api/services/admin/disputes
// ═══════════════════════════════════════════════════════════════════════

exports.getAllDisputes = async (req, res) => {
    try {
        const {
            status,
            dispute_type,
            search,
            page = 1,
            limit = 20,
            sort_by = 'created_at',
            sort_order = 'DESC',
            priority,
            assigned_to,
        } = req.query;

        console.log('🔍 [DISPUTE_ADMIN] Fetching all disputes...');
        console.log('   Filters:', { status, dispute_type, search, priority, assigned_to });

        // ─────────────────────────────────────────────────────────────────
        // BUILD WHERE CLAUSE
        // ─────────────────────────────────────────────────────────────────

        const whereClause = {};

        // Status filter
        if (status) {
            whereClause.status = status;
        }

        // Dispute type filter
        if (dispute_type) {
            whereClause.dispute_type = dispute_type;
        }

        // Priority filter
        if (priority) {
            whereClause.priority = priority;
        }

        // Assigned to filter
        if (assigned_to) {
            whereClause.assigned_to = assigned_to === 'unassigned' ? null : parseInt(assigned_to);
        }

        // Search filter (dispute ID, issue description)
        if (search) {
            whereClause[Op.or] = [
                { dispute_id: { [Op.like]: `%${search}%` } },
                { description: { [Op.like]: `%${search}%` } },
            ];
        }

        // ─────────────────────────────────────────────────────────────────
        // PAGINATION
        // ─────────────────────────────────────────────────────────────────

        const offset = (parseInt(page) - 1) * parseInt(limit);

        // ─────────────────────────────────────────────────────────────────
        // FETCH DISPUTES
        // ─────────────────────────────────────────────────────────────────

        const { count, rows: disputes } = await ServiceDispute.findAndCountAll({
            where: whereClause,
            include: [
                {
                    model: ServiceRequest,
                    as: 'request',
                    attributes: ['request_id', 'final_amount', 'payment_method', 'status'],
                    include: [
                        {
                            model: ServiceListing,
                            as: 'listing',
                            attributes: ['listing_id', 'title'],
                            include: [
                                {
                                    model: ServiceCategory,
                                    as: 'category',
                                    attributes: ['name_en', 'name_fr'],
                                }
                            ]
                        }
                    ]
                },
                {
                    model: Account,
                    as: 'filer', // ✅ FIXED: Use correct alias from model
                    attributes: ['uuid', 'first_name', 'last_name', 'email', 'phone_e164', 'avatar_url'],
                },
                {
                    model: Account,
                    as: 'defendant', // ✅ FIXED: Use correct alias from model
                    attributes: ['uuid', 'first_name', 'last_name', 'email', 'phone_e164', 'avatar_url'],
                },
                {
                    model: Employee,
                    as: 'assignedEmployee', // ✅ FIXED: Use correct alias from model
                    attributes: ['id', 'first_name', 'last_name', 'email', 'role'],
                },
                {
                    model: Employee,
                    as: 'resolver', // ✅ FIXED: Use correct alias from model
                    attributes: ['id', 'first_name', 'last_name', 'email', 'role'],
                },
            ],
            order: [[sort_by, sort_order]],
            limit: parseInt(limit),
            offset: offset,
        });

        console.log(`✅ [DISPUTE_ADMIN] Found ${count} disputes`);

        res.status(200).json({
            success: true,
            message: 'Disputes retrieved successfully',
            data: {
                disputes,
                pagination: {
                    total: count,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total_pages: Math.ceil(count / parseInt(limit)),
                }
            }
        });

    } catch (error) {
        console.error('❌ [DISPUTE_ADMIN] Error in getAllDisputes:', error);
        console.error('Stack trace:', error.stack);

        res.status(500).json({
            success: false,
            message: 'Unable to fetch disputes. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET SINGLE DISPUTE DETAILS (Admin)
// GET /api/services/admin/disputes/:dispute_id
// ═══════════════════════════════════════════════════════════════════════

exports.getDisputeDetails = async (req, res) => {
    try {
        const { dispute_id } = req.params;

        console.log(`🔍 [DISPUTE_ADMIN] Fetching dispute details: ${dispute_id}`);

        const dispute = await ServiceDispute.findOne({
            where: { dispute_id },
            include: [
                {
                    model: ServiceRequest,
                    as: 'request',
                    include: [
                        {
                            model: ServiceListing,
                            as: 'listing',
                            include: [
                                {
                                    model: ServiceCategory,
                                    as: 'category',
                                    attributes: ['name_en', 'name_fr'],
                                },
                                {
                                    model: Account,
                                    as: 'provider',
                                    attributes: ['uuid', 'first_name', 'last_name', 'email', 'phone_e164', 'avatar_url'],
                                }
                            ]
                        },
                        {
                            model: Account,
                            as: 'customer',
                            attributes: ['uuid', 'first_name', 'last_name', 'email', 'phone_e164', 'avatar_url'],
                        }
                    ]
                },
                {
                    model: Account,
                    as: 'filer', // ✅ FIXED
                    attributes: ['uuid', 'first_name', 'last_name', 'email', 'phone_e164', 'avatar_url'],
                },
                {
                    model: Account,
                    as: 'defendant', // ✅ FIXED
                    attributes: ['uuid', 'first_name', 'last_name', 'email', 'phone_e164', 'avatar_url'],
                },
                {
                    model: Employee,
                    as: 'assignedEmployee', // ✅ FIXED
                    attributes: ['id', 'first_name', 'last_name', 'email', 'role'],
                },
                {
                    model: Employee,
                    as: 'resolver', // ✅ FIXED
                    attributes: ['id', 'first_name', 'last_name', 'email', 'role'],
                },
            ],
        });

        if (!dispute) {
            console.log(`❌ [DISPUTE_ADMIN] Dispute not found: ${dispute_id}`);
            return res.status(404).json({
                success: false,
                message: 'Dispute not found',
            });
        }

        console.log(`✅ [DISPUTE_ADMIN] Dispute details retrieved: ${dispute_id}`);

        res.status(200).json({
            success: true,
            message: 'Dispute details retrieved successfully',
            data: dispute,
        });

    } catch (error) {
        console.error('❌ [DISPUTE_ADMIN] Error in getDisputeDetails:', error);
        console.error('Stack trace:', error.stack);

        res.status(500).json({
            success: false,
            message: 'Unable to fetch dispute details. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// ASSIGN DISPUTE TO EMPLOYEE
// PUT /api/services/admin/disputes/:dispute_id/assign
// ═══════════════════════════════════════════════════════════════════════

exports.assignDispute = async (req, res) => {
    try {
        const { dispute_id } = req.params;
        const { employee_id } = req.body;
        const currentEmployee = req.user;

        console.log(`👤 [DISPUTE_ADMIN] Assigning dispute ${dispute_id} to employee ${employee_id || 'self'}`);

        // ─────────────────────────────────────────────────────────────────
        // VALIDATION
        // ─────────────────────────────────────────────────────────────────

        const dispute = await ServiceDispute.findOne({ where: { dispute_id } });

        if (!dispute) {
            return res.status(404).json({
                success: false,
                message: 'Dispute not found',
            });
        }

        // Determine which employee to assign to
        const assignToId = employee_id || currentEmployee.id;

        // If assigning to another employee, verify they exist
        if (employee_id && employee_id !== currentEmployee.id) {
            const targetEmployee = await Employee.findByPk(employee_id);
            if (!targetEmployee) {
                return res.status(404).json({
                    success: false,
                    message: 'Target employee not found',
                });
            }

            if (targetEmployee.status !== 'active') {
                return res.status(400).json({
                    success: false,
                    message: 'Cannot assign to inactive employee',
                });
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // UPDATE DISPUTE
        // ─────────────────────────────────────────────────────────────────

        await dispute.update({
            assigned_to: assignToId,
            assigned_at: new Date(),
            status: dispute.status === 'open' ? 'investigating' : dispute.status,
        });

        console.log(`✅ [DISPUTE_ADMIN] Dispute assigned successfully`);

        // Fetch updated dispute with employee details
        const updatedDispute = await ServiceDispute.findOne({
            where: { dispute_id },
            include: [
                {
                    model: Employee,
                    as: 'assignedEmployee', // ✅ FIXED
                    attributes: ['id', 'first_name', 'last_name', 'email', 'role'],
                }
            ]
        });

        res.status(200).json({
            success: true,
            message: 'Dispute assigned successfully',
            data: updatedDispute,
        });

    } catch (error) {
        console.error('❌ [DISPUTE_ADMIN] Error in assignDispute:', error);
        console.error('Stack trace:', error.stack);

        res.status(500).json({
            success: false,
            message: 'Unable to assign dispute. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// UPDATE DISPUTE STATUS
// PUT /api/services/admin/disputes/:dispute_id/status
// ═══════════════════════════════════════════════════════════════════════

exports.updateDisputeStatus = async (req, res) => {
    try {
        const { dispute_id } = req.params;
        const { status, admin_notes } = req.body;
        const currentEmployee = req.user;

        console.log(`📝 [DISPUTE_ADMIN] Updating dispute ${dispute_id} status to: ${status}`);

        // ─────────────────────────────────────────────────────────────────
        // VALIDATION
        // ─────────────────────────────────────────────────────────────────

        const validStatuses = ['open', 'investigating', 'awaiting_response', 'resolved', 'closed', 'escalated'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
            });
        }

        const dispute = await ServiceDispute.findOne({ where: { dispute_id } });

        if (!dispute) {
            return res.status(404).json({
                success: false,
                message: 'Dispute not found',
            });
        }

        // ─────────────────────────────────────────────────────────────────
        // UPDATE DISPUTE
        // ─────────────────────────────────────────────────────────────────

        const updateData = { status };

        // Add admin notes if provided
        if (admin_notes) {
            const existingNotes = dispute.investigation_notes ? JSON.parse(dispute.investigation_notes) : [];
            existingNotes.push({
                note: admin_notes,
                employee_id: currentEmployee.id,
                employee_name: `${currentEmployee.first_name} ${currentEmployee.last_name}`,
                timestamp: new Date(),
            });
            updateData.investigation_notes = JSON.stringify(existingNotes);
        }

        await dispute.update(updateData);

        console.log(`✅ [DISPUTE_ADMIN] Dispute status updated successfully`);

        res.status(200).json({
            success: true,
            message: 'Dispute status updated successfully',
            data: dispute,
        });

    } catch (error) {
        console.error('❌ [DISPUTE_ADMIN] Error in updateDisputeStatus:', error);
        console.error('Stack trace:', error.stack);

        res.status(500).json({
            success: false,
            message: 'Unable to update dispute status. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// RESOLVE DISPUTE
// POST /api/services/admin/disputes/:dispute_id/resolve
// ═══════════════════════════════════════════════════════════════════════

exports.resolveDispute = async (req, res) => {
    try {
        const { dispute_id } = req.params;
        const {
            resolution_type,
            resolution_details,
            refund_granted,
        } = req.body;
        const currentEmployee = req.user;

        console.log(`✅ [DISPUTE_ADMIN] Resolving dispute: ${dispute_id}`);
        console.log('   Resolution type:', resolution_type);

        // ─────────────────────────────────────────────────────────────────
        // VALIDATION
        // ─────────────────────────────────────────────────────────────────

        const validResolutionTypes = [
            'favor_customer',
            'favor_provider',
            'mutual_agreement',
            'no_action',
            'partial_favor_customer',
            'partial_favor_provider',
        ];

        if (!resolution_type || !validResolutionTypes.includes(resolution_type)) {
            return res.status(400).json({
                success: false,
                message: `Invalid resolution type. Must be one of: ${validResolutionTypes.join(', ')}`,
            });
        }

        if (!resolution_details || resolution_details.length < 20) {
            return res.status(400).json({
                success: false,
                message: 'Resolution details are required (minimum 20 characters)',
            });
        }

        const dispute = await ServiceDispute.findOne({
            where: { dispute_id },
            include: [
                {
                    model: ServiceRequest,
                    as: 'request',
                }
            ]
        });

        if (!dispute) {
            return res.status(404).json({
                success: false,
                message: 'Dispute not found',
            });
        }

        if (dispute.status === 'resolved' || dispute.status === 'closed') {
            return res.status(400).json({
                success: false,
                message: 'This dispute has already been resolved',
            });
        }

        // Validate refund amount if applicable
        if (refund_granted) {
            const refundAmount = parseFloat(refund_granted);
            const serviceAmount = parseFloat(dispute.request.final_amount);

            if (refundAmount < 0 || refundAmount > serviceAmount) {
                return res.status(400).json({
                    success: false,
                    message: 'Refund amount must be between 0 and the service amount',
                });
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // RESOLVE DISPUTE
        // ─────────────────────────────────────────────────────────────────

        await dispute.update({
            status: 'resolved',
            resolution_type,
            resolution_details,
            refund_granted: refund_granted || null,
            commission_released: resolution_type.includes('favor_provider'),
            commission_held: resolution_type.includes('favor_customer'),
            resolved_by: currentEmployee.id,
            resolved_at: new Date(),
        });

        console.log(`✅ [DISPUTE_ADMIN] Dispute resolved successfully: ${dispute_id}`);

        // TODO: Send notifications to both parties
        // TODO: Process refund if applicable
        // TODO: Take action on accounts if needed (suspend, warn, etc.)

        // Fetch updated dispute
        const resolvedDispute = await ServiceDispute.findOne({
            where: { dispute_id },
            include: [
                {
                    model: Employee,
                    as: 'resolver', // ✅ FIXED
                    attributes: ['id', 'first_name', 'last_name', 'email', 'role'],
                }
            ]
        });

        res.status(200).json({
            success: true,
            message: 'Dispute resolved successfully',
            data: resolvedDispute,
        });

    } catch (error) {
        console.error('❌ [DISPUTE_ADMIN] Error in resolveDispute:', error);
        console.error('Stack trace:', error.stack);

        res.status(500).json({
            success: false,
            message: 'Unable to resolve dispute. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// ADD ADMIN NOTE TO DISPUTE
// POST /api/services/admin/disputes/:dispute_id/notes
// ═══════════════════════════════════════════════════════════════════════

exports.addAdminNote = async (req, res) => {
    try {
        const { dispute_id } = req.params;
        const { note } = req.body;
        const currentEmployee = req.user;

        console.log(`📝 [DISPUTE_ADMIN] Adding note to dispute: ${dispute_id}`);

        // ─────────────────────────────────────────────────────────────────
        // VALIDATION
        // ─────────────────────────────────────────────────────────────────

        if (!note || note.length < 10) {
            return res.status(400).json({
                success: false,
                message: 'Note is required (minimum 10 characters)',
            });
        }

        const dispute = await ServiceDispute.findOne({ where: { dispute_id } });

        if (!dispute) {
            return res.status(404).json({
                success: false,
                message: 'Dispute not found',
            });
        }

        // ─────────────────────────────────────────────────────────────────
        // ADD NOTE
        // ─────────────────────────────────────────────────────────────────

        const existingNotes = dispute.investigation_notes ? JSON.parse(dispute.investigation_notes) : [];
        existingNotes.push({
            note,
            employee_id: currentEmployee.id,
            employee_name: `${currentEmployee.first_name} ${currentEmployee.last_name}`,
            timestamp: new Date(),
        });

        await dispute.update({
            investigation_notes: JSON.stringify(existingNotes),
        });

        console.log(`✅ [DISPUTE_ADMIN] Note added successfully`);

        res.status(200).json({
            success: true,
            message: 'Note added successfully',
            data: {
                dispute_id: dispute.dispute_id,
                investigation_notes: existingNotes,
            },
        });

    } catch (error) {
        console.error('❌ [DISPUTE_ADMIN] Error in addAdminNote:', error);
        console.error('Stack trace:', error.stack);

        res.status(500).json({
            success: false,
            message: 'Unable to add note. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET DISPUTE STATISTICS
// GET /api/services/admin/disputes/stats
// ═══════════════════════════════════════════════════════════════════════

exports.getDisputeStats = async (req, res) => {
    try {
        console.log('📊 [DISPUTE_ADMIN] Fetching dispute statistics...');

        // ─────────────────────────────────────────────────────────────────
        // TOTAL COUNTS BY STATUS
        // ─────────────────────────────────────────────────────────────────

        const statusCounts = await ServiceDispute.findAll({
            attributes: [
                'status',
                [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
            ],
            group: ['status'],
            raw: true,
        });

        const statusStats = {
            open: 0,
            investigating: 0,
            awaiting_response: 0,
            resolved: 0,
            closed: 0,
            escalated: 0,
        };

        statusCounts.forEach(item => {
            statusStats[item.status] = parseInt(item.count);
        });

        // ─────────────────────────────────────────────────────────────────
        // COUNTS BY DISPUTE TYPE
        // ─────────────────────────────────────────────────────────────────

        const typeCounts = await ServiceDispute.findAll({
            attributes: [
                'dispute_type',
                [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
            ],
            group: ['dispute_type'],
            raw: true,
        });

        // ─────────────────────────────────────────────────────────────────
        // RESOLUTION TYPE BREAKDOWN
        // ─────────────────────────────────────────────────────────────────

        const resolutionCounts = await ServiceDispute.findAll({
            attributes: [
                'resolution_type',
                [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
            ],
            where: {
                status: { [Op.in]: ['resolved', 'closed'] },
                resolution_type: { [Op.not]: null },
            },
            group: ['resolution_type'],
            raw: true,
        });

        // ─────────────────────────────────────────────────────────────────
        // AVERAGE RESOLUTION TIME
        // ─────────────────────────────────────────────────────────────────

        const avgResolutionTime = await ServiceDispute.findOne({
            attributes: [
                [
                    sequelize.fn('AVG',
                        sequelize.literal('TIMESTAMPDIFF(HOUR, created_at, resolved_at)')
                    ),
                    'avg_hours'
                ],
            ],
            where: {
                status: 'resolved',
                resolved_at: { [Op.not]: null },
            },
            raw: true,
        });

        // ─────────────────────────────────────────────────────────────────
        // PENDING DISPUTES (>24 hours)
        // ─────────────────────────────────────────────────────────────────

        const twentyFourHoursAgo = new Date();
        twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);

        const urgentDisputes = await ServiceDispute.count({
            where: {
                status: { [Op.in]: ['open', 'investigating'] },
                created_at: { [Op.lt]: twentyFourHoursAgo },
            },
        });

        // ─────────────────────────────────────────────────────────────────
        // UNASSIGNED DISPUTES
        // ─────────────────────────────────────────────────────────────────

        const unassignedCount = await ServiceDispute.count({
            where: {
                assigned_to: null,
                status: { [Op.in]: ['open', 'investigating'] },
            },
        });

        console.log('✅ [DISPUTE_ADMIN] Statistics retrieved successfully');

        res.status(200).json({
            success: true,
            message: 'Dispute statistics retrieved successfully',
            data: {
                status_breakdown: statusStats,
                type_breakdown: typeCounts,
                resolution_breakdown: resolutionCounts,
                average_resolution_hours: parseFloat(avgResolutionTime?.avg_hours || 0).toFixed(2),
                urgent_disputes: urgentDisputes,
                unassigned_disputes: unassignedCount,
                total_disputes: Object.values(statusStats).reduce((sum, count) => sum + count, 0),
            },
        });

    } catch (error) {
        console.error('❌ [DISPUTE_ADMIN] Error in getDisputeStats:', error);
        console.error('Stack trace:', error.stack);

        res.status(500).json({
            success: false,
            message: 'Unable to fetch dispute statistics. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

module.exports = exports;