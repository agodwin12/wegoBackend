

const { ServiceListing, ServiceCategory, Account, Employee } = require('../models');
const { Op } = require('sequelize');

// ═══════════════════════════════════════════════════════════════════════
// GET ALL LISTINGS (Admin - includes all statuses, with pagination)
// GET /api/admin/services/moderation
// ═══════════════════════════════════════════════════════════════════════

exports.getAllListingsAdmin = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;

        const {
            status,
            category_id,
            city,
            search,
            sort_by = 'created_at',
            sort_order = 'DESC',
        } = req.query;

        // ─────────────────────────────────────────────────────────────────
        // BUILD WHERE CLAUSE
        // ─────────────────────────────────────────────────────────────────

        const where = {};

        if (status) {
            where.status = status;
        }

        if (category_id) {
            where.category_id = category_id;
        }

        if (city) {
            where.city = { [Op.like]: `%${city}%` };
        }

        if (search) {
            where[Op.or] = [
                { listing_id: { [Op.like]: `%${search}%` } },
                { title: { [Op.like]: `%${search}%` } },
                { description: { [Op.like]: `%${search}%` } },
            ];
        }

        // ─────────────────────────────────────────────────────────────────
        // VALIDATE SORT
        // ─────────────────────────────────────────────────────────────────

        const allowedSortFields = ['created_at', 'updated_at', 'status', 'view_count', 'average_rating'];
        const sortField = allowedSortFields.includes(sort_by) ? sort_by : 'created_at';
        const sortDirection = sort_order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

        // ─────────────────────────────────────────────────────────────────
        // FETCH LISTINGS
        // ─────────────────────────────────────────────────────────────────

        const { count, rows: listings } = await ServiceListing.findAndCountAll({
            where,
            include: [
                {
                    model: ServiceCategory,
                    as: 'category',
                    attributes: ['id', 'name_en', 'parent_id'],
                },
                {
                    model: Account,
                    as: 'provider',
                    attributes: ['uuid', 'first_name', 'last_name', 'email', 'phone_e164', 'avatar_url'],
                },
                {
                    model: Employee,
                    as: 'approver',
                    attributes: ['id', 'first_name', 'last_name', 'email'],
                },
                {
                    model: Employee,
                    as: 'rejecter',
                    attributes: ['id', 'first_name', 'last_name', 'email'],
                },
            ],
            limit,
            offset,
            order: [[sortField, sortDirection]],
        });

        const totalPages = Math.ceil(count / limit);

        res.status(200).json({
            success: true,
            message: 'All moderation retrieved successfully',
            data: listings,
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
        console.error('❌ [SERVICE_LISTING_ADMIN_CONTROLLER] Error in getAllListingsAdmin:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve moderation. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET PENDING LISTINGS (Admin - for moderation queue)
// GET /api/admin/services/moderation/pending
// ═══════════════════════════════════════════════════════════════════════

exports.getPendingListings = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;

        const { count, rows: listings } = await ServiceListing.findAndCountAll({
            where: { status: 'pending' },
            include: [
                {
                    model: ServiceCategory,
                    as: 'category',
                    attributes: ['id', 'name_en', 'parent_id'],
                },
                {
                    model: Account,
                    as: 'provider',
                    attributes: ['uuid', 'first_name', 'last_name', 'email', 'phone_e164', 'avatar_url'],
                },
            ],
            limit,
            offset,
            order: [['created_at', 'ASC']], // Oldest first (FIFO)
        });

        const totalPages = Math.ceil(count / limit);

        // Calculate how long each listing has been pending
        const listingsWithPendingTime = listings.map(listing => {
            const pendingHours = Math.floor((Date.now() - new Date(listing.created_at)) / (1000 * 60 * 60));
            return {
                ...listing.toJSON(),
                pending_hours: pendingHours,
                is_urgent: pendingHours > 24, // Flag if pending > 24 hours
            };
        });

        res.status(200).json({
            success: true,
            message: 'Pending moderation retrieved successfully',
            data: listingsWithPendingTime,
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
        console.error('❌ [SERVICE_LISTING_ADMIN_CONTROLLER] Error in getPendingListings:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve pending moderation. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET LISTING BY ID (Admin - full details)
// GET /api/admin/services/moderation/:id
// ═══════════════════════════════════════════════════════════════════════

exports.getListingByIdAdmin = async (req, res) => {
    try {
        const { id } = req.params;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid listing ID. Please provide a valid numeric ID.',
            });
        }

        const listing = await ServiceListing.findByPk(id, {
            include: [
                {
                    model: ServiceCategory,
                    as: 'category',
                    attributes: ['id', 'name_en', 'description_en', 'parent_id'],
                },
                {
                    model: Account,
                    as: 'provider',
                    attributes: ['uuid', 'first_name', 'last_name', 'email', 'phone_e164', 'avatar_url', 'user_type'],
                },
                {
                    model: Employee,
                    as: 'approver',
                    attributes: ['id', 'first_name', 'last_name', 'email'],
                },
                {
                    model: Employee,
                    as: 'rejecter',
                    attributes: ['id', 'first_name', 'last_name', 'email'],
                },
            ],
        });

        if (!listing) {
            return res.status(404).json({
                success: false,
                message: 'Listing not found. The specified listing does not exist.',
            });
        }

        res.status(200).json({
            success: true,
            message: 'Listing retrieved successfully',
            data: listing,
        });

    } catch (error) {
        console.error('❌ [SERVICE_LISTING_ADMIN_CONTROLLER] Error in getListingByIdAdmin:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve listing. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// APPROVE LISTING (Admin/Employee only)
// POST /api/admin/services/moderation/:id/approve
// ═══════════════════════════════════════════════════════════════════════

exports.approveListing = async (req, res) => {
    try {
        const { id } = req.params;
        const employee_id = req.user.id; // Employee ID from auth middleware

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid listing ID. Please provide a valid numeric ID.',
            });
        }

        const listing = await ServiceListing.findByPk(id);

        if (!listing) {
            return res.status(404).json({
                success: false,
                message: 'Listing not found. The specified listing does not exist.',
            });
        }

        if (listing.status !== 'pending') {
            return res.status(400).json({
                success: false,
                message: `Cannot approve listing with status "${listing.status}". Only pending listings can be approved.`,
            });
        }

        // Approve listing
        await listing.update({
            status: 'approved',
            approved_by: employee_id,
            approved_at: new Date(),
            rejected_by: null,
            rejected_at: null,
            rejection_reason: null,
        });

        console.log('✅ [SERVICE_LISTING_ADMIN_CONTROLLER] Listing approved:', listing.listing_id, 'by employee:', employee_id);

        // TODO: Send notification to provider
        // - Push notification: "Your listing has been approved!"
        // - Email notification

        res.status(200).json({
            success: true,
            message: 'Listing approved successfully. Provider will be notified.',
            data: {
                id: listing.id,
                listing_id: listing.listing_id,
                status: listing.status,
                approved_at: listing.approved_at,
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_LISTING_ADMIN_CONTROLLER] Error in approveListing:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to approve listing. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// REJECT LISTING (Admin/Employee only)
// POST /api/admin/services/moderation/:id/reject
// ═══════════════════════════════════════════════════════════════════════

exports.rejectListing = async (req, res) => {
    try {
        const { id } = req.params;
        const { rejection_reason } = req.body;
        const employee_id = req.user.id; // Employee ID from auth middleware

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid listing ID. Please provide a valid numeric ID.',
            });
        }

        if (!rejection_reason || rejection_reason.trim().length < 10) {
            return res.status(400).json({
                success: false,
                message: 'Rejection reason is required and must be at least 10 characters long.',
            });
        }

        const listing = await ServiceListing.findByPk(id);

        if (!listing) {
            return res.status(404).json({
                success: false,
                message: 'Listing not found. The specified listing does not exist.',
            });
        }

        if (listing.status !== 'pending') {
            return res.status(400).json({
                success: false,
                message: `Cannot reject listing with status "${listing.status}". Only pending listings can be rejected.`,
            });
        }

        // Reject listing
        await listing.update({
            status: 'rejected',
            rejection_reason: rejection_reason.trim(),
            rejected_by: employee_id,
            rejected_at: new Date(),
            approved_by: null,
            approved_at: null,
        });

        console.log('✅ [SERVICE_LISTING_ADMIN_CONTROLLER] Listing rejected:', listing.listing_id, 'by employee:', employee_id);

        // TODO: Send notification to provider
        // - Push notification: "Your listing needs revision"
        // - Email notification with rejection reason

        res.status(200).json({
            success: true,
            message: 'Listing rejected successfully. Provider will be notified with the reason.',
            data: {
                id: listing.id,
                listing_id: listing.listing_id,
                status: listing.status,
                rejection_reason: listing.rejection_reason,
                rejected_at: listing.rejected_at,
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_LISTING_ADMIN_CONTROLLER] Error in rejectListing:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to reject listing. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// ACTIVATE LISTING (Admin - make approved listing active)
// POST /api/admin/services/moderation/:id/activate
// ═══════════════════════════════════════════════════════════════════════

exports.activateListing = async (req, res) => {
    try {
        const { id } = req.params;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid listing ID. Please provide a valid numeric ID.',
            });
        }

        const listing = await ServiceListing.findByPk(id);

        if (!listing) {
            return res.status(404).json({
                success: false,
                message: 'Listing not found. The specified listing does not exist.',
            });
        }

        if (listing.status !== 'approved') {
            return res.status(400).json({
                success: false,
                message: `Cannot activate listing with status "${listing.status}". Only approved listings can be activated.`,
            });
        }

        // Activate listing
        await listing.update({ status: 'active' });

        console.log('✅ [SERVICE_LISTING_ADMIN_CONTROLLER] Listing activated:', listing.listing_id);

        res.status(200).json({
            success: true,
            message: 'Listing activated successfully. It is now visible in the marketplace.',
            data: {
                id: listing.id,
                listing_id: listing.listing_id,
                status: listing.status,
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_LISTING_ADMIN_CONTROLLER] Error in activateListing:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to activate listing. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// DEACTIVATE LISTING (Admin - make active listing inactive)
// POST /api/admin/services/moderation/:id/deactivate
// ═══════════════════════════════════════════════════════════════════════

exports.deactivateListing = async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid listing ID. Please provide a valid numeric ID.',
            });
        }

        const listing = await ServiceListing.findByPk(id);

        if (!listing) {
            return res.status(404).json({
                success: false,
                message: 'Listing not found. The specified listing does not exist.',
            });
        }

        if (listing.status !== 'active') {
            return res.status(400).json({
                success: false,
                message: `Cannot deactivate listing with status "${listing.status}". Only active listings can be deactivated.`,
            });
        }

        // Deactivate listing
        await listing.update({
            status: 'inactive',
            rejection_reason: reason || 'Deactivated by admin',
        });

        console.log('✅ [SERVICE_LISTING_ADMIN_CONTROLLER] Listing deactivated:', listing.listing_id);

        // TODO: Send notification to provider
        // - Notify provider that their listing has been deactivated

        res.status(200).json({
            success: true,
            message: 'Listing deactivated successfully. It is no longer visible in the marketplace.',
            data: {
                id: listing.id,
                listing_id: listing.listing_id,
                status: listing.status,
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_LISTING_ADMIN_CONTROLLER] Error in deactivateListing:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to deactivate listing. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// DELETE LISTING PERMANENTLY (Admin only - hard delete)
// DELETE /api/admin/services/moderation/:id
// ═══════════════════════════════════════════════════════════════════════

exports.deleteListingPermanently = async (req, res) => {
    try {
        const { id } = req.params;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid listing ID. Please provide a valid numeric ID.',
            });
        }

        const listing = await ServiceListing.findByPk(id, {
            paranoid: false, // Include soft-deleted records
        });

        if (!listing) {
            return res.status(404).json({
                success: false,
                message: 'Listing not found. The specified listing does not exist.',
            });
        }

        // Check if listing has active service requests
        const { ServiceRequest } = require('../models');
        const activeRequests = await ServiceRequest.count({
            where: {
                listing_id: id,
                status: ['pending', 'accepted', 'in_progress', 'payment_pending'],
            },
        });

        if (activeRequests > 0) {
            return res.status(400).json({
                success: false,
                message: `Cannot permanently delete listing. It has ${activeRequests} active service request(s).`,
            });
        }

        // Hard delete
        await listing.destroy({ force: true });

        console.log('✅ [SERVICE_LISTING_ADMIN_CONTROLLER] Listing permanently deleted:', listing.listing_id);

        res.status(200).json({
            success: true,
            message: 'Listing permanently deleted from the system.',
        });

    } catch (error) {
        console.error('❌ [SERVICE_LISTING_ADMIN_CONTROLLER] Error in deleteListingPermanently:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to delete listing. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET MODERATION STATISTICS (Admin dashboard)
// GET /api/admin/services/moderation/stats
// ═══════════════════════════════════════════════════════════════════════

exports.getModerationStats = async (req, res) => {
    try {
        const totalListings = await ServiceListing.count();
        const pendingListings = await ServiceListing.count({ where: { status: 'pending' } });
        const approvedListings = await ServiceListing.count({ where: { status: 'approved' } });
        const activeListings = await ServiceListing.count({ where: { status: 'active' } });
        const rejectedListings = await ServiceListing.count({ where: { status: 'rejected' } });
        const inactiveListings = await ServiceListing.count({ where: { status: 'inactive' } });

        // Pending more than 24 hours
        const urgentPendingCount = await ServiceListing.count({
            where: {
                status: 'pending',
                created_at: {
                    [Op.lt]: new Date(Date.now() - 24 * 60 * 60 * 1000)
                }
            }
        });

        // Today's approvals
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayApprovals = await ServiceListing.count({
            where: {
                status: ['approved', 'active'],
                approved_at: { [Op.gte]: today }
            }
        });

        res.status(200).json({
            success: true,
            message: 'Moderation statistics retrieved successfully',
            data: {
                total: totalListings,
                pending: pendingListings,
                approved: approvedListings,
                active: activeListings,
                rejected: rejectedListings,
                inactive: inactiveListings,
                urgent_pending: urgentPendingCount,
                today_approvals: todayApprovals,
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_LISTING_ADMIN_CONTROLLER] Error in getModerationStats:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve statistics. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

module.exports = exports;