// backend/src/controllers/backoffice/servicePaymentAdmin.controller.js
// Service Payment Admin Controller - Payment tracking and verification

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
// GET PAYMENT STATISTICS
// GET /api/services/admin/payments/stats
// ═══════════════════════════════════════════════════════════════════════

exports.getPaymentStats = async (req, res) => {
    try {
        console.log('📊 [PAYMENT_ADMIN] Fetching payment statistics...');

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Total payments with payment_confirmed status
        const totalPayments = await ServiceRequest.count({
            where: {
                status: { [Op.in]: ['payment_pending', 'payment_confirmation_pending', 'payment_confirmed'] }
            }
        });

        const confirmedPayments = await ServiceRequest.count({
            where: { status: 'payment_confirmed' }
        });

        const pendingPayments = await ServiceRequest.count({
            where: { status: 'payment_confirmation_pending' }
        });

        const disputedPayments = await ServiceRequest.count({
            where: { status: 'disputed' }
        });

        // Total revenue (confirmed payments only)
        const totalRevenueResult = await ServiceRequest.sum('final_amount', {
            where: {
                status: 'payment_confirmed',
                payment_confirmed_at: { [Op.not]: null }
            }
        }) || 0;

        // Today's revenue
        const todayRevenueResult = await ServiceRequest.sum('final_amount', {
            where: {
                status: 'payment_confirmed',
                payment_confirmed_at: { [Op.gte]: today }
            }
        }) || 0;

        // Today's confirmed count
        const confirmedToday = await ServiceRequest.count({
            where: {
                status: 'payment_confirmed',
                payment_confirmed_at: { [Op.gte]: today }
            }
        });

        // Commission calculation (15%)
        const totalCommission = parseFloat(totalRevenueResult) * 0.15;
        const todayCommission = parseFloat(todayRevenueResult) * 0.15;

        res.status(200).json({
            success: true,
            message: 'Payment statistics retrieved successfully',
            data: {
                total_payments: totalPayments,
                confirmed_payments: confirmedPayments,
                pending_confirmation: pendingPayments,
                disputed_count: disputedPayments,
                total_today: parseFloat(todayRevenueResult),
                confirmed_today: confirmedToday,
                total_commission_today: todayCommission,
                total_payments_count: totalPayments,
            },
        });

        console.log('✅ [PAYMENT_ADMIN] Statistics retrieved successfully');

    } catch (error) {
        console.error('❌ [PAYMENT_ADMIN] Error in getPaymentStats:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve payment statistics.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// MANUAL PAYMENT CONFIRMATION
// POST /api/services/admin/payments/:id/confirm
// ═══════════════════════════════════════════════════════════════════════

exports.confirmPaymentManually = async (req, res) => {
    try {
        const { id } = req.params;
        const employee_id = req.user.id;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid payment ID. Please provide a valid numeric ID.',
            });
        }

        const request = await ServiceRequest.findByPk(id);

        if (!request) {
            return res.status(404).json({
                success: false,
                message: 'Payment request not found'
            });
        }

        if (request.status !== 'payment_confirmation_pending') {
            return res.status(400).json({
                success: false,
                message: `Cannot confirm payment with status "${request.status}". Must be "payment_confirmation_pending".`
            });
        }

        // Confirm payment
        await request.update({
            status: 'payment_confirmed',
            payment_confirmed_at: new Date(),
            payment_confirmed_by: employee_id,
        });

        console.log(`✅ [PAYMENT_ADMIN] Payment confirmed manually:`, request.request_id, 'by employee:', employee_id);

        // TODO: Send notifications to customer and provider

        res.status(200).json({
            success: true,
            message: 'Payment confirmed manually by admin.',
            data: {
                id: request.id,
                request_id: request.request_id,
                status: request.status,
                payment_confirmed_at: request.payment_confirmed_at,
            },
        });

    } catch (error) {
        console.error('❌ [PAYMENT_ADMIN] Error in confirmPaymentManually:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to confirm payment manually.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// MARK PAYMENT AS DISPUTED
// POST /api/services/admin/payments/:id/dispute
// ═══════════════════════════════════════════════════════════════════════

exports.markPaymentAsDisputed = async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;
        const employee_id = req.user.id;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid payment ID. Please provide a valid numeric ID.',
            });
        }

        if (!reason || reason.trim().length < 10) {
            return res.status(400).json({
                success: false,
                message: 'Dispute reason is required and must be at least 10 characters long.',
            });
        }

        const request = await ServiceRequest.findByPk(id);

        if (!request) {
            return res.status(404).json({
                success: false,
                message: 'Payment request not found'
            });
        }

        // Mark as disputed
        await request.update({
            status: 'disputed',
            dispute_reason: reason.trim(),
            disputed_by: employee_id,
            disputed_at: new Date(),
        });

        console.log(`⚠️ [PAYMENT_ADMIN] Payment marked as disputed:`, request.request_id, 'by employee:', employee_id);

        // TODO: Send notifications

        res.status(200).json({
            success: true,
            message: 'Payment marked as disputed successfully.',
            data: {
                id: request.id,
                request_id: request.request_id,
                status: request.status,
                dispute_reason: request.dispute_reason,
                disputed_at: request.disputed_at,
            },
        });

    } catch (error) {
        console.error('❌ [PAYMENT_ADMIN] Error in markPaymentAsDisputed:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to mark payment as disputed.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET PAYMENT BY ID
// GET /api/services/admin/payments/:id
// ═══════════════════════════════════════════════════════════════════════

exports.getPaymentById = async (req, res) => {
    try {
        const { id } = req.params;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid payment ID. Please provide a valid numeric ID.',
            });
        }

        const request = await ServiceRequest.findByPk(id, {
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
                    attributes: ['uuid', 'first_name', 'last_name', 'email', 'phone_e164', 'avatar_url'],
                },
                {
                    model: Account,
                    as: 'provider',
                    attributes: ['uuid', 'first_name', 'last_name', 'email', 'phone_e164', 'avatar_url'],
                },
            ],
        });

        if (!request) {
            return res.status(404).json({
                success: false,
                message: 'Payment not found.',
            });
        }

        // Transform to match frontend expectations
        const data = request.toJSON();
        const listing = data.listing || {};
        const category = listing.category || {};
        const customer = data.customer || {};
        const provider = data.provider || {};

        const transformed = {
            id: data.id.toString(),
            service_request_id: data.request_id || '',
            service_title: listing.title || 'Unknown Service',
            customer_id: customer.uuid || '',
            customer_name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || 'Unknown',
            customer_phone: customer.phone_e164 || '',
            provider_id: provider.uuid || '',
            provider_name: `${provider.first_name || ''} ${provider.last_name || ''}`.trim() || 'Unknown',
            provider_phone: provider.phone_e164 || '',
            amount: data.final_amount ? parseFloat(data.final_amount) : 0,
            commission_percentage: 15,
            commission_amount: data.final_amount ? parseFloat(data.final_amount) * 0.15 : 0,
            provider_net_amount: data.final_amount ? parseFloat(data.final_amount) * 0.85 : 0,
            payment_method: data.payment_method || null,
            payment_proof_url: data.payment_proof_url || null,
            transaction_reference: data.transaction_reference || null,
            status: data.payment_proof_url && data.status === 'payment_confirmation_pending' ? 'proof_uploaded' :
                data.status === 'payment_pending' ? 'pending' :
                    data.status === 'payment_confirmed' ? 'confirmed' :
                        data.status === 'disputed' ? 'disputed' : 'pending',
            paid_at: data.payment_proof_uploaded_at || null,
            confirmed_at: data.payment_confirmed_at || null,
            created_at: data.created_at,
            auto_confirm_at: data.auto_confirm_at || null,
        };

        res.status(200).json({
            success: true,
            message: 'Payment details retrieved successfully',
            data: transformed,
        });

    } catch (error) {
        console.error('❌ [PAYMENT_ADMIN] Error in getPaymentById:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve payment details.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET ALL PAYMENTS (with filters)
// GET /api/services/admin/payments
// ═══════════════════════════════════════════════════════════════════════

exports.getAllPayments = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const offset = (page - 1) * limit;

        const { status, payment_method, search, date_from, date_to } = req.query;

        console.log(`📋 [PAYMENT_ADMIN] Fetching all payments - Page: ${page}, Status: ${status || 'all'}`);

        // Build where clause
        const where = {
            status: {
                [Op.in]: ['payment_pending', 'payment_confirmation_pending', 'payment_confirmed', 'disputed']
            }
        };

        // Status filter mapping
        if (status && status !== 'all') {
            if (status === 'pending') {
                where.status = 'payment_pending';
            } else if (status === 'proof_uploaded') {
                where.status = 'payment_confirmation_pending';
            } else if (status === 'confirmed') {
                where.status = 'payment_confirmed';
            } else if (status === 'disputed') {
                where.status = 'disputed';
            }
        }

        // Payment method filter
        if (payment_method && payment_method !== 'all') {
            where.payment_method = payment_method;
        }

        // Search filter
        if (search) {
            where[Op.or] = [
                { request_id: { [Op.like]: `%${search}%` } },
                { transaction_reference: { [Op.like]: `%${search}%` } },
            ];
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

        const { count, rows: requests } = await ServiceRequest.findAndCountAll({
            where,
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
                    attributes: ['uuid', 'first_name', 'last_name', 'email', 'phone_e164', 'avatar_url'],
                },
                {
                    model: Account,
                    as: 'provider',
                    attributes: ['uuid', 'first_name', 'last_name', 'email', 'phone_e164', 'avatar_url'],
                },
            ],
            limit,
            offset,
            order: [['created_at', 'DESC']],
        });

        // Transform data
        const transformedPayments = requests.map(request => {
            const data = request.toJSON();
            const listing = data.listing || {};
            const customer = data.customer || {};
            const provider = data.provider || {};

            const amount = data.final_amount ? parseFloat(data.final_amount) : 0;

            return {
                id: data.id.toString(),
                service_request_id: data.request_id || '',
                service_title: listing.title || 'Unknown Service',
                customer_id: customer.uuid || '',
                customer_name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || 'Unknown',
                customer_phone: customer.phone_e164 || '',
                provider_id: provider.uuid || '',
                provider_name: `${provider.first_name || ''} ${provider.last_name || ''}`.trim() || 'Unknown',
                provider_phone: provider.phone_e164 || '',
                amount: amount,
                commission_percentage: 15,
                commission_amount: amount * 0.15,
                provider_net_amount: amount * 0.85,
                payment_method: data.payment_method || null,
                payment_proof_url: data.payment_proof_url || null,
                transaction_reference: data.transaction_reference || null,
                status: data.payment_proof_url && data.status === 'payment_confirmation_pending' ? 'proof_uploaded' :
                    data.status === 'payment_pending' ? 'pending' :
                        data.status === 'payment_confirmed' ? 'confirmed' :
                            data.status === 'disputed' ? 'disputed' : 'pending',
                paid_at: data.payment_proof_uploaded_at || null,
                confirmed_at: data.payment_confirmed_at || null,
                created_at: data.created_at,
                auto_confirm_at: data.auto_confirm_at || null,
            };
        });

        const totalPages = Math.ceil(count / limit);

        // Get stats
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const stats = {
            total_today: await ServiceRequest.sum('final_amount', {
                where: {
                    status: 'payment_confirmed',
                    payment_confirmed_at: { [Op.gte]: today }
                }
            }) || 0,
            pending_confirmation: await ServiceRequest.count({
                where: { status: 'payment_confirmation_pending' }
            }),
            confirmed_today: await ServiceRequest.count({
                where: {
                    status: 'payment_confirmed',
                    payment_confirmed_at: { [Op.gte]: today }
                }
            }),
            total_commission_today: (await ServiceRequest.sum('final_amount', {
                where: {
                    status: 'payment_confirmed',
                    payment_confirmed_at: { [Op.gte]: today }
                }
            }) || 0) * 0.15,
            total_payments_count: count,
            disputed_count: await ServiceRequest.count({ where: { status: 'disputed' } }),
        };

        console.log(`✅ [PAYMENT_ADMIN] Retrieved ${count} total payments, returning ${requests.length} for page ${page}`);

        res.status(200).json({
            success: true,
            message: 'Payments retrieved successfully',
            payments: transformedPayments,
            stats: stats,
            pagination: {
                total: count,
                page,
                limit,
                totalPages,
                hasNext: page < totalPages,
                hasPrev: page > 1,
            },
        });

    } catch (error) {
        console.error('❌ [PAYMENT_ADMIN] Error in getAllPayments:', error);
        console.error('Stack trace:', error.stack);

        res.status(500).json({
            success: false,
            message: 'Unable to retrieve payments.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

module.exports = exports;