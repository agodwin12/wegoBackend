// backend/src/controllers/backoffice/serviceRequestAdmin.controller.js
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
        const limit = parseInt(req.query.limit) || 50;
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
        if (status && status !== 'all') {
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
        // ✅ TRANSFORM DATA - FLATTEN NESTED OBJECTS
        // ─────────────────────────────────────────────────────────────────

        const transformedRequests = requests.map(request => {
            const data = request.toJSON();

            // ✅ Extract service title and category from listing
            const listing = data.listing || {};
            const category = listing.category || {};

            // ✅ Extract customer data
            const customer = data.customer || {};
            const provider = data.provider || {};

            // ✅ Parse photos
            let photos = [];
            if (data.request_photos) {
                try {
                    photos = typeof data.request_photos === 'string'
                        ? JSON.parse(data.request_photos)
                        : data.request_photos;
                } catch (e) {
                    photos = [];
                }
            }
            if (!Array.isArray(photos)) photos = [];

            // ✅ Calculate duration if in_progress
            let duration_minutes = null;
            if (data.status === 'in_progress' && data.started_at) {
                const durationMs = Date.now() - new Date(data.started_at).getTime();
                duration_minutes = Math.floor(durationMs / 60000);
            } else if (data.completed_at && data.started_at) {
                const durationMs = new Date(data.completed_at).getTime() - new Date(data.started_at).getTime();
                duration_minutes = Math.floor(durationMs / 60000);
            }

            // ✅ Return FLAT structure that frontend expects
            return {
                id: data.id.toString(),
                request_id: data.request_id || '',
                service_listing_id: data.service_listing_id || '',

                // Service info (from listing)
                service_title: listing.title || 'Unknown Service',
                category_name: category.name_en || 'Unknown Category',
                subcategory_name: category.name_en || '', // Adjust if you have subcategories

                // Customer info (flattened)
                customer_id: customer.uuid || '',
                customer_name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || 'Unknown Customer',
                customer_phone: customer.phone_e164 || '',
                customer_email: customer.email || '',
                customer_rating: 0, // TODO: Get actual rating from somewhere

                // Provider info (flattened)
                provider_id: provider.uuid || '',
                provider_name: `${provider.first_name || ''} ${provider.last_name || ''}`.trim() || 'Unknown Provider',
                provider_phone: provider.phone_e164 || '',
                provider_email: provider.email || '',
                provider_rating: 0, // TODO: Get actual rating from somewhere

                // Request details
                description: data.description || '',
                location: data.service_location || '',
                when_needed: data.when_needed || data.created_at,
                budget: data.estimated_budget ? parseFloat(data.estimated_budget) : null,
                photos: photos,

                // Status and payment
                status: data.status || 'pending',
                amount: data.final_amount ? parseFloat(data.final_amount) : null,
                payment_method: data.payment_method || null,

                // Timestamps
                created_at: data.created_at,
                accepted_at: data.accepted_at || null,
                rejected_at: data.rejected_at || null,
                started_at: data.started_at || null,
                completed_at: data.completed_at || null,
                payment_confirmed_at: data.payment_confirmed_at || null,
                cancelled_at: data.cancelled_at || null,

                // Duration
                duration_minutes: duration_minutes,

                // Keep nested objects for modal
                _customer: customer,
                _provider: provider,
                _listing: listing,
                _category: category,
            };
        });

        // ─────────────────────────────────────────────────────────────────
        // COMPUTE STATS
        // ─────────────────────────────────────────────────────────────────

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const stats = {
            pending: await ServiceRequest.count({ where: { status: 'pending' } }),
            accepted: await ServiceRequest.count({ where: { status: 'accepted' } }),
            in_progress: await ServiceRequest.count({ where: { status: 'in_progress' } }),
            payment_pending: await ServiceRequest.count({ where: { status: 'payment_pending' } }),
            completed_today: await ServiceRequest.count({
                where: {
                    status: { [Op.in]: ['completed', 'payment_confirmed'] },
                    completed_at: { [Op.gte]: today }
                }
            }),
            total_active: await ServiceRequest.count({
                where: {
                    status: { [Op.notIn]: ['completed', 'cancelled', 'rejected'] }
                }
            }),
        };

        console.log(`✅ [SERVICE_REQUEST_ADMIN] Retrieved ${count} total requests, returning ${requests.length} for page ${page}`);

        res.status(200).json({
            success: true,
            message: 'All service requests retrieved successfully',
            data: transformedRequests,
            stats: stats,
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

        // Transform data (same as above)
        const data = request.toJSON();
        const listing = data.listing || {};
        const category = listing.category || {};
        const customer = data.customer || {};
        const provider = data.provider || {};

        let photos = [];
        if (data.request_photos) {
            try {
                photos = typeof data.request_photos === 'string'
                    ? JSON.parse(data.request_photos)
                    : data.request_photos;
            } catch (e) {
                photos = [];
            }
        }

        const transformed = {
            id: data.id.toString(),
            service_title: listing.title || 'Unknown Service',
            category_name: category.name_en || 'Unknown Category',
            customer_name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
            provider_name: `${provider.first_name || ''} ${provider.last_name || ''}`.trim(),
            description: data.description || '',
            location: data.service_location || '',
            photos: photos,
            status: data.status,
            amount: data.final_amount,
            created_at: data.created_at,
            // ... add all other fields as needed
        };

        res.status(200).json({
            success: true,
            message: 'Service request details retrieved successfully',
            data: transformed,
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
// GET REQUEST STATISTICS (Admin)
// GET /api/services/admin/requests/stats
// ═══════════════════════════════════════════════════════════════════════

exports.getRequestStatsAdmin = async (req, res) => {
    try {
        console.log(`📊 [SERVICE_REQUEST_ADMIN] Fetching request statistics`);

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const thisMonth = new Date();
        thisMonth.setDate(1);
        thisMonth.setHours(0, 0, 0, 0);

        // ─────────────────────────────────────────────────────────────────
        // STATUS COUNTS
        // ─────────────────────────────────────────────────────────────────

        const statusCounts = {
            pending: await ServiceRequest.count({ where: { status: 'pending' } }),
            accepted: await ServiceRequest.count({ where: { status: 'accepted' } }),
            rejected: await ServiceRequest.count({ where: { status: 'rejected' } }),
            in_progress: await ServiceRequest.count({ where: { status: 'in_progress' } }),
            payment_pending: await ServiceRequest.count({ where: { status: 'payment_pending' } }),
            payment_confirmation_pending: await ServiceRequest.count({ where: { status: 'payment_confirmation_pending' } }),
            payment_confirmed: await ServiceRequest.count({ where: { status: 'payment_confirmed' } }),
            completed: await ServiceRequest.count({ where: { status: 'completed' } }),
            cancelled: await ServiceRequest.count({ where: { status: 'cancelled' } }),
        };

        // ─────────────────────────────────────────────────────────────────
        // TIME-BASED COUNTS
        // ─────────────────────────────────────────────────────────────────

        const timeCounts = {
            today: await ServiceRequest.count({
                where: { created_at: { [Op.gte]: today } }
            }),
            completed_today: await ServiceRequest.count({
                where: {
                    status: { [Op.in]: ['completed', 'payment_confirmed'] },
                    completed_at: { [Op.gte]: today }
                }
            }),
            this_month: await ServiceRequest.count({
                where: { created_at: { [Op.gte]: thisMonth } }
            }),
            completed_this_month: await ServiceRequest.count({
                where: {
                    status: { [Op.in]: ['completed', 'payment_confirmed'] },
                    completed_at: { [Op.gte]: thisMonth }
                }
            }),
        };

        // ─────────────────────────────────────────────────────────────────
        // REVENUE STATS (Payment Confirmed)
        // ─────────────────────────────────────────────────────────────────

        const revenueToday = await ServiceRequest.sum('final_amount', {
            where: {
                status: 'payment_confirmed',
                payment_confirmed_at: { [Op.gte]: today }
            }
        }) || 0;

        const revenueThisMonth = await ServiceRequest.sum('final_amount', {
            where: {
                status: 'payment_confirmed',
                payment_confirmed_at: { [Op.gte]: thisMonth }
            }
        }) || 0;

        // ─────────────────────────────────────────────────────────────────
        // ACTIVE REQUESTS (not completed, cancelled, or rejected)
        // ─────────────────────────────────────────────────────────────────

        const activeRequests = await ServiceRequest.count({
            where: {
                status: { [Op.notIn]: ['completed', 'cancelled', 'rejected', 'payment_confirmed'] }
            }
        });

        // ─────────────────────────────────────────────────────────────────
        // PAYMENT METHOD BREAKDOWN
        // ─────────────────────────────────────────────────────────────────

        const paymentMethods = {
            mtn: await ServiceRequest.count({
                where: {
                    payment_method: 'mtn_money',
                    status: { [Op.in]: ['payment_pending', 'payment_confirmation_pending', 'payment_confirmed'] }
                }
            }),
            orange: await ServiceRequest.count({
                where: {
                    payment_method: 'orange_money',
                    status: { [Op.in]: ['payment_pending', 'payment_confirmation_pending', 'payment_confirmed'] }
                }
            }),
            cash: await ServiceRequest.count({
                where: {
                    payment_method: 'cash',
                    status: { [Op.in]: ['payment_pending', 'payment_confirmation_pending', 'payment_confirmed'] }
                }
            }),
        };

        // ─────────────────────────────────────────────────────────────────
        // RESPONSE TIME (Average time to accept)
        // ─────────────────────────────────────────────────────────────────

        const acceptedRequests = await ServiceRequest.findAll({
            where: {
                status: { [Op.notIn]: ['pending', 'rejected'] },
                accepted_at: { [Op.not]: null }
            },
            attributes: [
                [sequelize.literal('AVG(TIMESTAMPDIFF(MINUTE, created_at, accepted_at))'), 'avg_response_time']
            ],
            raw: true
        });

        const avgResponseTime = acceptedRequests[0]?.avg_response_time
            ? Math.round(parseFloat(acceptedRequests[0].avg_response_time))
            : 0;

        // ─────────────────────────────────────────────────────────────────
        // BUILD RESPONSE
        // ─────────────────────────────────────────────────────────────────

        const stats = {
            status_counts: statusCounts,
            time_counts: timeCounts,
            revenue: {
                today: parseFloat(revenueToday),
                this_month: parseFloat(revenueThisMonth),
            },
            active_requests: activeRequests,
            payment_methods: paymentMethods,
            avg_response_time_minutes: avgResponseTime,
            total_requests: Object.values(statusCounts).reduce((a, b) => a + b, 0),
        };

        console.log(`✅ [SERVICE_REQUEST_ADMIN] Statistics retrieved successfully`);

        res.status(200).json({
            success: true,
            message: 'Service request statistics retrieved successfully',
            data: stats
        });

    } catch (error) {
        console.error('❌ [SERVICE_REQUEST_ADMIN] Error in getRequestStatsAdmin:', error);
        console.error('Stack trace:', error.stack);

        res.status(500).json({
            success: false,
            message: 'Unable to retrieve statistics. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET REQUESTS BY STATUS (Admin)
// GET /api/services/admin/requests/by-status
// ═══════════════════════════════════════════════════════════════════════

exports.getRequestsByStatus = async (req, res) => {
    try {
        const { status } = req.query;

        if (!status) {
            return res.status(400).json({
                success: false,
                message: 'Status parameter is required',
            });
        }

        console.log(`📋 [SERVICE_REQUEST_ADMIN] Fetching requests by status: ${status}`);

        const requests = await ServiceRequest.findAll({
            where: { status },
            include: [
                {
                    model: ServiceListing,
                    as: 'listing',
                    attributes: ['id', 'listing_id', 'title', 'category_id'],
                    include: [
                        {
                            model: ServiceCategory,
                            as: 'category',
                            attributes: ['id', 'name_en', 'name_fr'],
                        }
                    ]
                },
                {
                    model: Account,
                    as: 'customer',
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'email', 'avatar_url'],
                },
                {
                    model: Account,
                    as: 'provider',
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'email', 'avatar_url'],
                },
            ],
            order: [['created_at', 'DESC']],
            limit: 100, // Limit to avoid overwhelming response
        });

        // Transform data (same as getAllRequests)
        const transformedRequests = requests.map(request => {
            const data = request.toJSON();
            const listing = data.listing || {};
            const category = listing.category || {};
            const customer = data.customer || {};
            const provider = data.provider || {};

            let photos = [];
            if (data.request_photos) {
                try {
                    photos = typeof data.request_photos === 'string'
                        ? JSON.parse(data.request_photos)
                        : data.request_photos;
                } catch (e) {
                    photos = [];
                }
            }

            return {
                id: data.id.toString(),
                request_id: data.request_id || '',
                service_title: listing.title || 'Unknown Service',
                category_name: category.name_en || 'Unknown Category',
                customer_name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || 'Unknown Customer',
                provider_name: `${provider.first_name || ''} ${provider.last_name || ''}`.trim() || 'Unknown Provider',
                description: data.description || '',
                location: data.service_location || '',
                photos: photos,
                status: data.status,
                amount: data.final_amount ? parseFloat(data.final_amount) : null,
                created_at: data.created_at,
                accepted_at: data.accepted_at || null,
                started_at: data.started_at || null,
                completed_at: data.completed_at || null,
            };
        });

        console.log(`✅ [SERVICE_REQUEST_ADMIN] Retrieved ${transformedRequests.length} requests with status: ${status}`);

        res.status(200).json({
            success: true,
            message: `Requests with status "${status}" retrieved successfully`,
            data: transformedRequests,
            count: transformedRequests.length,
        });

    } catch (error) {
        console.error('❌ [SERVICE_REQUEST_ADMIN] Error in getRequestsByStatus:', error);
        console.error('Stack trace:', error.stack);

        res.status(500).json({
            success: false,
            message: 'Unable to retrieve requests by status. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// CANCEL REQUEST (Admin Override)
// POST /api/services/admin/requests/:id/cancel
// ═══════════════════════════════════════════════════════════════════════

exports.cancelRequestAdmin = async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;
        const employee_id = req.user.id;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid request ID. Please provide a valid numeric ID.',
            });
        }

        if (!reason || reason.trim().length < 10) {
            return res.status(400).json({
                success: false,
                message: 'Cancellation reason is required and must be at least 10 characters long.',
            });
        }

        const request = await ServiceRequest.findByPk(id, {
            include: [
                {
                    model: Account,
                    as: 'customer',
                    attributes: ['uuid', 'first_name', 'last_name', 'email'],
                },
                {
                    model: Account,
                    as: 'provider',
                    attributes: ['uuid', 'first_name', 'last_name', 'email'],
                },
            ]
        });

        if (!request) {
            return res.status(404).json({
                success: false,
                message: 'Service request not found.',
            });
        }

        // Check if already completed or cancelled
        if (request.status === 'completed' || request.status === 'payment_confirmed') {
            return res.status(400).json({
                success: false,
                message: 'Cannot cancel a completed request.',
            });
        }

        if (request.status === 'cancelled') {
            return res.status(400).json({
                success: false,
                message: 'Request is already cancelled.',
            });
        }

        // Cancel request
        await request.update({
            status: 'cancelled',
            cancelled_at: new Date(),
            cancellation_reason: `[ADMIN CANCELLATION] ${reason.trim()}`,
        });

        console.log(`❌ [SERVICE_REQUEST_ADMIN] Request cancelled by admin:`, request.request_id, 'by employee:', employee_id);

        // TODO: Send notifications to customer and provider

        res.status(200).json({
            success: true,
            message: 'Service request cancelled successfully by admin.',
            data: {
                id: request.id,
                request_id: request.request_id,
                status: request.status,
                cancelled_at: request.cancelled_at,
                cancellation_reason: request.cancellation_reason,
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_REQUEST_ADMIN] Error in cancelRequestAdmin:', error);
        console.error('Stack trace:', error.stack);

        res.status(500).json({
            success: false,
            message: 'Unable to cancel request. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

module.exports = exports;