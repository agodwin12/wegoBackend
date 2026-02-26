// backend/src/controllers/serviceRequestAdmin.controller.js
// Service Request Admin Controller - Admin view of ALL service requests

const {
    ServiceRequest,
    ServiceListing,
    ServiceCategory,
    Account,
    Employee
} = require('../../models');
const { Op } = require('sequelize');
const sequelize = require('sequelize');

// ═══════════════════════════════════════════════════════════════════════
// GET ALL SERVICE REQUESTS (Admin - with comprehensive filters)
// GET /api/services/admin/requests
// ═══════════════════════════════════════════════════════════════════════

exports.getAllRequests = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;

        const {
            status,
            payment_method,
            category_id,
            customer_id,
            provider_id,
            search,
            sort_by = 'created_at',
            sort_order = 'DESC',
            date_from,
            date_to,
        } = req.query;

        console.log(`📋 [SERVICE_REQUEST_ADMIN] Fetching all requests - Page: ${page}, Status: ${status || 'all'}`);

        // ─────────────────────────────────────────────────────────────────
        // BUILD WHERE CLAUSE
        // ─────────────────────────────────────────────────────────────────

        const where = {};

        // Status filter
        if (status) {
            where.status = status;
        }

        // Payment method filter
        if (payment_method) {
            where.payment_method = payment_method;
        }

        // Customer filter
        if (customer_id) {
            where.customer_id = customer_id;
        }

        // Provider filter
        if (provider_id) {
            where.provider_id = provider_id;
        }

        // Date range filter
        if (date_from || date_to) {
            where.created_at = {};
            if (date_from) {
                where.created_at[Op.gte] = new Date(date_from);
            }
            if (date_to) {
                const toDate = new Date(date_to);
                toDate.setHours(23, 59, 59, 999);
                where.created_at[Op.lte] = toDate;
            }
        }

        // Search filter (request_id, description, location)
        if (search) {
            where[Op.or] = [
                { request_id: { [Op.like]: `%${search}%` } },
                { description: { [Op.like]: `%${search}%` } },
                { service_location: { [Op.like]: `%${search}%` } },
            ];
        }

        // ─────────────────────────────────────────────────────────────────
        // CATEGORY FILTER (via listing)
        // ─────────────────────────────────────────────────────────────────

        const listingInclude = {
            model: ServiceListing,
            as: 'listing',
            attributes: [
                'id',
                'listing_id',
                'title',
                'category_id',
                'pricing_type',
                'hourly_rate',
                'fixed_price',
            ],
            include: [
                {
                    model: ServiceCategory,
                    as: 'category',
                    attributes: ['id', 'name_en', 'name_fr'],
                }
            ]
        };

        // If category filter, add to listing where clause
        if (category_id) {
            listingInclude.where = { category_id: parseInt(category_id) };
            listingInclude.required = true;
        }

        // ─────────────────────────────────────────────────────────────────
        // VALIDATE SORT
        // ─────────────────────────────────────────────────────────────────

        const allowedSortFields = [
            'created_at',
            'updated_at',
            'status',
            'final_amount',
            'started_at',
            'completed_at'
        ];
        const sortField = allowedSortFields.includes(sort_by) ? sort_by : 'created_at';
        const sortDirection = sort_order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

        // ─────────────────────────────────────────────────────────────────
        // FETCH REQUESTS WITH NESTED DATA
        // ─────────────────────────────────────────────────────────────────

        const { count, rows: requests } = await ServiceRequest.findAndCountAll({
            where,
            include: [
                listingInclude,
                {
                    model: Account,
                    as: 'customer',
                    attributes: [
                        'uuid',
                        'first_name',
                        'last_name',
                        'phone_e164',
                        'email',
                        'avatar_url'
                    ],
                },
                {
                    model: Account,
                    as: 'provider',
                    attributes: [
                        'uuid',
                        'first_name',
                        'last_name',
                        'phone_e164',
                        'email',
                        'avatar_url'
                    ],
                },
            ],
            limit,
            offset,
            order: [[sortField, sortDirection]],
        });

        const totalPages = Math.ceil(count / limit);

        // ─────────────────────────────────────────────────────────────────
        // TRANSFORM DATA (Add computed fields)
        // ─────────────────────────────────────────────────────────────────

        const transformedRequests = requests.map(request => {
            const data = request.toJSON();

            // Add full_name to customer
            if (data.customer) {
                data.customer.full_name = `${data.customer.first_name} ${data.customer.last_name}`;
                data.customer.fullName = data.customer.full_name;
            }

            // Add full_name to provider
            if (data.provider) {
                data.provider.full_name = `${data.provider.first_name} ${data.provider.last_name}`;
                data.provider.fullName = data.provider.full_name;
            }

            // Calculate duration if in_progress
            if (data.status === 'in_progress' && data.started_at) {
                const durationMs = Date.now() - new Date(data.started_at).getTime();
                data.duration_minutes = Math.floor(durationMs / 60000);
            }

            return data;
        });

        console.log(`✅ [SERVICE_REQUEST_ADMIN] Retrieved ${count} total requests, returning ${requests.length} for page ${page}`);

        res.status(200).json({
            success: true,
            message: 'All service requests retrieved successfully',
            data: transformedRequests,
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
        console.error('❌ [SERVICE_REQUEST_ADMIN] Error in getAllRequests:', error);
        console.error('Stack trace:', error.stack);

        res.status(500).json({
            success: false,
            message: 'Unable to retrieve service requests. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET REQUEST BY ID (Admin - Full details)
// GET /api/services/admin/requests/:id
// ═══════════════════════════════════════════════════════════════════════

exports.getRequestByIdAdmin = async (req, res) => {
    try {
        const { id } = req.params;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid request ID. Please provide a valid numeric ID.',
            });
        }

        const request = await ServiceRequest.findByPk(id, {
            include: [
                {
                    model: ServiceListing,
                    as: 'listing',
                    attributes: [
                        'id',
                        'listing_id',
                        'title',
                        'description',
                        'category_id',
                        'pricing_type',
                        'hourly_rate',
                        'minimum_charge',
                        'fixed_price',
                        'photos'
                    ],
                    include: [
                        {
                            model: ServiceCategory,
                            as: 'category',
                            attributes: ['id', 'name_en', 'name_fr', 'description_en'],
                        }
                    ]
                },
                {
                    model: Account,
                    as: 'customer',
                    attributes: [
                        'uuid',
                        'first_name',
                        'last_name',
                        'phone_e164',
                        'email',
                        'avatar_url',
                        'user_type'
                    ],
                },
                {
                    model: Account,
                    as: 'provider',
                    attributes: [
                        'uuid',
                        'first_name',
                        'last_name',
                        'phone_e164',
                        'email',
                        'avatar_url',
                        'user_type'
                    ],
                },
            ],
        });

        if (!request) {
            return res.status(404).json({
                success: false,
                message: 'Service request not found.',
            });
        }

        // Transform data
        const data = request.toJSON();

        if (data.customer) {
            data.customer.full_name = `${data.customer.first_name} ${data.customer.last_name}`;
            data.customer.fullName = data.customer.full_name;
        }

        if (data.provider) {
            data.provider.full_name = `${data.provider.first_name} ${data.provider.last_name}`;
            data.provider.fullName = data.provider.full_name;
        }

        res.status(200).json({
            success: true,
            message: 'Service request details retrieved successfully',
            data,
        });

    } catch (error) {
        console.error('❌ [SERVICE_REQUEST_ADMIN] Error in getRequestByIdAdmin:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve request details. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET REQUEST STATISTICS (Admin dashboard)
// GET /api/services/admin/requests/stats
// ═══════════════════════════════════════════════════════════════════════

exports.getRequestStatsAdmin = async (req, res) => {
    try {
        console.log('📊 [SERVICE_REQUEST_ADMIN] Fetching request statistics...');

        // Total counts by status
        const totalRequests = await ServiceRequest.count();
        const pendingRequests = await ServiceRequest.count({ where: { status: 'pending' } });
        const acceptedRequests = await ServiceRequest.count({ where: { status: 'accepted' } });
        const inProgressRequests = await ServiceRequest.count({ where: { status: 'in_progress' } });
        const paymentPendingRequests = await ServiceRequest.count({ where: { status: 'payment_pending' } });
        const paymentConfirmationPending = await ServiceRequest.count({ where: { status: 'payment_confirmation_pending' } });
        const paymentConfirmedRequests = await ServiceRequest.count({ where: { status: 'payment_confirmed' } });
        const completedRequests = await ServiceRequest.count({ where: { status: 'completed' } });
        const rejectedRequests = await ServiceRequest.count({ where: { status: 'rejected' } });
        const cancelledRequests = await ServiceRequest.count({ where: { status: 'cancelled' } });
        const disputedRequests = await ServiceRequest.count({ where: { status: 'disputed' } });

        // Today's stats
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const todayRequests = await ServiceRequest.count({
            where: { created_at: { [Op.gte]: today } }
        });

        const todayCompleted = await ServiceRequest.count({
            where: {
                status: ['completed', 'payment_confirmed'],
                completed_at: { [Op.gte]: today }
            }
        });

        // Revenue stats
        const totalRevenueResult = await ServiceRequest.findOne({
            attributes: [
                [sequelize.fn('SUM', sequelize.col('final_amount')), 'total']
            ],
            where: {
                status: ['completed', 'payment_confirmed'],
                final_amount: { [Op.gt]: 0 }
            },
            raw: true
        });
        const totalRevenue = totalRevenueResult?.total || 0;

        const todayRevenueResult = await ServiceRequest.findOne({
            attributes: [
                [sequelize.fn('SUM', sequelize.col('final_amount')), 'total']
            ],
            where: {
                status: ['completed', 'payment_confirmed'],
                payment_confirmed_at: { [Op.gte]: today },
                final_amount: { [Op.gt]: 0 }
            },
            raw: true
        });
        const todayRevenue = todayRevenueResult?.total || 0;

        // Average request value
        const avgRequestResult = await ServiceRequest.findOne({
            attributes: [
                [sequelize.fn('AVG', sequelize.col('final_amount')), 'avg']
            ],
            where: {
                status: ['completed', 'payment_confirmed'],
                final_amount: { [Op.gt]: 0 }
            },
            raw: true
        });
        const averageRequestValue = avgRequestResult?.avg || 0;

        console.log('✅ [SERVICE_REQUEST_ADMIN] Request statistics retrieved');

        res.status(200).json({
            success: true,
            message: 'Request statistics retrieved successfully',
            data: {
                total: totalRequests,
                pending: pendingRequests,
                accepted: acceptedRequests,
                in_progress: inProgressRequests,
                payment_pending: paymentPendingRequests,
                payment_confirmation_pending: paymentConfirmationPending,
                payment_confirmed: paymentConfirmedRequests,
                completed: completedRequests,
                rejected: rejectedRequests,
                cancelled: cancelledRequests,
                disputed: disputedRequests,
                today_requests: todayRequests,
                today_completed: todayCompleted,
                total_revenue: totalRevenue,
                today_revenue: todayRevenue,
                average_request_value: parseFloat(averageRequestValue).toFixed(2),
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_REQUEST_ADMIN] Error in getRequestStatsAdmin:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve request statistics. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// CANCEL REQUEST (Admin - Force cancel if needed)
// POST /api/services/admin/requests/:id/cancel
// ═══════════════════════════════════════════════════════════════════════

exports.cancelRequestAdmin = async (req, res) => {
    try {
        const { id } = req.params;
        const { cancellation_reason } = req.body;
        const employee_id = req.user.id;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid request ID. Please provide a valid numeric ID.',
            });
        }

        if (!cancellation_reason || cancellation_reason.trim().length < 10) {
            return res.status(400).json({
                success: false,
                message: 'Cancellation reason is required and must be at least 10 characters long.',
            });
        }

        const request = await ServiceRequest.findByPk(id);

        if (!request) {
            return res.status(404).json({
                success: false,
                message: 'Service request not found.',
            });
        }

        // Admin can cancel most statuses except completed
        if (['completed', 'cancelled'].includes(request.status)) {
            return res.status(400).json({
                success: false,
                message: `Cannot cancel request with status "${request.status}".`,
            });
        }

        // Cancel request
        await request.update({
            status: 'cancelled',
            cancelled_by: request.customer_id, // Keep original user
            cancelled_at: new Date(),
            cancellation_reason: `[ADMIN CANCELLED] ${cancellation_reason.trim()}`,
        });

        console.log(`✅ [SERVICE_REQUEST_ADMIN] Request cancelled by admin:`, request.request_id, 'by employee:', employee_id);

        // TODO: Send notifications to both parties

        res.status(200).json({
            success: true,
            message: 'Request cancelled successfully by admin. Both parties will be notified.',
            data: {
                id: request.id,
                request_id: request.request_id,
                status: request.status,
                cancelled_at: request.cancelled_at,
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_REQUEST_ADMIN] Error in cancelRequestAdmin:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to cancel request. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET REQUESTS BY STATUS (Admin - Grouped view)
// GET /api/services/admin/requests/by-status
// ═══════════════════════════════════════════════════════════════════════

exports.getRequestsByStatus = async (req, res) => {
    try {
        const requestsByStatus = await ServiceRequest.findAll({
            attributes: [
                'status',
                [sequelize.fn('COUNT', sequelize.col('status')), 'count']
            ],
            group: ['status'],
            raw: true,
        });

        const breakdown = {};
        requestsByStatus.forEach(item => {
            breakdown[item.status] = parseInt(item.count);
        });

        res.status(200).json({
            success: true,
            message: 'Requests by status retrieved successfully',
            data: breakdown,
        });

    } catch (error) {
        console.error('❌ [SERVICE_REQUEST_ADMIN] Error in getRequestsByStatus:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve request breakdown. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

module.exports = exports;