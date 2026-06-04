'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE REQUEST CONTROLLER
// controllers/serviceRequest_controller.js
//
// A service request is now purely a contact/booking thread between a customer
// and a provider. WeGo no longer intermediates payment — the parties settle
// directly. All payment and commission handlers have been removed.
//
// ENDPOINTS:
//   POST   /api/services/requests                      → createRequest
//   POST   /api/services/requests/:id/accept           → acceptRequest
//   POST   /api/services/requests/:id/reject           → rejectRequest
//   POST   /api/services/requests/:id/start            → startService
//   POST   /api/services/requests/:id/complete         → completeService
//   POST   /api/services/requests/:id/cancel           → cancelRequest
//   GET    /api/services/requests/my-requests          → getMyRequests
//   GET    /api/services/requests/incoming             → getIncomingRequests
//   GET    /api/services/requests/active               → getActiveService
//   GET    /api/services/requests/provider-active      → getProviderActiveServices
//   GET    /api/services/requests/stats                → getRequestStats
//   GET    /api/services/requests/:id                  → getRequestById
//
// REMOVED vs previous version:
//   ✗  uploadPaymentProof   — WeGo no longer handles payment proof
//   ✗  confirmPayment       — WeGo no longer confirms payments
//   ✗  markAsCompleted      — merged into completeService flow
//   ✗  All commission logic — WeGo takes no cut of service payments
// ═══════════════════════════════════════════════════════════════════════════════

const { ServiceRequest, ServiceListing, Account, ServiceCategory } = require('../models');
const { uploadFileToR2 } = require('../middleware/upload');
const { Op }             = require('sequelize');

// ─────────────────────────────────────────────────────────────────────────────
// HELPER — generate unique request ID
// ─────────────────────────────────────────────────────────────────────────────

const generateRequestId = () => {
    const d      = new Date();
    const year   = d.getFullYear();
    const month  = String(d.getMonth() + 1).padStart(2, '0');
    const day    = String(d.getDate()).padStart(2, '0');
    const random = Math.floor(10000 + Math.random() * 90000);
    return `SRV-${year}${month}${day}-${random}`;
};

// ─────────────────────────────────────────────────────────────────────────────
// CREATE REQUEST
// POST /api/services/requests
//
// Customer contacts a provider by creating a request against their listing.
// Provider then accepts or rejects it.
// ─────────────────────────────────────────────────────────────────────────────

exports.createRequest = async (req, res) => {
    try {
        const {
            listing_id,
            description,
            needed_when,
            scheduled_date,
            scheduled_time,
            service_location,
            latitude,
            longitude,
            customer_budget,
        } = req.body;

        const customer_id = req.user.uuid;

        // ── Validation ────────────────────────────────────────────────────────
        if (!listing_id || isNaN(listing_id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid listing ID. Please select a valid service listing.',
            });
        }

        if (!description || description.trim().length < 20) {
            return res.status(400).json({
                success: false,
                message: 'Description is required and must be at least 20 characters.',
            });
        }

        if (description.length > 1000) {
            return res.status(400).json({
                success: false,
                message: 'Description is too long. Maximum 1000 characters allowed.',
            });
        }

        if (!needed_when || !['asap', 'today', 'tomorrow', 'scheduled'].includes(needed_when)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid timing option. Please select when you need the service.',
            });
        }

        if (needed_when === 'scheduled' && (!scheduled_date || !scheduled_time)) {
            return res.status(400).json({
                success: false,
                message: 'Please provide both date and time for scheduled service.',
            });
        }

        if (!service_location || service_location.trim().length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Service location is required.',
            });
        }

        // ── Check listing is live ─────────────────────────────────────────────
        const listing = await ServiceListing.findByPk(listing_id);

        if (!listing) {
            return res.status(404).json({
                success: false,
                message: 'Service listing not found.',
            });
        }

        if (listing.status !== 'active') {
            return res.status(400).json({
                success: false,
                message: 'This service is not currently available. Please try another listing.',
            });
        }

        // Cannot book your own listing
        if (listing.provider_id === customer_id) {
            return res.status(400).json({
                success: false,
                message: 'You cannot book your own service.',
            });
        }

        // ── Duplicate active request guard ────────────────────────────────────
        const existingActive = await ServiceRequest.findOne({
            where: {
                listing_id,
                customer_id,
                status: ['pending', 'accepted', 'in_progress'],
            },
        });

        if (existingActive) {
            return res.status(409).json({
                success: false,
                message: 'You already have an active request for this service. Please wait for the provider to respond.',
                data: {
                    request_id: existingActive.request_id,
                    status:     existingActive.status,
                },
            });
        }

        // ── Handle optional photos (max 3) ────────────────────────────────────
        let photos = [];
        if (req.files && req.files.length > 0) {
            if (req.files.length > 3) {
                return res.status(400).json({
                    success: false,
                    message: 'Maximum 3 photos allowed per request.',
                });
            }
            try {
                for (const file of req.files) {
                    photos.push(await uploadFileToR2(file, 'service-requests'));
                }
            } catch (uploadError) {
                return res.status(500).json({
                    success: false,
                    message: 'Failed to upload photos. Please try again.',
                });
            }
        }

        // ── Auto-expiry for urgent requests ───────────────────────────────────
        let expires_at = null;
        if (needed_when === 'asap' || needed_when === 'today') {
            expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000);
        }

        // ── Create request ────────────────────────────────────────────────────
        const request = await ServiceRequest.create({
            request_id:       generateRequestId(),
            listing_id,
            provider_id:      listing.provider_id,
            customer_id,
            description:      description.trim(),
            photos:           photos.length > 0 ? photos : null,
            needed_when,
            scheduled_date:   needed_when === 'scheduled' ? scheduled_date : null,
            scheduled_time:   needed_when === 'scheduled' ? scheduled_time : null,
            service_location: service_location.trim(),
            latitude:         latitude  || null,
            longitude:        longitude || null,
            customer_budget:  customer_budget || null,
            expires_at,
            status:           'pending',
        });

        // Increment listing contact count
        await listing.increment('contact_count');

        console.log(`✅ [SERVICE_REQUEST] Created: ${request.request_id}`);

        return res.status(201).json({
            success: true,
            message: 'Service request sent successfully. The provider will respond shortly.',
            data: {
                id:         request.id,
                request_id: request.request_id,
                listing_id: request.listing_id,
                status:     request.status,
                created_at: request.created_at,
                expires_at: request.expires_at,
            },
        });

    } catch (err) {
        console.error('❌ [SERVICE_REQUEST] createRequest error:', err.message);
        if (err.name === 'SequelizeValidationError') {
            return res.status(400).json({ success: false, message: 'Validation error.', errors: err.errors.map(e => e.message) });
        }
        return res.status(500).json({ success: false, message: 'Unable to create request. Please try again.' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPT REQUEST
// POST /api/services/requests/:id/accept
//
// Provider accepts a pending request and optionally sends a message.
// ─────────────────────────────────────────────────────────────────────────────

exports.acceptRequest = async (req, res) => {
    try {
        const { id }               = req.params;
        const { provider_response } = req.body;
        const provider_id          = req.user.uuid;

        if (!id || isNaN(id)) {
            return res.status(400).json({ success: false, message: 'Invalid request ID.' });
        }

        const request = await ServiceRequest.findOne({ where: { id, provider_id } });

        if (!request) {
            return res.status(404).json({ success: false, message: 'Request not found or you do not have permission.' });
        }

        if (request.status !== 'pending') {
            return res.status(400).json({
                success: false,
                message: `Cannot accept a request with status "${request.status}".`,
            });
        }

        // Auto-expire check
        if (request.expires_at && new Date() > new Date(request.expires_at)) {
            await request.update({ status: 'cancelled', cancellation_reason: 'Request expired' });
            return res.status(400).json({ success: false, message: 'This request has expired.' });
        }

        await request.update({
            status:            'accepted',
            provider_response: provider_response ? provider_response.trim() : null,
            accepted_at:       new Date(),
        });

        console.log(`✅ [SERVICE_REQUEST] Accepted: ${request.request_id}`);

        return res.status(200).json({
            success: true,
            message: 'Request accepted. You can now coordinate with the customer.',
            data: {
                id:          request.id,
                request_id:  request.request_id,
                status:      request.status,
                accepted_at: request.accepted_at,
            },
        });

    } catch (err) {
        console.error('❌ [SERVICE_REQUEST] acceptRequest error:', err.message);
        return res.status(500).json({ success: false, message: 'Unable to accept request.' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// REJECT REQUEST
// POST /api/services/requests/:id/reject
//
// Provider declines a pending request with a reason.
// ─────────────────────────────────────────────────────────────────────────────

exports.rejectRequest = async (req, res) => {
    try {
        const { id }               = req.params;
        const { rejection_reason } = req.body;
        const provider_id          = req.user.uuid;

        if (!id || isNaN(id)) {
            return res.status(400).json({ success: false, message: 'Invalid request ID.' });
        }

        if (!rejection_reason || rejection_reason.trim().length < 10) {
            return res.status(400).json({
                success: false,
                message: 'Rejection reason is required (minimum 10 characters).',
            });
        }

        const request = await ServiceRequest.findOne({ where: { id, provider_id } });

        if (!request) {
            return res.status(404).json({ success: false, message: 'Request not found or you do not have permission.' });
        }

        if (request.status !== 'pending') {
            return res.status(400).json({
                success: false,
                message: `Cannot reject a request with status "${request.status}".`,
            });
        }

        await request.update({
            status:           'rejected',
            rejection_reason: rejection_reason.trim(),
            rejected_at:      new Date(),
        });

        console.log(`✅ [SERVICE_REQUEST] Rejected: ${request.request_id}`);

        return res.status(200).json({
            success: true,
            message: 'Request rejected. The customer will be notified.',
            data: {
                id:          request.id,
                request_id:  request.request_id,
                status:      request.status,
                rejected_at: request.rejected_at,
            },
        });

    } catch (err) {
        console.error('❌ [SERVICE_REQUEST] rejectRequest error:', err.message);
        return res.status(500).json({ success: false, message: 'Unable to reject request.' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// START SERVICE
// POST /api/services/requests/:id/start
//
// Provider marks the service as started (on the way / work begun).
// ─────────────────────────────────────────────────────────────────────────────

exports.startService = async (req, res) => {
    try {
        const { id }      = req.params;
        const provider_id = req.user.uuid;

        if (!id || isNaN(id)) {
            return res.status(400).json({ success: false, message: 'Invalid request ID.' });
        }

        const request = await ServiceRequest.findOne({ where: { id, provider_id } });

        if (!request) {
            return res.status(404).json({ success: false, message: 'Request not found or you do not have permission.' });
        }

        if (request.status !== 'accepted') {
            return res.status(400).json({
                success: false,
                message: `Cannot start a service with status "${request.status}". Only accepted requests can be started.`,
            });
        }

        await request.update({ status: 'in_progress', started_at: new Date() });

        console.log(`✅ [SERVICE_REQUEST] Started: ${request.request_id}`);

        return res.status(200).json({
            success: true,
            message: 'Service marked as started. The customer has been notified.',
            data: {
                id:         request.id,
                request_id: request.request_id,
                status:     request.status,
                started_at: request.started_at,
            },
        });

    } catch (err) {
        console.error('❌ [SERVICE_REQUEST] startService error:', err.message);
        return res.status(500).json({ success: false, message: 'Unable to start service.' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// COMPLETE SERVICE
// POST /api/services/requests/:id/complete
//
// Provider marks the service as done.
// final_amount is now informational only — WeGo does not collect it.
// Provider and customer settle payment directly between themselves.
// ─────────────────────────────────────────────────────────────────────────────

exports.completeService = async (req, res) => {
    try {
        const { id }          = req.params;
        const provider_id     = req.user.uuid;
        const {
            work_summary,
            hours_worked,
            materials_cost,
            final_amount,   // informational — not collected by WeGo
        } = req.body;

        if (!id || isNaN(id)) {
            return res.status(400).json({ success: false, message: 'Invalid request ID.' });
        }

        const request = await ServiceRequest.findOne({ where: { id, provider_id } });

        if (!request) {
            return res.status(404).json({ success: false, message: 'Request not found or you do not have permission.' });
        }

        if (request.status !== 'in_progress') {
            return res.status(400).json({
                success: false,
                message: `Cannot complete a service with status "${request.status}". Only in-progress services can be completed.`,
            });
        }

        // Handle optional after-work photos (max 5)
        let after_photos = [];
        if (req.files && req.files.length > 0) {
            if (req.files.length > 5) {
                return res.status(400).json({ success: false, message: 'Maximum 5 after-work photos allowed.' });
            }
            try {
                for (const file of req.files) {
                    after_photos.push(await uploadFileToR2(file, 'service-requests/completed'));
                }
            } catch {
                return res.status(500).json({ success: false, message: 'Failed to upload photos. Please try again.' });
            }
        }

        await request.update({
            status:        'completed',
            completed_at:  new Date(),
            work_summary:  work_summary    ? work_summary.trim() : null,
            hours_worked:  hours_worked    || null,
            materials_cost: materials_cost || null,
            final_amount:  final_amount    || null, // stored for reference / dispute context
            after_photos:  after_photos.length > 0 ? after_photos : null,
        });

        // Increment listing booking count
        const listing = await ServiceListing.findByPk(request.listing_id);
        if (listing) await listing.increment('booking_count');

        console.log(`✅ [SERVICE_REQUEST] Completed: ${request.request_id}`);

        return res.status(200).json({
            success: true,
            message: 'Service marked as complete. Please settle payment directly with the customer.',
            data: {
                id:           request.id,
                request_id:   request.request_id,
                status:       request.status,
                final_amount: request.final_amount,
                completed_at: request.completed_at,
            },
        });

    } catch (err) {
        console.error('❌ [SERVICE_REQUEST] completeService error:', err.message);
        return res.status(500).json({ success: false, message: 'Unable to complete service.' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// CANCEL REQUEST
// POST /api/services/requests/:id/cancel
//
// Either party can cancel before completion.
// ─────────────────────────────────────────────────────────────────────────────

exports.cancelRequest = async (req, res) => {
    try {
        const { id }                  = req.params;
        const { cancellation_reason } = req.body;
        const user_id                 = req.user.uuid;

        if (!id || isNaN(id)) {
            return res.status(400).json({ success: false, message: 'Invalid request ID.' });
        }

        if (!cancellation_reason || cancellation_reason.trim().length < 10) {
            return res.status(400).json({
                success: false,
                message: 'Cancellation reason is required (minimum 10 characters).',
            });
        }

        const request = await ServiceRequest.findOne({
            where: {
                id,
                [Op.or]: [{ customer_id: user_id }, { provider_id: user_id }],
            },
        });

        if (!request) {
            return res.status(404).json({ success: false, message: 'Request not found or you do not have permission.' });
        }

        if (['completed', 'cancelled', 'disputed'].includes(request.status)) {
            return res.status(400).json({
                success: false,
                message: `Cannot cancel a request with status "${request.status}".`,
            });
        }

        await request.update({
            status:              'cancelled',
            cancelled_by:        user_id,
            cancelled_at:        new Date(),
            cancellation_reason: cancellation_reason.trim(),
        });

        console.log(`✅ [SERVICE_REQUEST] Cancelled: ${request.request_id} by ${user_id}`);

        return res.status(200).json({
            success: true,
            message: 'Request cancelled. The other party will be notified.',
            data: {
                id:           request.id,
                request_id:   request.request_id,
                status:       request.status,
                cancelled_at: request.cancelled_at,
            },
        });

    } catch (err) {
        console.error('❌ [SERVICE_REQUEST] cancelRequest error:', err.message);
        return res.status(500).json({ success: false, message: 'Unable to cancel request.' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET MY REQUESTS (Customer)
// GET /api/services/requests/my-requests
// ─────────────────────────────────────────────────────────────────────────────

exports.getMyRequests = async (req, res) => {
    try {
        const customer_id = req.user.uuid;
        const page        = parseInt(req.query.page)  || 1;
        const limit       = parseInt(req.query.limit) || 20;
        const offset      = (page - 1) * limit;
        const { status }  = req.query;

        const where = { customer_id };
        if (status) where.status = status;

        const { count, rows: requests } = await ServiceRequest.findAndCountAll({
            where,
            include: [
                {
                    model:      ServiceListing,
                    as:         'listing',
                    attributes: [
                        'id', 'listing_id', 'title', 'description', 'photos',
                        'pricing_type', 'hourly_rate', 'minimum_charge', 'fixed_price',
                        'city', 'neighborhoods', 'provider_id',
                    ],
                    include: [
                        { model: ServiceCategory, as: 'category', attributes: ['id', 'name_en', 'name_fr'] },
                        { model: Account, as: 'provider', attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url', 'email'] },
                    ],
                },
                {
                    model:      Account,
                    as:         'customer',
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'],
                },
            ],
            limit,
            offset,
            order: [['created_at', 'DESC']],
        });

        const result = requests.map(r => {
            const data = r.toJSON();
            if (data.listing?.provider) {
                data.listing.provider.full_name = `${data.listing.provider.first_name} ${data.listing.provider.last_name}`;
            }
            return data;
        });

        return res.status(200).json({
            success: true,
            message: 'Your service requests retrieved successfully',
            data:    result,
            pagination: {
                total:      count,
                page,
                limit,
                totalPages: Math.ceil(count / limit),
                hasNext:    page < Math.ceil(count / limit),
                hasPrev:    page > 1,
            },
        });

    } catch (err) {
        console.error('❌ [SERVICE_REQUEST] getMyRequests error:', err.message);
        return res.status(500).json({ success: false, message: 'Unable to retrieve your requests.' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET INCOMING REQUESTS (Provider inbox)
// GET /api/services/requests/incoming
// ─────────────────────────────────────────────────────────────────────────────

exports.getIncomingRequests = async (req, res) => {
    try {
        const provider_id = req.user.uuid;
        const page        = parseInt(req.query.page)  || 1;
        const limit       = parseInt(req.query.limit) || 20;
        const offset      = (page - 1) * limit;
        const { status }  = req.query;

        const where = { provider_id };
        if (status) where.status = status;

        const { count, rows: requests } = await ServiceRequest.findAndCountAll({
            where,
            include: [
                {
                    model:      ServiceListing,
                    as:         'listing',
                    attributes: ['id', 'listing_id', 'title', 'category_id', 'pricing_type', 'hourly_rate', 'fixed_price'],
                },
                {
                    model:      Account,
                    as:         'customer',
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'email', 'avatar_url'],
                },
            ],
            limit,
            offset,
            order: [['created_at', 'DESC']],
        });

        const result = requests.map(r => {
            const data = r.toJSON();
            if (data.customer) {
                data.customer.full_name = `${data.customer.first_name} ${data.customer.last_name}`.trim();
            }
            return data;
        });

        return res.status(200).json({
            success: true,
            message: 'Incoming requests retrieved successfully',
            data:    result,
            pagination: {
                total:      count,
                page,
                limit,
                totalPages: Math.ceil(count / limit),
                hasNext:    page < Math.ceil(count / limit),
                hasPrev:    page > 1,
            },
        });

    } catch (err) {
        console.error('❌ [SERVICE_REQUEST] getIncomingRequests error:', err.message);
        return res.status(500).json({ success: false, message: 'Unable to retrieve incoming requests.' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET REQUEST BY ID
// GET /api/services/requests/:id
// ─────────────────────────────────────────────────────────────────────────────

exports.getRequestById = async (req, res) => {
    try {
        const { id }  = req.params;
        const user_id = req.user.uuid;

        if (!id || isNaN(id)) {
            return res.status(400).json({ success: false, message: 'Invalid request ID.' });
        }

        const request = await ServiceRequest.findOne({
            where: {
                id,
                [Op.or]: [{ customer_id: user_id }, { provider_id: user_id }],
            },
            include: [
                {
                    model:      ServiceListing,
                    as:         'listing',
                    attributes: ['id', 'listing_id', 'title', 'description', 'photos', 'pricing_type', 'hourly_rate', 'minimum_charge', 'fixed_price'],
                    include: [{ model: ServiceCategory, as: 'category', attributes: ['id', 'name_en', 'description_en'] }],
                },
                { model: Account, as: 'provider', attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'] },
                { model: Account, as: 'customer', attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'] },
            ],
        });

        if (!request) {
            return res.status(404).json({ success: false, message: 'Request not found or you do not have permission.' });
        }

        return res.status(200).json({
            success: true,
            message: 'Request details retrieved successfully',
            data:    request,
        });

    } catch (err) {
        console.error('❌ [SERVICE_REQUEST] getRequestById error:', err.message);
        return res.status(500).json({ success: false, message: 'Unable to retrieve request.' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET ACTIVE SERVICE (Customer's current active service)
// GET /api/services/requests/active
// ─────────────────────────────────────────────────────────────────────────────

exports.getActiveService = async (req, res) => {
    try {
        const customer_id = req.user.uuid;

        const request = await ServiceRequest.findOne({
            where: {
                customer_id,
                status: ['accepted', 'in_progress'],
            },
            include: [
                { model: ServiceListing, as: 'listing', attributes: ['id', 'listing_id', 'title'] },
                { model: Account, as: 'provider', attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'] },
            ],
            order: [['updated_at', 'DESC']],
        });

        if (!request) {
            return res.status(404).json({ success: false, message: 'No active service found.' });
        }

        return res.status(200).json({
            success: true,
            message: 'Active service retrieved successfully',
            data:    request,
        });

    } catch (err) {
        console.error('❌ [SERVICE_REQUEST] getActiveService error:', err.message);
        return res.status(500).json({ success: false, message: 'Unable to retrieve active service.' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET PROVIDER ACTIVE SERVICES
// GET /api/services/requests/provider-active
// ─────────────────────────────────────────────────────────────────────────────

exports.getProviderActiveServices = async (req, res) => {
    try {
        const provider_id = req.user.uuid;
        const page        = parseInt(req.query.page)  || 1;
        const limit       = parseInt(req.query.limit) || 10;
        const offset      = (page - 1) * limit;

        const { count, rows: requests } = await ServiceRequest.findAndCountAll({
            where: {
                provider_id,
                status: ['accepted', 'in_progress'],
            },
            include: [
                { model: ServiceListing, as: 'listing', attributes: ['id', 'listing_id', 'title'] },
                { model: Account, as: 'customer', attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'] },
            ],
            limit,
            offset,
            order: [['updated_at', 'DESC']],
        });

        return res.status(200).json({
            success: true,
            message: 'Active services retrieved successfully',
            data:    requests,
            pagination: {
                total:      count,
                page,
                limit,
                totalPages: Math.ceil(count / limit),
                hasNext:    page < Math.ceil(count / limit),
                hasPrev:    page > 1,
            },
        });

    } catch (err) {
        console.error('❌ [SERVICE_REQUEST] getProviderActiveServices error:', err.message);
        return res.status(500).json({ success: false, message: 'Unable to retrieve active services.' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET REQUEST STATS (Dashboard summary)
// GET /api/services/requests/stats?user_type=customer|provider
// ─────────────────────────────────────────────────────────────────────────────

exports.getRequestStats = async (req, res) => {
    try {
        const user_id   = req.user.uuid;
        const user_type = req.query.user_type || 'customer';
        const idField   = user_type === 'provider' ? 'provider_id' : 'customer_id';

        const base = { [idField]: user_id };

        const [total, pending, accepted, in_progress, completed, cancelled, disputed] = await Promise.all([
            ServiceRequest.count({ where: { ...base } }),
            ServiceRequest.count({ where: { ...base, status: 'pending' } }),
            ServiceRequest.count({ where: { ...base, status: 'accepted' } }),
            ServiceRequest.count({ where: { ...base, status: 'in_progress' } }),
            ServiceRequest.count({ where: { ...base, status: 'completed' } }),
            ServiceRequest.count({ where: { ...base, status: 'cancelled' } }),
            ServiceRequest.count({ where: { ...base, status: 'disputed' } }),
        ]);

        return res.status(200).json({
            success: true,
            message: 'Request statistics retrieved successfully',
            data: {
                total, pending, accepted,
                in_progress, completed, cancelled, disputed,
            },
        });

    } catch (err) {
        console.error('❌ [SERVICE_REQUEST] getRequestStats error:', err.message);
        return res.status(500).json({ success: false, message: 'Unable to retrieve statistics.' });
    }
};

module.exports = exports;