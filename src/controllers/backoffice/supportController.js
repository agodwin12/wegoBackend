const SupportTicket = require('../../models/SupportTicket');
const { Op } = require('sequelize');

// Get all support tickets with pagination and filters
exports.getAllTickets = async (req, res) => {
    try {
        const {
            page = 1,
            limit = 10,
            search = '',
            status = 'all',
            priority = 'all'
        } = req.query;

        const offset = (page - 1) * limit;

        // Build where clause
        const whereClause = {};

        // Search filter
        if (search) {
            whereClause[Op.or] = [
                { ticket_number: { [Op.like]: `%${search}%` } },
                { subject: { [Op.like]: `%${search}%` } },
                { message: { [Op.like]: `%${search}%` } }
            ];
        }

        // Status filter
        if (status !== 'all') {
            whereClause.status = status;
        }

        // Priority filter
        if (priority !== 'all') {
            whereClause.priority = priority;
        }

        // Fetch tickets
        const { count, rows: tickets } = await SupportTicket.findAndCountAll({
            where: whereClause,
            limit: parseInt(limit),
            offset: parseInt(offset),
            include: [
                {
                    association: 'user',
                    attributes: ['uuid', 'first_name', 'last_name', 'email', 'phone_e164']
                },
                {
                    association: 'employee',
                    attributes: ['id', 'first_name', 'last_name', 'email']
                }
            ],
            order: [['createdAt', 'DESC']]
        });

        res.json({
            success: true,
            data: {
                tickets,
                pagination: {
                    total: count,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    totalPages: Math.ceil(count / limit)
                }
            }
        });

    } catch (error) {
        console.error('❌ Error fetching support tickets:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch support tickets',
            error: error.message
        });
    }
};

// Get single ticket by ID
exports.getTicketById = async (req, res) => {
    try {
        const { id } = req.params;

        const ticket = await SupportTicket.findByPk(id, {
            include: [
                {
                    association: 'user',
                    attributes: ['uuid', 'first_name', 'last_name', 'email', 'phone_e164']
                },
                {
                    association: 'employee',
                    attributes: ['id', 'first_name', 'last_name', 'email']
                }
            ]
        });

        if (!ticket) {
            return res.status(404).json({
                success: false,
                message: 'Ticket not found'
            });
        }

        res.json({
            success: true,
            data: ticket
        });

    } catch (error) {
        console.error('❌ Error fetching ticket:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch ticket',
            error: error.message
        });
    }
};

// Update ticket status
exports.updateTicketStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        // Validate status
        const validStatuses = ['open', 'in_progress', 'resolved', 'closed'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid status. Must be one of: open, in_progress, resolved, closed'
            });
        }

        const ticket = await SupportTicket.findByPk(id);

        if (!ticket) {
            return res.status(404).json({
                success: false,
                message: 'Ticket not found'
            });
        }

        await ticket.update({ status });

        // Reload with associations
        await ticket.reload({
            include: [
                {
                    association: 'user',
                    attributes: ['uuid', 'first_name', 'last_name', 'email', 'phone_e164']
                },
                {
                    association: 'employee',
                    attributes: ['id', 'first_name', 'last_name', 'email']
                }
            ]
        });

        res.json({
            success: true,
            message: 'Ticket status updated successfully',
            data: ticket
        });

    } catch (error) {
        console.error('❌ Error updating ticket status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update ticket status',
            error: error.message
        });
    }
};

// Assign ticket to employee
exports.assignTicket = async (req, res) => {
    try {
        const { id } = req.params;
        const { employee_id } = req.body;

        const ticket = await SupportTicket.findByPk(id);

        if (!ticket) {
            return res.status(404).json({
                success: false,
                message: 'Ticket not found'
            });
        }

        // Verify employee exists if employee_id is provided
        if (employee_id) {
            const db = require('../../models');
            const employee = await db.Employee.findByPk(employee_id);
            if (!employee) {
                return res.status(404).json({
                    success: false,
                    message: 'Employee not found'
                });
            }
        }

        await ticket.update({
            assigned_to: employee_id,
            status: employee_id ? 'in_progress' : 'open'
        });

        // Reload with associations
        await ticket.reload({
            include: [
                {
                    association: 'user',
                    attributes: ['uuid', 'first_name', 'last_name', 'email', 'phone_e164']
                },
                {
                    association: 'employee',
                    attributes: ['id', 'first_name', 'last_name', 'email']
                }
            ]
        });

        res.json({
            success: true,
            message: employee_id ? 'Ticket assigned successfully' : 'Ticket unassigned successfully',
            data: ticket
        });

    } catch (error) {
        console.error('❌ Error assigning ticket:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to assign ticket',
            error: error.message
        });
    }
};

// Add response/note to ticket
exports.addTicketResponse = async (req, res) => {
    try {
        const { id } = req.params;
        const { message, is_internal } = req.body;
        const employeeId = req.user.id;

        if (!message || message.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Message is required'
            });
        }

        const ticket = await SupportTicket.findByPk(id);

        if (!ticket) {
            return res.status(404).json({
                success: false,
                message: 'Ticket not found'
            });
        }

        // Create ticket response (you'll need a TicketResponse model)
        // For now, we'll just update the ticket
        const response = {
            ticket_id: id,
            employee_id: employeeId,
            message: message.trim(),
            is_internal: is_internal || false,
            created_at: new Date()
        };

        // TODO: Save to TicketResponse table when you create the model

        res.json({
            success: true,
            message: 'Response added successfully',
            data: response
        });

    } catch (error) {
        console.error('❌ Error adding ticket response:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to add response',
            error: error.message
        });
    }
};

// Get ticket responses/history
exports.getTicketResponses = async (req, res) => {
    try {
        const { id } = req.params;

        const ticket = await SupportTicket.findByPk(id);

        if (!ticket) {
            return res.status(404).json({
                success: false,
                message: 'Ticket not found'
            });
        }

        // TODO: Fetch from TicketResponse table when you create the model
        const responses = [];

        res.json({
            success: true,
            data: responses
        });

    } catch (error) {
        console.error('❌ Error fetching ticket responses:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch ticket responses',
            error: error.message
        });
    }
};

// Get ticket statistics
exports.getTicketStatistics = async (req, res) => {
    try {
        const [
            totalTickets,
            openTickets,
            inProgressTickets,
            resolvedTickets,
            closedTickets,
            unassignedTickets
        ] = await Promise.all([
            SupportTicket.count(),
            SupportTicket.count({ where: { status: 'open' } }),
            SupportTicket.count({ where: { status: 'in_progress' } }),
            SupportTicket.count({ where: { status: 'resolved' } }),
            SupportTicket.count({ where: { status: 'closed' } }),
            SupportTicket.count({ where: { assigned_to: null, status: ['open', 'in_progress'] } })
        ]);

        res.json({
            success: true,
            data: {
                total: totalTickets,
                open: openTickets,
                in_progress: inProgressTickets,
                resolved: resolvedTickets,
                closed: closedTickets,
                unassigned: unassignedTickets
            }
        });

    } catch (error) {
        console.error('❌ Error fetching ticket statistics:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch ticket statistics',
            error: error.message
        });
    }
};