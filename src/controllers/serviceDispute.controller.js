// backend/src/controllers/serviceDispute.controller.js
// Service Dispute Controller - Dispute Resolution System

const { ServiceDispute, ServiceRequest, ServiceListing, Account, Employee } = require('../models');
const { uploadFileToR2, deleteFile } = require('../middleware/upload');
const { Op } = require('sequelize');

// ═══════════════════════════════════════════════════════════════════════
// GENERATE UNIQUE DISPUTE ID
// ═══════════════════════════════════════════════════════════════════════

const generateDisputeId = () => {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const random = Math.floor(100 + Math.random() * 900);
    return `DSP-${year}${month}${day}-${random}`;
};

// ═══════════════════════════════════════════════════════════════════════
// FILE DISPUTE (Customer or Provider files a dispute)
// POST /api/services/disputes
// ═══════════════════════════════════════════════════════════════════════

exports.fileDispute = async (req, res) => {
    try {
        const {
            request_id,
            dispute_type,
            description,
            resolution_requested,
            refund_amount,
        } = req.body;

        const filed_by = req.user.uuid;

        // ─────────────────────────────────────────────────────────────────
        // VALIDATION
        // ─────────────────────────────────────────────────────────────────

        if (!request_id || isNaN(request_id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid request ID. Please provide a valid service request.',
            });
        }

        const validDisputeTypes = ['service_not_provided', 'service_quality', 'payment_issue', 'behavior_conduct', 'fraud_scam', 'other'];
        if (!dispute_type || !validDisputeTypes.includes(dispute_type)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid dispute type. Please select a valid dispute reason.',
            });
        }

        if (!description || description.trim().length < 50) {
            return res.status(400).json({
                success: false,
                message: 'Description is required and must be at least 50 characters long. Please provide detailed information about the issue.',
            });
        }

        if (description.length > 2000) {
            return res.status(400).json({
                success: false,
                message: 'Description is too long. Maximum 2000 characters allowed.',
            });
        }

        const validResolutions = ['full_refund', 'partial_refund', 'redo_service', 'report_only'];
        if (!resolution_requested || !validResolutions.includes(resolution_requested)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid resolution type. Please select what outcome you are seeking.',
            });
        }

        // Validate refund amount if refund requested
        if ((resolution_requested === 'full_refund' || resolution_requested === 'partial_refund') && (!refund_amount || refund_amount <= 0)) {
            return res.status(400).json({
                success: false,
                message: 'Refund amount is required when requesting a refund.',
            });
        }

        // ─────────────────────────────────────────────────────────────────
        // CHECK SERVICE REQUEST
        // ─────────────────────────────────────────────────────────────────

        const request = await ServiceRequest.findOne({
            where: {
                id: request_id,
                [Op.or]: [
                    { customer_id: filed_by },
                    { provider_id: filed_by }
                ]
            }
        });

        if (!request) {
            return res.status(404).json({
                success: false,
                message: 'Service request not found or you do not have permission to file a dispute for it.',
            });
        }

        // Determine who filed the dispute
        const filed_by_type = request.customer_id === filed_by ? 'customer' : 'provider';
        const against_user = filed_by_type === 'customer' ? request.provider_id : request.customer_id;

        // Check if dispute already exists for this request
        const existingDispute = await ServiceDispute.findOne({
            where: {
                request_id,
                status: ['open', 'investigating', 'awaiting_response']
            }
        });

        if (existingDispute) {
            return res.status(409).json({
                success: false,
                message: 'A dispute is already open for this service request. Please wait for resolution.',
                data: {
                    dispute_id: existingDispute.dispute_id,
                    status: existingDispute.status,
                }
            });
        }

        // ─────────────────────────────────────────────────────────────────
        // HANDLE EVIDENCE PHOTOS (max 5)
        // ─────────────────────────────────────────────────────────────────

        let evidence_photos = [];
        if (req.files && req.files.length > 0) {
            if (req.files.length > 5) {
                return res.status(400).json({
                    success: false,
                    message: 'Too many photos. Maximum 5 evidence photos allowed per dispute.',
                });
            }

            try {
                for (const file of req.files) {
                    const photoUrl = await uploadFileToR2(file, 'service-disputes');
                    evidence_photos.push(photoUrl);
                }
            } catch (uploadError) {
                console.error('❌ [SERVICE_DISPUTE_CONTROLLER] Photo upload failed:', uploadError);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to upload evidence photos. Please try again.',
                });
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // CREATE DISPUTE
        // ─────────────────────────────────────────────────────────────────

        const dispute_id = generateDisputeId();

        // Determine priority based on dispute type and amount
        let priority = 'medium';
        if (dispute_type === 'fraud_scam') {
            priority = 'critical';
        } else if (dispute_type === 'service_not_provided' || (refund_amount && refund_amount > 50000)) {
            priority = 'high';
        }

        const dispute = await ServiceDispute.create({
            dispute_id,
            request_id,
            filed_by,
            filed_by_type,
            against_user,
            dispute_type,
            description: description.trim(),
            evidence_photos: evidence_photos.length > 0 ? evidence_photos : null,
            resolution_requested,
            refund_amount: refund_amount || null,
            status: 'open',
            priority,
        });

        // Update service request status
        await request.update({ status: 'disputed' });

        console.log('✅ [SERVICE_DISPUTE_CONTROLLER] Dispute filed:', dispute.dispute_id);

        // TODO: Send notifications
        // - Notify admin team about new dispute
        // - Notify other party about dispute filed
        // - Email notification to both parties

        res.status(201).json({
            success: true,
            message: 'Dispute filed successfully. Our team will review it and contact both parties shortly.',
            data: {
                id: dispute.id,
                dispute_id: dispute.dispute_id,
                status: dispute.status,
                priority: dispute.priority,
                created_at: dispute.created_at,
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_DISPUTE_CONTROLLER] Error in fileDispute:', error);

        if (error.name === 'SequelizeValidationError') {
            return res.status(400).json({
                success: false,
                message: 'Validation error. Please check your input and try again.',
                errors: error.errors.map(e => e.message),
            });
        }

        res.status(500).json({
            success: false,
            message: 'Unable to file dispute. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// ADD RESPONSE FROM OTHER PARTY
// POST /api/services/disputes/:id/respond
// ═══════════════════════════════════════════════════════════════════════

exports.respondToDispute = async (req, res) => {
    try {
        const { id } = req.params;
        const { response_from_other_party } = req.body;
        const user_id = req.user.uuid;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid dispute ID. Please provide a valid numeric ID.',
            });
        }

        if (!response_from_other_party || response_from_other_party.trim().length < 20) {
            return res.status(400).json({
                success: false,
                message: 'Response is required and must be at least 20 characters long.',
            });
        }

        const dispute = await ServiceDispute.findOne({
            where: {
                id,
                against_user: user_id, // Only the defendant can respond
            }
        });

        if (!dispute) {
            return res.status(404).json({
                success: false,
                message: 'Dispute not found or you do not have permission to respond.',
            });
        }

        if (dispute.response_from_other_party) {
            return res.status(400).json({
                success: false,
                message: 'You have already responded to this dispute.',
            });
        }

        if (!['open', 'investigating', 'awaiting_response'].includes(dispute.status)) {
            return res.status(400).json({
                success: false,
                message: `Cannot respond to dispute with status "${dispute.status}".`,
            });
        }

        // Handle response evidence photos
        let response_evidence = [];
        if (req.files && req.files.length > 0) {
            if (req.files.length > 5) {
                return res.status(400).json({
                    success: false,
                    message: 'Too many photos. Maximum 5 evidence photos allowed.',
                });
            }

            try {
                for (const file of req.files) {
                    const photoUrl = await uploadFileToR2(file, 'service-disputes/responses');
                    response_evidence.push(photoUrl);
                }
            } catch (uploadError) {
                console.error('❌ [SERVICE_DISPUTE_CONTROLLER] Photo upload failed:', uploadError);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to upload evidence photos. Please try again.',
                });
            }
        }

        // Add response
        await dispute.update({
            response_from_other_party: response_from_other_party.trim(),
            response_evidence: response_evidence.length > 0 ? response_evidence : null,
            responded_at: new Date(),
            status: 'investigating',
        });

        console.log('✅ [SERVICE_DISPUTE_CONTROLLER] Response added to dispute:', dispute.dispute_id);

        // TODO: Notify admin and filing party

        res.status(200).json({
            success: true,
            message: 'Response submitted successfully. The dispute is now under investigation.',
            data: {
                id: dispute.id,
                dispute_id: dispute.dispute_id,
                status: dispute.status,
                responded_at: dispute.responded_at,
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_DISPUTE_CONTROLLER] Error in respondToDispute:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to submit response. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET MY DISPUTES (User's disputes - with pagination)
// GET /api/services/disputes/my-disputes
// ═══════════════════════════════════════════════════════════════════════

exports.getMyDisputes = async (req, res) => {
    try {
        const user_id = req.user.uuid;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;
        const { status } = req.query;

        const where = {
            [Op.or]: [
                { filed_by: user_id },
                { against_user: user_id }
            ]
        };

        if (status) {
            where.status = status;
        }

        const { count, rows: disputes } = await ServiceDispute.findAndCountAll({
            where,
            include: [
                {
                    model: ServiceRequest,
                    as: 'request',
                    attributes: ['id', 'request_id', 'final_amount', 'service_location'],
                    include: [
                        {
                            model: ServiceListing,
                            as: 'listing',
                            attributes: ['id', 'listing_id', 'title'],
                        }
                    ]
                },
                {
                    model: Account,
                    as: 'filer',
                    attributes: ['uuid', 'first_name', 'last_name', 'avatar_url'],
                },
                {
                    model: Account,
                    as: 'defendant',
                    attributes: ['uuid', 'first_name', 'last_name', 'avatar_url'],
                },
            ],
            limit,
            offset,
            order: [['created_at', 'DESC']],
        });

        const totalPages = Math.ceil(count / limit);

        res.status(200).json({
            success: true,
            message: 'Your disputes retrieved successfully',
            data: disputes,
            pagination: {
                total: count,
                page,
                limit,
                totalPages,
                hasNext: page < totalPages,
                hasPrev: page > 1,
            }
        });

    } catch (error) {
        console.error('❌ [SERVICE_DISPUTE_CONTROLLER] Error in getMyDisputes:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve your disputes. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET DISPUTE BY ID
// GET /api/services/disputes/:id
// ═══════════════════════════════════════════════════════════════════════

exports.getDisputeById = async (req, res) => {
    try {
        const { id } = req.params;
        const user_id = req.user.uuid;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid dispute ID. Please provide a valid numeric ID.',
            });
        }

        const dispute = await ServiceDispute.findOne({
            where: {
                id,
                [Op.or]: [
                    { filed_by: user_id },
                    { against_user: user_id }
                ]
            },
            include: [
                {
                    model: ServiceRequest,
                    as: 'request',
                    include: [
                        {
                            model: ServiceListing,
                            as: 'listing',
                            attributes: ['id', 'listing_id', 'title', 'description'],
                        }
                    ]
                },
                {
                    model: Account,
                    as: 'filer',
                    attributes: ['uuid', 'first_name', 'last_name', 'email', 'phone_e164', 'avatar_url'],
                },
                {
                    model: Account,
                    as: 'defendant',
                    attributes: ['uuid', 'first_name', 'last_name', 'email', 'phone_e164', 'avatar_url'],
                },
                {
                    model: Employee,
                    as: 'assignedEmployee',
                    attributes: ['id', 'first_name', 'last_name', 'email'],
                },
                {
                    model: Employee,
                    as: 'resolver',
                    attributes: ['id', 'first_name', 'last_name', 'email'],
                },
            ],
        });

        if (!dispute) {
            return res.status(404).json({
                success: false,
                message: 'Dispute not found or you do not have permission to view it.',
            });
        }

        res.status(200).json({
            success: true,
            message: 'Dispute details retrieved successfully',
            data: dispute,
        });

    } catch (error) {
        console.error('❌ [SERVICE_DISPUTE_CONTROLLER] Error in getDisputeById:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve dispute details. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET ALL DISPUTES (Admin - with pagination)
// GET /api/admin/services/disputes
// ═══════════════════════════════════════════════════════════════════════

exports.getAllDisputesAdmin = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;
        const { status, priority, dispute_type, assigned_to } = req.query;

        const where = {};

        if (status) {
            where.status = status;
        }

        if (priority) {
            where.priority = priority;
        }

        if (dispute_type) {
            where.dispute_type = dispute_type;
        }

        if (assigned_to) {
            where.assigned_to = assigned_to;
        }

        const { count, rows: disputes } = await ServiceDispute.findAndCountAll({
            where,
            include: [
                {
                    model: ServiceRequest,
                    as: 'request',
                    attributes: ['id', 'request_id', 'final_amount'],
                    include: [
                        {
                            model: ServiceListing,
                            as: 'listing',
                            attributes: ['id', 'listing_id', 'title'],
                        }
                    ]
                },
                {
                    model: Account,
                    as: 'filer',
                    attributes: ['uuid', 'first_name', 'last_name', 'email', 'phone_e164'],
                },
                {
                    model: Account,
                    as: 'defendant',
                    attributes: ['uuid', 'first_name', 'last_name', 'email', 'phone_e164'],
                },
                {
                    model: Employee,
                    as: 'assignedEmployee',
                    attributes: ['id', 'first_name', 'last_name', 'email'],
                },
            ],
            limit,
            offset,
            order: [
                ['priority', 'DESC'], // Critical first
                ['created_at', 'ASC'], // Oldest first
            ],
        });

        const totalPages = Math.ceil(count / limit);

        res.status(200).json({
            success: true,
            message: 'All disputes retrieved successfully',
            data: disputes,
            pagination: {
                total: count,
                page,
                limit,
                totalPages,
                hasNext: page < totalPages,
                hasPrev: page > 1,
            }
        });

    } catch (error) {
        console.error('❌ [SERVICE_DISPUTE_CONTROLLER] Error in getAllDisputesAdmin:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve disputes. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// ASSIGN DISPUTE TO EMPLOYEE (Admin)
// POST /api/admin/services/disputes/:id/assign
// ═══════════════════════════════════════════════════════════════════════

exports.assignDispute = async (req, res) => {
    try {
        const { id } = req.params;
        const { assigned_to } = req.body;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid dispute ID. Please provide a valid numeric ID.',
            });
        }

        if (!assigned_to || isNaN(assigned_to)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid employee ID. Please select a valid employee.',
            });
        }

        const dispute = await ServiceDispute.findByPk(id);

        if (!dispute) {
            return res.status(404).json({
                success: false,
                message: 'Dispute not found.',
            });
        }

        // Check if employee exists
        const employee = await Employee.findByPk(assigned_to);
        if (!employee) {
            return res.status(404).json({
                success: false,
                message: 'Employee not found. Please select a valid employee.',
            });
        }

        // Assign dispute
        await dispute.update({
            assigned_to,
            assigned_at: new Date(),
            status: 'investigating',
        });

        console.log('✅ [SERVICE_DISPUTE_CONTROLLER] Dispute assigned:', dispute.dispute_id, 'to employee:', assigned_to);

        // TODO: Notify assigned employee

        res.status(200).json({
            success: true,
            message: 'Dispute assigned successfully.',
            data: {
                id: dispute.id,
                dispute_id: dispute.dispute_id,
                assigned_to: dispute.assigned_to,
                assigned_at: dispute.assigned_at,
                status: dispute.status,
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_DISPUTE_CONTROLLER] Error in assignDispute:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to assign dispute. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// ADD INVESTIGATION NOTES (Admin)
// POST /api/admin/services/disputes/:id/notes
// ═══════════════════════════════════════════════════════════════════════

exports.addInvestigationNotes = async (req, res) => {
    try {
        const { id } = req.params;
        const { investigation_notes } = req.body;
        const employee_id = req.user.id;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid dispute ID. Please provide a valid numeric ID.',
            });
        }

        if (!investigation_notes || investigation_notes.trim().length < 10) {
            return res.status(400).json({
                success: false,
                message: 'Investigation notes are required and must be at least 10 characters long.',
            });
        }

        const dispute = await ServiceDispute.findByPk(id);

        if (!dispute) {
            return res.status(404).json({
                success: false,
                message: 'Dispute not found.',
            });
        }

        // Append notes with timestamp and employee info
        const timestamp = new Date().toISOString();
        const newNote = `[${timestamp}] Employee #${employee_id}: ${investigation_notes.trim()}`;
        const updatedNotes = dispute.investigation_notes
            ? `${dispute.investigation_notes}\n\n${newNote}`
            : newNote;

        await dispute.update({
            investigation_notes: updatedNotes,
        });

        console.log('✅ [SERVICE_DISPUTE_CONTROLLER] Investigation notes added to dispute:', dispute.dispute_id);

        res.status(200).json({
            success: true,
            message: 'Investigation notes added successfully.',
            data: {
                id: dispute.id,
                dispute_id: dispute.dispute_id,
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_DISPUTE_CONTROLLER] Error in addInvestigationNotes:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to add notes. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};



// ═══════════════════════════════════════════════════════════════════════
// RESOLVE DISPUTE (Admin)
// POST /api/admin/services/disputes/:id/resolve
// ═══════════════════════════════════════════════════════════════════════

exports.resolveDispute = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            resolution_type,
            resolution_details,
            refund_granted,
            commission_released,
            commission_held,
        } = req.body;
        const employee_id = req.user.id;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid dispute ID. Please provide a valid numeric ID.',
            });
        }

        const validResolutionTypes = [
            'favor_customer',
            'favor_provider',
            'mutual_agreement',
            'no_action',
            'partial_favor_customer',
            'partial_favor_provider'
        ];

        if (!resolution_type || !validResolutionTypes.includes(resolution_type)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid resolution type. Please select a valid resolution option.',
            });
        }

        if (!resolution_details || resolution_details.trim().length < 20) {
            return res.status(400).json({
                success: false,
                message: 'Resolution details are required and must be at least 20 characters long.',
            });
        }

        const dispute = await ServiceDispute.findByPk(id, {
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
                message: 'Dispute not found.',
            });
        }

        if (dispute.status === 'resolved' || dispute.status === 'closed') {
            return res.status(400).json({
                success: false,
                message: `Dispute is already ${dispute.status}.`,
            });
        }

        // Validate refund amount if provided
        if (refund_granted && refund_granted > dispute.request.final_amount) {
            return res.status(400).json({
                success: false,
                message: 'Refund amount cannot exceed the service amount.',
            });
        }

        // Resolve dispute
        await dispute.update({
            status: 'resolved',
            resolution_type,
            resolution_details: resolution_details.trim(),
            refund_granted: refund_granted || null,
            commission_released: commission_released === true,
            commission_held: commission_held === true,
            resolved_by: employee_id,
            resolved_at: new Date(),
        });

        // Update service request status back to completed
        if (dispute.request) {
            await dispute.request.update({ status: 'completed' });
        }

        console.log('✅ [SERVICE_DISPUTE_CONTROLLER] Dispute resolved:', dispute.dispute_id, 'by employee:', employee_id);

        // TODO: Send notifications to both parties
        // - Push notifications
        // - Email notifications with resolution details
        // - SMS if critical

        res.status(200).json({
            success: true,
            message: 'Dispute resolved successfully. Both parties will be notified.',
            data: {
                id: dispute.id,
                dispute_id: dispute.dispute_id,
                resolution_type: dispute.resolution_type,
                refund_granted: dispute.refund_granted,
                resolved_at: dispute.resolved_at,
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_DISPUTE_CONTROLLER] Error in resolveDispute:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to resolve dispute. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// CLOSE DISPUTE (Admin - after resolution)
// POST /api/admin/services/disputes/:id/close
// ═══════════════════════════════════════════════════════════════════════

exports.closeDispute = async (req, res) => {
    try {
        const { id } = req.params;
        const { closed_reason } = req.body;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid dispute ID. Please provide a valid numeric ID.',
            });
        }

        const dispute = await ServiceDispute.findByPk(id);

        if (!dispute) {
            return res.status(404).json({
                success: false,
                message: 'Dispute not found.',
            });
        }

        if (dispute.status !== 'resolved') {
            return res.status(400).json({
                success: false,
                message: 'Only resolved disputes can be closed. Please resolve the dispute first.',
            });
        }

        if (dispute.status === 'closed') {
            return res.status(400).json({
                success: false,
                message: 'Dispute is already closed.',
            });
        }

        // Close dispute
        await dispute.update({
            status: 'closed',
            closed_at: new Date(),
            closed_reason: closed_reason ? closed_reason.trim() : 'Dispute resolved and closed',
        });

        console.log('✅ [SERVICE_DISPUTE_CONTROLLER] Dispute closed:', dispute.dispute_id);

        res.status(200).json({
            success: true,
            message: 'Dispute closed successfully.',
            data: {
                id: dispute.id,
                dispute_id: dispute.dispute_id,
                status: dispute.status,
                closed_at: dispute.closed_at,
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_DISPUTE_CONTROLLER] Error in closeDispute:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to close dispute. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// ESCALATE DISPUTE (Admin - escalate to higher authority)
// POST /api/admin/services/disputes/:id/escalate
// ═══════════════════════════════════════════════════════════════════════

exports.escalateDispute = async (req, res) => {
    try {
        const { id } = req.params;
        const { escalation_reason } = req.body;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid dispute ID. Please provide a valid numeric ID.',
            });
        }

        if (!escalation_reason || escalation_reason.trim().length < 20) {
            return res.status(400).json({
                success: false,
                message: 'Escalation reason is required and must be at least 20 characters long.',
            });
        }

        const dispute = await ServiceDispute.findByPk(id);

        if (!dispute) {
            return res.status(404).json({
                success: false,
                message: 'Dispute not found.',
            });
        }

        if (dispute.status === 'resolved' || dispute.status === 'closed') {
            return res.status(400).json({
                success: false,
                message: 'Cannot escalate a dispute that is already resolved or closed.',
            });
        }

        // Escalate dispute
        await dispute.update({
            status: 'escalated',
            priority: 'critical', // Escalated disputes are always critical
        });

        // Add escalation note to investigation notes
        const timestamp = new Date().toISOString();
        const escalationNote = `[${timestamp}] ESCALATED - Reason: ${escalation_reason.trim()}`;
        const updatedNotes = dispute.investigation_notes
            ? `${dispute.investigation_notes}\n\n${escalationNote}`
            : escalationNote;

        await dispute.update({
            investigation_notes: updatedNotes,
        });

        console.log('✅ [SERVICE_DISPUTE_CONTROLLER] Dispute escalated:', dispute.dispute_id);

        // TODO: Notify senior management/supervisors

        res.status(200).json({
            success: true,
            message: 'Dispute escalated successfully. Senior management will be notified.',
            data: {
                id: dispute.id,
                dispute_id: dispute.dispute_id,
                status: dispute.status,
                priority: dispute.priority,
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_DISPUTE_CONTROLLER] Error in escalateDispute:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to escalate dispute. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET DISPUTE STATISTICS (Admin dashboard)
// GET /api/admin/services/disputes/stats
// ═══════════════════════════════════════════════════════════════════════

exports.getDisputeStats = async (req, res) => {
    try {
        const totalDisputes = await ServiceDispute.count();
        const openDisputes = await ServiceDispute.count({ where: { status: 'open' } });
        const investigatingDisputes = await ServiceDispute.count({ where: { status: 'investigating' } });
        const awaitingResponse = await ServiceDispute.count({ where: { status: 'awaiting_response' } });
        const resolvedDisputes = await ServiceDispute.count({ where: { status: 'resolved' } });
        const closedDisputes = await ServiceDispute.count({ where: { status: 'closed' } });
        const escalatedDisputes = await ServiceDispute.count({ where: { status: 'escalated' } });

        // Priority breakdown
        const criticalDisputes = await ServiceDispute.count({
            where: {
                priority: 'critical',
                status: ['open', 'investigating', 'awaiting_response', 'escalated']
            }
        });

        const highDisputes = await ServiceDispute.count({
            where: {
                priority: 'high',
                status: ['open', 'investigating', 'awaiting_response']
            }
        });

        // Today's stats
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayDisputes = await ServiceDispute.count({
            where: {
                created_at: { [Op.gte]: today }
            }
        });

        const todayResolved = await ServiceDispute.count({
            where: {
                status: 'resolved',
                resolved_at: { [Op.gte]: today }
            }
        });

        // Unassigned disputes
        const unassignedDisputes = await ServiceDispute.count({
            where: {
                assigned_to: null,
                status: ['open', 'investigating']
            }
        });

        // Average resolution time (in hours)
        const resolvedWithTime = await ServiceDispute.findAll({
            where: {
                status: ['resolved', 'closed'],
                resolved_at: { [Op.not]: null }
            },
            attributes: ['created_at', 'resolved_at'],
            raw: true,
        });

        let averageResolutionHours = 0;
        if (resolvedWithTime.length > 0) {
            const totalHours = resolvedWithTime.reduce((sum, dispute) => {
                const hours = (new Date(dispute.resolved_at) - new Date(dispute.created_at)) / (1000 * 60 * 60);
                return sum + hours;
            }, 0);
            averageResolutionHours = Math.round(totalHours / resolvedWithTime.length);
        }

        res.status(200).json({
            success: true,
            message: 'Dispute statistics retrieved successfully',
            data: {
                total: totalDisputes,
                open: openDisputes,
                investigating: investigatingDisputes,
                awaiting_response: awaitingResponse,
                resolved: resolvedDisputes,
                closed: closedDisputes,
                escalated: escalatedDisputes,
                critical: criticalDisputes,
                high: highDisputes,
                unassigned: unassignedDisputes,
                today_filed: todayDisputes,
                today_resolved: todayResolved,
                average_resolution_hours: averageResolutionHours,
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_DISPUTE_CONTROLLER] Error in getDisputeStats:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve statistics. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET DISPUTES BY TYPE (Admin - breakdown by dispute type)
// GET /api/admin/services/disputes/by-type
// ═══════════════════════════════════════════════════════════════════════

exports.getDisputesByType = async (req, res) => {
    try {
        const disputesByType = await ServiceDispute.findAll({
            attributes: [
                'dispute_type',
                [require('sequelize').fn('COUNT', 'dispute_type'), 'count']
            ],
            group: ['dispute_type'],
            raw: true,
        });

        const breakdown = {};
        disputesByType.forEach(item => {
            breakdown[item.dispute_type] = parseInt(item.count);
        });

        res.status(200).json({
            success: true,
            message: 'Disputes by type retrieved successfully',
            data: breakdown,
        });

    } catch (error) {
        console.error('❌ [SERVICE_DISPUTE_CONTROLLER] Error in getDisputesByType:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve dispute breakdown. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET MY ASSIGNED DISPUTES (Employee - disputes assigned to them)
// GET /api/admin/services/disputes/my-assigned
// ═══════════════════════════════════════════════════════════════════════

exports.getMyAssignedDisputes = async (req, res) => {
    try {
        const employee_id = req.user.id;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;
        const { status } = req.query;

        const where = { assigned_to: employee_id };

        if (status) {
            where.status = status;
        }

        const { count, rows: disputes } = await ServiceDispute.findAndCountAll({
            where,
            include: [
                {
                    model: ServiceRequest,
                    as: 'request',
                    attributes: ['id', 'request_id', 'final_amount'],
                    include: [
                        {
                            model: ServiceListing,
                            as: 'listing',
                            attributes: ['id', 'listing_id', 'title'],
                        }
                    ]
                },
                {
                    model: Account,
                    as: 'filer',
                    attributes: ['uuid', 'first_name', 'last_name', 'email', 'phone_e164'],
                },
                {
                    model: Account,
                    as: 'defendant',
                    attributes: ['uuid', 'first_name', 'last_name', 'email', 'phone_e164'],
                },
            ],
            limit,
            offset,
            order: [
                ['priority', 'DESC'],
                ['created_at', 'ASC'],
            ],
        });

        const totalPages = Math.ceil(count / limit);

        res.status(200).json({
            success: true,
            message: 'Your assigned disputes retrieved successfully',
            data: disputes,
            pagination: {
                total: count,
                page,
                limit,
                totalPages,
                hasNext: page < totalPages,
                hasPrev: page > 1,
            }
        });

    } catch (error) {
        console.error('❌ [SERVICE_DISPUTE_CONTROLLER] Error in getMyAssignedDisputes:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve your assigned disputes. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// UPDATE DISPUTE PRIORITY (Admin)
// PATCH /api/admin/services/disputes/:id/priority
// ═══════════════════════════════════════════════════════════════════════

exports.updateDisputePriority = async (req, res) => {
    try {
        const { id } = req.params;
        const { priority } = req.body;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid dispute ID. Please provide a valid numeric ID.',
            });
        }

        const validPriorities = ['low', 'medium', 'high', 'critical'];
        if (!priority || !validPriorities.includes(priority)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid priority. Must be: low, medium, high, or critical.',
            });
        }

        const dispute = await ServiceDispute.findByPk(id);

        if (!dispute) {
            return res.status(404).json({
                success: false,
                message: 'Dispute not found.',
            });
        }

        await dispute.update({ priority });

        console.log('✅ [SERVICE_DISPUTE_CONTROLLER] Dispute priority updated:', dispute.dispute_id, 'to:', priority);

        res.status(200).json({
            success: true,
            message: 'Dispute priority updated successfully.',
            data: {
                id: dispute.id,
                dispute_id: dispute.dispute_id,
                priority: dispute.priority,
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_DISPUTE_CONTROLLER] Error in updateDisputePriority:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to update priority. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// CHANGE DISPUTE STATUS (Admin - manual status change)
// PATCH /api/admin/services/disputes/:id/status
// ═══════════════════════════════════════════════════════════════════════

exports.changeDisputeStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid dispute ID. Please provide a valid numeric ID.',
            });
        }

        const validStatuses = ['open', 'investigating', 'awaiting_response', 'resolved', 'closed', 'escalated'];
        if (!status || !validStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid status. Please select a valid dispute status.',
            });
        }

        const dispute = await ServiceDispute.findByPk(id);

        if (!dispute) {
            return res.status(404).json({
                success: false,
                message: 'Dispute not found.',
            });
        }

        await dispute.update({ status });

        console.log('✅ [SERVICE_DISPUTE_CONTROLLER] Dispute status changed:', dispute.dispute_id, 'to:', status);

        res.status(200).json({
            success: true,
            message: 'Dispute status updated successfully.',
            data: {
                id: dispute.id,
                dispute_id: dispute.dispute_id,
                status: dispute.status,
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_DISPUTE_CONTROLLER] Error in changeDisputeStatus:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to update status. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

module.exports = exports;