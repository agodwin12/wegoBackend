// backend/controllers/supportController.js
// WEGO - Support & Help Controller
// Handles FAQ, support tickets, and problem reports
// Updated to work with existing SupportTicket model (UUID-based)

const { Account, SupportTicket, FAQ } = require('../models');
//const { sendEmail } = require('../utils/email'); // Optional

// ═══════════════════════════════════════════════════════════════════
// FAQ MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

/**
 * @route   GET /api/support/faq
 * @desc    Get all FAQs (categorized)
 * @access  Public
 */
exports.getFAQs = async (req, res) => {
    try {
        const { category, search } = req.query;

        // Build query conditions
        const whereClause = { is_active: true };

        if (category) {
            whereClause.category = category;
        }

        if (search) {
            const { Op } = require('sequelize');
            whereClause[Op.or] = [
                { question: { [Op.like]: `%${search}%` } },
                { answer: { [Op.like]: `%${search}%` } }
            ];
        }

        // Get FAQs
        const faqs = await FAQ.findAll({
            where: whereClause,
            order: [
                ['category', 'ASC'],
                ['order', 'ASC'],
                ['createdAt', 'DESC']
            ]
        });

        // Group by category
        const groupedFAQs = faqs.reduce((acc, faq) => {
            const category = faq.category || 'general';
            if (!acc[category]) {
                acc[category] = [];
            }
            acc[category].push({
                id: faq.id,
                question: faq.question,
                answer: faq.answer,
                category: faq.category,
                order: faq.order
            });
            return acc;
        }, {});

        res.status(200).json({
            success: true,
            message: 'FAQs retrieved successfully',
            data: {
                total: faqs.length,
                faqs: groupedFAQs
            }
        });

    } catch (error) {
        console.error('❌ [SUPPORT] Get FAQs error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve FAQs',
            error: error.message
        });
    }
};

/**
 * @route   GET /api/support/faq/categories
 * @desc    Get all FAQ categories
 * @access  Public
 */
exports.getFAQCategories = async (req, res) => {
    try {
        const { Sequelize } = require('sequelize');

        const categories = await FAQ.findAll({
            attributes: [
                'category',
                [Sequelize.fn('COUNT', Sequelize.col('id')), 'count']
            ],
            where: { is_active: true },
            group: ['category'],
            raw: true
        });

        res.status(200).json({
            success: true,
            message: 'FAQ categories retrieved successfully',
            data: categories
        });

    } catch (error) {
        console.error('❌ [SUPPORT] Get FAQ categories error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve FAQ categories',
            error: error.message
        });
    }
};

// ═══════════════════════════════════════════════════════════════════
// CONTACT SUPPORT (SUPPORT TICKETS)
// ═══════════════════════════════════════════════════════════════════

/**
 * @route   POST /api/support/contact
 * @desc    Create support ticket (contact support)
 * @access  Private
 */
exports.createSupportTicket = async (req, res) => {
    try {
        const userId = req.user.id; // UUID from auth middleware
        const { subject, category, message, priority } = req.body;

        // Get user info for email
        const user = await Account.findByPk(userId, {
            attributes: ['id', 'first_name', 'last_name', 'email', 'phone']
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Generate ticket number (handled by model hook, but we can generate manually too)
        const ticketNumber = await SupportTicket.generateTicketNumber();

        // Create support ticket
        const ticket = await SupportTicket.create({
            user_id: userId,
            ticket_number: ticketNumber,
            subject,
            category: category || 'general',
            message,
            priority: priority || 'medium',
            status: 'open'
        });

        console.log('✅ [SUPPORT] Support ticket created:', ticket.ticket_number);

        // TODO: Send email notification to support team
        // await sendEmail({
        //   to: 'support@wego.cm',
        //   subject: `New Support Ticket: ${ticket.ticket_number}`,
        //   template: 'new-support-ticket',
        //   data: { user, ticket }
        // });

        // Send confirmation email to user
        // await sendEmail({
        //   to: user.email,
        //   subject: 'Support Ticket Created',
        //   template: 'support-ticket-confirmation',
        //   data: { user, ticket }
        // });

        res.status(201).json({
            success: true,
            message: 'Support ticket created successfully. Our team will respond within 24 hours.',
            data: {
                ticketNumber: ticket.ticket_number,
                ticketId: ticket.id,
                status: ticket.status,
                priority: ticket.priority,
                category: ticket.category,
                createdAt: ticket.createdAt
            }
        });

    } catch (error) {
        console.error('❌ [SUPPORT] Create support ticket error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create support ticket',
            error: error.message
        });
    }
};

/**
 * @route   GET /api/support/tickets
 * @desc    Get user's support tickets
 * @access  Private
 */
exports.getUserTickets = async (req, res) => {
    try {
        const userId = req.user.id; // UUID
        const { status } = req.query;

        // Build query
        const whereClause = { user_id: userId };
        if (status) {
            whereClause.status = status;
        }

        const tickets = await SupportTicket.findAll({
            where: whereClause,
            order: [['createdAt', 'DESC']],
            attributes: [
                'id',
                'ticket_number',
                'subject',
                'category',
                'status',
                'priority',
                'assigned_to',
                'createdAt',
                'updatedAt'
            ]
        });

        // Add computed fields using instance methods
        const ticketsWithMeta = tickets.map(ticket => ({
            ...ticket.toJSON(),
            isOpen: ticket.isOpen(),
            isAssigned: ticket.isAssigned(),
            ageHours: ticket.getAgeInHours()
        }));

        res.status(200).json({
            success: true,
            message: 'Support tickets retrieved successfully',
            data: {
                total: tickets.length,
                tickets: ticketsWithMeta
            }
        });

    } catch (error) {
        console.error('❌ [SUPPORT] Get user tickets error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve support tickets',
            error: error.message
        });
    }
};

/**
 * @route   GET /api/support/tickets/:ticketNumber
 * @desc    Get specific ticket details
 * @access  Private
 */
exports.getTicketDetails = async (req, res) => {
    try {
        const userId = req.user.id; // UUID
        const { ticketNumber } = req.params;

        // Use custom class method
        const ticket = await SupportTicket.findByTicketNumber(ticketNumber);

        if (!ticket) {
            return res.status(404).json({
                success: false,
                message: 'Ticket not found'
            });
        }

        // Verify ticket belongs to user
        if (ticket.user_id !== userId) {
            return res.status(403).json({
                success: false,
                message: 'Access denied: This ticket does not belong to you'
            });
        }

        // Use toSafeObject method
        const ticketData = ticket.toSafeObject();

        res.status(200).json({
            success: true,
            message: 'Ticket details retrieved successfully',
            data: ticketData
        });

    } catch (error) {
        console.error('❌ [SUPPORT] Get ticket details error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve ticket details',
            error: error.message
        });
    }
};

/**
 * @route   GET /api/support/tickets/open/all
 * @desc    Get all open tickets (for admin/testing)
 * @access  Private
 */
exports.getOpenTickets = async (req, res) => {
    try {
        // Use custom class method
        const tickets = await SupportTicket.findOpen();

        const ticketsWithMeta = tickets.map(ticket => ticket.toSafeObject());

        res.status(200).json({
            success: true,
            message: 'Open tickets retrieved successfully',
            data: {
                total: tickets.length,
                tickets: ticketsWithMeta
            }
        });

    } catch (error) {
        console.error('❌ [SUPPORT] Get open tickets error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve open tickets',
            error: error.message
        });
    }
};

/**
 * @route   GET /api/support/tickets/unassigned/all
 * @desc    Get all unassigned tickets (for admin)
 * @access  Private (Admin only)
 */
exports.getUnassignedTickets = async (req, res) => {
    try {
        // Use custom class method
        const tickets = await SupportTicket.findUnassigned();

        const ticketsWithMeta = tickets.map(ticket => ticket.toSafeObject());

        res.status(200).json({
            success: true,
            message: 'Unassigned tickets retrieved successfully',
            data: {
                total: tickets.length,
                tickets: ticketsWithMeta
            }
        });

    } catch (error) {
        console.error('❌ [SUPPORT] Get unassigned tickets error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve unassigned tickets',
            error: error.message
        });
    }
};

// ═══════════════════════════════════════════════════════════════════
// REPORT A PROBLEM
// ═══════════════════════════════════════════════════════════════════

/**
 * @route   POST /api/support/report
 * @desc    Report a problem (bugs, issues, etc.)
 * @access  Private
 */
exports.reportProblem = async (req, res) => {
    try {
        const userId = req.user.id; // UUID
        const { problemType, description, stepsToReproduce, deviceInfo } = req.body;

        // Get user info
        const user = await Account.findByPk(userId, {
            attributes: ['id', 'first_name', 'last_name', 'email', 'phone']
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Generate report number
        const reportNumber = await SupportTicket.generateTicketNumber();

        // Build detailed message with metadata
        let fullMessage = description;
        if (stepsToReproduce) {
            fullMessage += `\n\n**Steps to Reproduce:**\n${stepsToReproduce}`;
        }
        if (deviceInfo) {
            fullMessage += `\n\n**Device Info:**\n${JSON.stringify(deviceInfo, null, 2)}`;
        }

        // Create problem report as a support ticket
        const report = await SupportTicket.create({
            user_id: userId,
            ticket_number: reportNumber,
            subject: `Problem Report: ${problemType}`,
            category: 'bug_report',
            message: fullMessage,
            priority: 'high',
            status: 'open'
        });

        console.log('✅ [SUPPORT] Problem report created:', report.ticket_number);

        // TODO: Send email notification to tech team
        // await sendEmail({
        //   to: 'tech@wego.cm',
        //   subject: `Problem Report: ${reportNumber}`,
        //   template: 'problem-report',
        //   data: { user, report, deviceInfo }
        // });

        res.status(201).json({
            success: true,
            message: 'Problem report submitted successfully. Our tech team will investigate.',
            data: {
                reportNumber: report.ticket_number,
                reportId: report.id,
                status: report.status,
                priority: report.priority,
                createdAt: report.createdAt
            }
        });

    } catch (error) {
        console.error('❌ [SUPPORT] Report problem error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to submit problem report',
            error: error.message
        });
    }
};

// ═══════════════════════════════════════════════════════════════════
// FEEDBACK
// ═══════════════════════════════════════════════════════════════════

/**
 * @route   POST /api/support/feedback
 * @desc    Submit general feedback
 * @access  Private
 */
exports.submitFeedback = async (req, res) => {
    try {
        const userId = req.user.id; // UUID
        const { feedbackType, rating, message } = req.body;

        // Get user info
        const user = await Account.findByPk(userId, {
            attributes: ['id', 'first_name', 'last_name', 'email']
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Generate feedback number
        const feedbackNumber = await SupportTicket.generateTicketNumber();

        // Add rating to message if provided
        let fullMessage = message;
        if (rating) {
            fullMessage = `Rating: ${rating}/5 stars\n\n${message}`;
        }

        // Create feedback as support ticket
        const feedback = await SupportTicket.create({
            user_id: userId,
            ticket_number: feedbackNumber,
            subject: `Feedback: ${feedbackType}`,
            category: 'feedback',
            message: fullMessage,
            priority: 'low',
            status: 'closed' // Feedback doesn't need response
        });

        console.log('✅ [SUPPORT] Feedback submitted:', feedback.ticket_number);

        res.status(201).json({
            success: true,
            message: 'Thank you for your feedback!',
            data: {
                feedbackNumber: feedback.ticket_number,
                feedbackId: feedback.id,
                createdAt: feedback.createdAt
            }
        });

    } catch (error) {
        console.error('❌ [SUPPORT] Submit feedback error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to submit feedback',
            error: error.message
        });
    }
};

// ═══════════════════════════════════════════════════════════════════
// UPDATE TICKET (User can add messages/updates)
// ═══════════════════════════════════════════════════════════════════

/**
 * @route   PUT /api/support/tickets/:ticketNumber/update
 * @desc    Add update/message to existing ticket
 * @access  Private
 */
exports.updateTicket = async (req, res) => {
    try {
        const userId = req.user.id; // UUID
        const { ticketNumber } = req.params;
        const { message } = req.body;

        if (!message || message.trim().length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Update message is required'
            });
        }

        // Find ticket
        const ticket = await SupportTicket.findByTicketNumber(ticketNumber);

        if (!ticket) {
            return res.status(404).json({
                success: false,
                message: 'Ticket not found'
            });
        }

        // Verify ownership
        if (ticket.user_id !== userId) {
            return res.status(403).json({
                success: false,
                message: 'Access denied: This ticket does not belong to you'
            });
        }

        // Append new message to existing message
        const timestamp = new Date().toISOString();
        ticket.message += `\n\n--- Update from user at ${timestamp} ---\n${message}`;

        // Reopen ticket if it was closed
        if (ticket.status === 'closed' || ticket.status === 'resolved') {
            ticket.status = 'open';
        }

        await ticket.save();

        console.log('✅ [SUPPORT] Ticket updated:', ticket.ticket_number);

        res.status(200).json({
            success: true,
            message: 'Ticket updated successfully',
            data: ticket.toSafeObject()
        });

    } catch (error) {
        console.error('❌ [SUPPORT] Update ticket error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update ticket',
            error: error.message
        });
    }
};

module.exports = exports;