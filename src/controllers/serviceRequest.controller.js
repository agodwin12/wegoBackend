// backend/src/controllers/serviceRequest.controller.js
// Service Request Controller - Customer Bookings & Service Execution

const { ServiceRequest, ServiceListing, Account, ServiceCategory } = require('../models');
const { uploadFileToR2, deleteFile } = require('../middleware/upload');
const { Op } = require('sequelize');

// ═══════════════════════════════════════════════════════════════════════
// GENERATE UNIQUE REQUEST ID
// ═══════════════════════════════════════════════════════════════════════

const generateRequestId = () => {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const random = Math.floor(10000 + Math.random() * 90000);
    return `SRV-${year}${month}${day}-${random}`;
};

// ═══════════════════════════════════════════════════════════════════════
// CREATE SERVICE REQUEST (Customer contacts provider)
// POST /api/services/requests
// ═══════════════════════════════════════════════════════════════════════

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

        const customer_id = req.user.uuid; // From auth middleware

        // ─────────────────────────────────────────────────────────────────
        // VALIDATION
        // ─────────────────────────────────────────────────────────────────

        if (!listing_id || isNaN(listing_id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid listing ID. Please select a valid service listing.',
            });
        }

        if (!description || description.trim().length < 20) {
            return res.status(400).json({
                success: false,
                message: 'Description is required and must be at least 20 characters long.',
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
                message: 'Service location is required. Please provide where you need the service.',
            });
        }

        // ─────────────────────────────────────────────────────────────────
        // CHECK LISTING EXISTS AND IS ACTIVE
        // ─────────────────────────────────────────────────────────────────

        const listing = await ServiceListing.findByPk(listing_id);

        if (!listing) {
            return res.status(404).json({
                success: false,
                message: 'Service listing not found. Please select a valid listing.',
            });
        }

        if (listing.status !== 'active') {
            return res.status(400).json({
                success: false,
                message: 'This service is not currently available. Please try another listing.',
            });
        }

        // Check if customer is trying to book their own service
        if (listing.provider_id === customer_id) {
            return res.status(400).json({
                success: false,
                message: 'You cannot book your own service. Please select a different listing.',
            });
        }

        // ─────────────────────────────────────────────────────────────────
        // CHECK FOR DUPLICATE ACTIVE REQUEST
        // ─────────────────────────────────────────────────────────────────

        const existingActiveRequest = await ServiceRequest.findOne({
            where: {
                listing_id,
                customer_id,
                status: ['pending', 'accepted', 'in_progress'],
            }
        });

        if (existingActiveRequest) {
            return res.status(409).json({
                success: false,
                message: 'You already have an active request for this service. Please wait for the provider to respond.',
                data: {
                    request_id: existingActiveRequest.request_id,
                    status: existingActiveRequest.status,
                }
            });
        }

        // ─────────────────────────────────────────────────────────────────
        // HANDLE PHOTO UPLOADS (max 3)
        // ─────────────────────────────────────────────────────────────────

        let photos = [];
        if (req.files && req.files.length > 0) {
            if (req.files.length > 3) {
                return res.status(400).json({
                    success: false,
                    message: 'Too many photos. Maximum 3 photos allowed per request.',
                });
            }

            try {
                for (const file of req.files) {
                    const photoUrl = await uploadFileToR2(file, 'service-requests');
                    photos.push(photoUrl);
                }
            } catch (uploadError) {
                console.error('❌ [SERVICE_REQUEST_CONTROLLER] Photo upload failed:', uploadError);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to upload photos. Please try again.',
                });
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // CREATE REQUEST
        // ─────────────────────────────────────────────────────────────────

        const request_id = generateRequestId();

        // Set expiry time (24 hours from now if not scheduled)
        let expires_at = null;
        if (needed_when === 'asap' || needed_when === 'today') {
            expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000);
        }

        const request = await ServiceRequest.create({
            request_id,
            listing_id,
            provider_id: listing.provider_id,
            customer_id,
            description: description.trim(),
            photos: photos.length > 0 ? photos : null,
            needed_when,
            scheduled_date: needed_when === 'scheduled' ? scheduled_date : null,
            scheduled_time: needed_when === 'scheduled' ? scheduled_time : null,
            service_location: service_location.trim(),
            latitude: latitude || null,
            longitude: longitude || null,
            customer_budget: customer_budget || null,
            expires_at,
            status: 'pending',
        });

        // Increment contact count on listing
        await listing.increment('contact_count');

        console.log('✅ [SERVICE_REQUEST_CONTROLLER] Request created:', request.request_id);

        // TODO: Send notification to provider
        // - Push notification: "New service request from [customer name]"
        // - SMS notification if enabled
        // - Email notification

        res.status(201).json({
            success: true,
            message: 'Service request sent successfully. The provider will review and respond shortly.',
            data: {
                id: request.id,
                request_id: request.request_id,
                listing_id: request.listing_id,
                status: request.status,
                created_at: request.created_at,
                expires_at: request.expires_at,
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_REQUEST_CONTROLLER] Error in createRequest:', error);

        if (error.name === 'SequelizeValidationError') {
            return res.status(400).json({
                success: false,
                message: 'Validation error. Please check your input and try again.',
                errors: error.errors.map(e => e.message),
            });
        }

        res.status(500).json({
            success: false,
            message: 'Unable to create service request. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// ACCEPT REQUEST (Provider accepts customer request)
// POST /api/services/requests/:id/accept
// ═══════════════════════════════════════════════════════════════════════

exports.acceptRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const { provider_response } = req.body;
        const provider_id = req.user.uuid;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid request ID. Please provide a valid numeric ID.',
            });
        }

        const request = await ServiceRequest.findOne({
            where: { id, provider_id }
        });

        if (!request) {
            return res.status(404).json({
                success: false,
                message: 'Request not found or you do not have permission to accept it.',
            });
        }

        if (request.status !== 'pending') {
            return res.status(400).json({
                success: false,
                message: `Cannot accept request with status "${request.status}". Only pending requests can be accepted.`,
            });
        }

        // Check if request has expired
        if (request.expires_at && new Date() > new Date(request.expires_at)) {
            await request.update({ status: 'cancelled', cancellation_reason: 'Request expired' });
            return res.status(400).json({
                success: false,
                message: 'This request has expired and cannot be accepted.',
            });
        }

        // Accept request
        await request.update({
            status: 'accepted',
            provider_response: provider_response ? provider_response.trim() : null,
            accepted_at: new Date(),
        });

        console.log('✅ [SERVICE_REQUEST_CONTROLLER] Request accepted:', request.request_id);

        // TODO: Send notification to customer
        // - Push notification: "Provider accepted your request!"
        // - SMS notification
        // - Enable in-app messaging between provider and customer

        res.status(200).json({
            success: true,
            message: 'Request accepted successfully. You can now coordinate with the customer.',
            data: {
                id: request.id,
                request_id: request.request_id,
                status: request.status,
                accepted_at: request.accepted_at,
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_REQUEST_CONTROLLER] Error in acceptRequest:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to accept request. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// REJECT REQUEST (Provider rejects customer request)
// POST /api/services/requests/:id/reject
// ═══════════════════════════════════════════════════════════════════════

exports.rejectRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const { rejection_reason } = req.body;
        const provider_id = req.user.uuid;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid request ID. Please provide a valid numeric ID.',
            });
        }

        if (!rejection_reason || rejection_reason.trim().length < 10) {
            return res.status(400).json({
                success: false,
                message: 'Rejection reason is required and must be at least 10 characters long.',
            });
        }

        const request = await ServiceRequest.findOne({
            where: { id, provider_id }
        });

        if (!request) {
            return res.status(404).json({
                success: false,
                message: 'Request not found or you do not have permission to reject it.',
            });
        }

        if (request.status !== 'pending') {
            return res.status(400).json({
                success: false,
                message: `Cannot reject request with status "${request.status}". Only pending requests can be rejected.`,
            });
        }

        // Reject request
        await request.update({
            status: 'rejected',
            rejection_reason: rejection_reason.trim(),
            rejected_at: new Date(),
        });

        console.log('✅ [SERVICE_REQUEST_CONTROLLER] Request rejected:', request.request_id);

        // TODO: Send notification to customer
        // - Push notification: "Provider declined your request"
        // - Include rejection reason

        res.status(200).json({
            success: true,
            message: 'Request rejected. The customer will be notified.',
            data: {
                id: request.id,
                request_id: request.request_id,
                status: request.status,
                rejected_at: request.rejected_at,
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_REQUEST_CONTROLLER] Error in rejectRequest:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to reject request. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// START SERVICE (Provider marks as started/on the way)
// POST /api/services/requests/:id/start
// ═══════════════════════════════════════════════════════════════════════

exports.startService = async (req, res) => {
    try {
        const { id } = req.params;
        const provider_id = req.user.uuid;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid request ID. Please provide a valid numeric ID.',
            });
        }

        const request = await ServiceRequest.findOne({
            where: { id, provider_id }
        });

        if (!request) {
            return res.status(404).json({
                success: false,
                message: 'Request not found or you do not have permission to start it.',
            });
        }

        if (request.status !== 'accepted') {
            return res.status(400).json({
                success: false,
                message: `Cannot start service with status "${request.status}". Only accepted requests can be started.`,
            });
        }

        // Start service
        await request.update({
            status: 'in_progress',
            started_at: new Date(),
        });

        console.log('✅ [SERVICE_REQUEST_CONTROLLER] Service started:', request.request_id);

        // TODO: Send notification to customer
        // - Push notification: "Provider is on the way!"
        // - Enable live location tracking if applicable

        res.status(200).json({
            success: true,
            message: 'Service marked as started. Customer will be notified.',
            data: {
                id: request.id,
                request_id: request.request_id,
                status: request.status,
                started_at: request.started_at,
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_REQUEST_CONTROLLER] Error in startService:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to start service. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// COMPLETE SERVICE (Provider marks service complete & requests payment)
// POST /api/services/requests/:id/complete
// ═══════════════════════════════════════════════════════════════════════

exports.completeService = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            work_summary,
            hours_worked,
            materials_cost,
            final_amount,
        } = req.body;
        const provider_id = req.user.uuid;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid request ID. Please provide a valid numeric ID.',
            });
        }

        // Validation
        if (!final_amount || final_amount < 500) {
            return res.status(400).json({
                success: false,
                message: 'Final amount is required and must be at least 500 FCFA.',
            });
        }

        const request = await ServiceRequest.findOne({
            where: { id, provider_id }
        });

        if (!request) {
            return res.status(404).json({
                success: false,
                message: 'Request not found or you do not have permission to complete it.',
            });
        }

        if (request.status !== 'in_progress') {
            return res.status(400).json({
                success: false,
                message: `Cannot complete service with status "${request.status}". Only in-progress services can be completed.`,
            });
        }

        // Handle after photos upload
        let after_photos = [];
        if (req.files && req.files.length > 0) {
            if (req.files.length > 5) {
                return res.status(400).json({
                    success: false,
                    message: 'Too many photos. Maximum 5 after-work photos allowed.',
                });
            }

            try {
                for (const file of req.files) {
                    const photoUrl = await uploadFileToR2(file, 'service-requests/completed');
                    after_photos.push(photoUrl);
                }
            } catch (uploadError) {
                console.error('❌ [SERVICE_REQUEST_CONTROLLER] Photo upload failed:', uploadError);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to upload photos. Please try again.',
                });
            }
        }

        // Calculate commission
        const commission_percentage = parseFloat(process.env.SERVICE_COMMISSION_PERCENTAGE) || 15.0;
        const commission_amount = (final_amount * commission_percentage) / 100;
        const provider_net_amount = final_amount - commission_amount;

        // Complete service
        await request.update({
            status: 'payment_pending',
            completed_at: new Date(),
            work_summary: work_summary ? work_summary.trim() : null,
            hours_worked: hours_worked || null,
            materials_cost: materials_cost || null,
            final_amount,
            after_photos: after_photos.length > 0 ? after_photos : null,
            commission_percentage,
            commission_amount,
            provider_net_amount,
        });

        // Increment booking count on listing
        const listing = await ServiceListing.findByPk(request.listing_id);
        if (listing) {
            await listing.increment('booking_count');
        }

        console.log('✅ [SERVICE_REQUEST_CONTROLLER] Service completed:', request.request_id);

        // TODO: Send notification to customer
        // - Push notification: "Service completed! Payment requested: XX FCFA"
        // - Show payment screen

        res.status(200).json({
            success: true,
            message: 'Service marked as complete. Payment request sent to customer.',
            data: {
                id: request.id,
                request_id: request.request_id,
                status: request.status,
                final_amount: request.final_amount,
                commission_amount: request.commission_amount,
                provider_net_amount: request.provider_net_amount,
                completed_at: request.completed_at,
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_REQUEST_CONTROLLER] Error in completeService:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to complete service. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// UPLOAD PAYMENT PROOF (Customer uploads payment screenshot)
// POST /api/services/requests/:id/payment-proof
// ═══════════════════════════════════════════════════════════════════════

exports.uploadPaymentProof = async (req, res) => {
    try {
        const { id } = req.params;
        const { payment_method, payment_reference } = req.body;
        const customer_id = req.user.uuid;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid request ID. Please provide a valid numeric ID.',
            });
        }

        if (!payment_method || !['mtn_momo', 'orange_money', 'cash'].includes(payment_method)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid payment method. Please select MTN MoMo, Orange Money, or Cash.',
            });
        }

        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'Payment proof screenshot is required. Please upload an image.',
            });
        }

        const request = await ServiceRequest.findOne({
            where: { id, customer_id }
        });

        if (!request) {
            return res.status(404).json({
                success: false,
                message: 'Request not found or you do not have permission to upload payment.',
            });
        }

        if (request.status !== 'payment_pending') {
            return res.status(400).json({
                success: false,
                message: `Cannot upload payment proof for request with status "${request.status}".`,
            });
        }

        // Upload payment proof
        let payment_proof_url;
        try {
            payment_proof_url = await uploadFileToR2(req.file, 'service-requests/payments');
        } catch (uploadError) {
            console.error('❌ [SERVICE_REQUEST_CONTROLLER] Payment proof upload failed:', uploadError);
            return res.status(500).json({
                success: false,
                message: 'Failed to upload payment proof. Please try again.',
            });
        }

        // Update request
        await request.update({
            status: 'payment_confirmation_pending',
            payment_method,
            payment_proof_url,
            payment_reference: payment_reference || null,
            payment_marked_at: new Date(),
        });

        console.log('✅ [SERVICE_REQUEST_CONTROLLER] Payment proof uploaded:', request.request_id);

        // TODO: Send notification to provider
        // - Push notification: "Customer uploaded payment proof"
        // - Request confirmation

        res.status(200).json({
            success: true,
            message: 'Payment proof uploaded successfully. Waiting for provider confirmation.',
            data: {
                id: request.id,
                request_id: request.request_id,
                status: request.status,
                payment_method: request.payment_method,
                payment_marked_at: request.payment_marked_at,
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_REQUEST_CONTROLLER] Error in uploadPaymentProof:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to upload payment proof. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// CONFIRM PAYMENT (Provider confirms receiving payment)
// POST /api/services/requests/:id/confirm-payment
// ═══════════════════════════════════════════════════════════════════════

exports.confirmPayment = async (req, res) => {
    try {
        const { id } = req.params;
        const provider_id = req.user.uuid;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid request ID. Please provide a valid numeric ID.',
            });
        }

        const request = await ServiceRequest.findOne({
            where: { id, provider_id }
        });

        if (!request) {
            return res.status(404).json({
                success: false,
                message: 'Request not found or you do not have permission to confirm payment.',
            });
        }

        if (request.status !== 'payment_confirmation_pending') {
            return res.status(400).json({
                success: false,
                message: `Cannot confirm payment for request with status "${request.status}".`,
            });
        }

        // Confirm payment
        await request.update({
            status: 'payment_confirmed',
            payment_confirmed_at: new Date(),
        });

        console.log('✅ [SERVICE_REQUEST_CONTROLLER] Payment confirmed:', request.request_id);

        // TODO: Send notification to customer
        // - Push notification: "Payment confirmed! Please rate the service"

        res.status(200).json({
            success: true,
            message: 'Payment confirmed successfully. Transaction is now complete.',
            data: {
                id: request.id,
                request_id: request.request_id,
                status: request.status,
                final_amount: request.final_amount,
                commission_amount: request.commission_amount,
                provider_net_amount: request.provider_net_amount,
                payment_confirmed_at: request.payment_confirmed_at,
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_REQUEST_CONTROLLER] Error in confirmPayment:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to confirm payment. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// MARK AS COMPLETED (After payment confirmed)
// POST /api/services/requests/:id/mark-completed
// ═══════════════════════════════════════════════════════════════════════

exports.markAsCompleted = async (req, res) => {
    try {
        const { id } = req.params;
        const provider_id = req.user.uuid;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid request ID. Please provide a valid numeric ID.',
            });
        }

        const request = await ServiceRequest.findOne({
            where: { id, provider_id }
        });

        if (!request) {
            return res.status(404).json({
                success: false,
                message: 'Request not found or you do not have permission.',
            });
        }

        if (request.status !== 'payment_confirmed') {
            return res.status(400).json({
                success: false,
                message: `Cannot mark as completed. Current status: "${request.status}".`,
            });
        }

        // Mark as completed
        await request.update({ status: 'completed' });

        console.log('✅ [SERVICE_REQUEST_CONTROLLER] Request marked as completed:', request.request_id);

        // TODO: Prompt customer to rate the service

        res.status(200).json({
            success: true,
            message: 'Service request marked as completed successfully.',
            data: {
                id: request.id,
                request_id: request.request_id,
                status: request.status,
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_REQUEST_CONTROLLER] Error in markAsCompleted:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to mark as completed. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// CANCEL REQUEST (Customer or Provider can cancel)
// POST /api/services/requests/:id/cancel
// ═══════════════════════════════════════════════════════════════════════

exports.cancelRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const { cancellation_reason } = req.body;
        const user_id = req.user.uuid;

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

        const request = await ServiceRequest.findOne({
            where: {
                id,
                [Op.or]: [
                    { customer_id: user_id },
                    { provider_id: user_id }
                ]
            }
        });

        if (!request) {
            return res.status(404).json({
                success: false,
                message: 'Request not found or you do not have permission to cancel it.',
            });
        }

        // Cannot cancel if already completed or in certain states
        if (['completed', 'cancelled', 'disputed'].includes(request.status)) {
            return res.status(400).json({
                success: false,
                message: `Cannot cancel request with status "${request.status}".`,
            });
        }

        // Cannot cancel if payment is already in process
        if (['payment_pending', 'payment_confirmation_pending', 'payment_confirmed'].includes(request.status)) {
            return res.status(400).json({
                success: false,
                message: 'Cannot cancel request during payment process. Please contact support if you need assistance.',
            });
        }

        // Cancel request
        await request.update({
            status: 'cancelled',
            cancelled_by: user_id,
            cancelled_at: new Date(),
            cancellation_reason: cancellation_reason.trim(),
        });

        console.log('✅ [SERVICE_REQUEST_CONTROLLER] Request cancelled:', request.request_id, 'by:', user_id);

        // TODO: Send notification to other party
        // - Notify provider if customer cancelled
        // - Notify customer if provider cancelled

        res.status(200).json({
            success: true,
            message: 'Request cancelled successfully. The other party will be notified.',
            data: {
                id: request.id,
                request_id: request.request_id,
                status: request.status,
                cancelled_at: request.cancelled_at,
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_REQUEST_CONTROLLER] Error in cancelRequest:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to cancel request. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET MY REQUESTS (Customer's service requests)
// ═══════════════════════════════════════════════════════════════════════

exports.getMyRequests = async (req, res) => {
    try {
        const customer_id = req.user.uuid;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;
        const { status } = req.query;

        console.log(`🔵 [GET_MY_REQUESTS] Customer: ${customer_id}, Page: ${page}, Status: ${status || 'all'}`);

        // Build where clause
        const where = { customer_id };
        if (status) {
            where.status = status;
        }

        // Fetch requests with nested data
        const { count, rows: requests } = await ServiceRequest.findAndCountAll({
            where,
            include: [
                {
                    model: ServiceListing,
                    as: 'listing',
                    attributes: [
                        'id',
                        'listing_id',
                        'title',
                        'description',
                        'photos',
                        'pricing_type',
                        'hourly_rate',
                        'minimum_charge',
                        'fixed_price',
                        'city',
                        'neighborhoods',
                        'provider_id', // ✅ Include provider_id
                    ],
                    include: [
                        {
                            model: ServiceCategory,
                            as: 'category',
                            attributes: ['id', 'name_en', 'name_fr'],
                        },
                        {
                            // ✅ FIX: Nest provider inside listing
                            model: Account,
                            as: 'provider',
                            attributes: [
                                'uuid',
                                'first_name',
                                'last_name',
                                'phone_e164',
                                'avatar_url',
                                'email'
                            ],
                        }
                    ]
                },
                {
                    // ✅ ALSO include customer data (useful for admin views)
                    model: Account,
                    as: 'customer',
                    attributes: [
                        'uuid',
                        'first_name',
                        'last_name',
                        'phone_e164',
                        'avatar_url'
                    ],
                },
            ],
            limit,
            offset,
            order: [['created_at', 'DESC']],
        });

        const totalPages = Math.ceil(count / limit);

        // ✅ Transform data to include full_name for easier frontend access
        const transformedRequests = requests.map(request => {
            const requestData = request.toJSON();

            // Add computed fields for easier access
            if (requestData.listing && requestData.listing.provider) {
                requestData.listing.provider.full_name =
                    `${requestData.listing.provider.first_name} ${requestData.listing.provider.last_name}`;
                requestData.listing.provider.fullName =
                    `${requestData.listing.provider.first_name} ${requestData.listing.provider.last_name}`;
            }

            if (requestData.customer) {
                requestData.customer.full_name =
                    `${requestData.customer.first_name} ${requestData.customer.last_name}`;
                requestData.customer.fullName =
                    `${requestData.customer.first_name} ${requestData.customer.last_name}`;
            }

            return requestData;
        });

        console.log(`✅ [GET_MY_REQUESTS] Retrieved ${count} total requests, returning ${requests.length} for page ${page}`);

        res.status(200).json({
            success: true,
            message: 'Your service requests retrieved successfully',
            data: transformedRequests, // ✅ Return transformed data
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
        console.error('❌ [SERVICE_REQUEST_CONTROLLER] Error in getMyRequests:', error);
        console.error('Stack trace:', error.stack);

        res.status(500).json({
            success: false,
            message: 'Unable to retrieve your requests. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};


exports.getIncomingRequests = async (req, res) => {
    try {
        const provider_id = req.user.uuid;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;
        const { status } = req.query;

        console.log(`📥 [REQUESTS] Fetching incoming requests for provider: ${provider_id}`);
        if (status) {
            console.log(`📥 [REQUESTS] Filtering by status: ${status}`);
        }

        const where = { provider_id };
        if (status) {
            where.status = status;
        }

        const { count, rows: requests } = await ServiceRequest.findAndCountAll({
            where,
            include: [
                {
                    model: ServiceListing,
                    as: 'listing',
                    attributes: ['id', 'listing_id', 'title', 'category_id', 'pricing_type', 'hourly_rate', 'fixed_price'],
                },
                {
                    model: Account,
                    as: 'customer',
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'email', 'avatar_url'],
                },
            ],
            limit,
            offset,
            order: [['created_at', 'DESC']],
        });

        // ✅ TRANSFORM DATA: Add full_name and fullName to customer
        const transformedRequests = requests.map(request => {
            const data = request.toJSON();

            // Add full_name and fullName to customer
            if (data.customer) {
                const firstName = data.customer.first_name || '';
                const lastName = data.customer.last_name || '';
                data.customer.full_name = `${firstName} ${lastName}`.trim();
                data.customer.fullName = data.customer.full_name;

                console.log(`👤 [REQUESTS] Customer: ${data.customer.full_name} (${data.customer.uuid})`);
            }

            return data;
        });

        const totalPages = Math.ceil(count / limit);

        console.log(`✅ [REQUESTS] Found ${count} incoming requests (Page ${page}/${totalPages})`);

        res.status(200).json({
            success: true,
            message: 'Incoming service requests retrieved successfully',
            data: transformedRequests, // ✅ Return transformed data
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
        console.error('❌ [SERVICE_REQUEST_CONTROLLER] Error in getIncomingRequests:', error);
        console.error('❌ [SERVICE_REQUEST_CONTROLLER] Stack trace:', error.stack);

        res.status(500).json({
            success: false,
            message: 'Unable to retrieve incoming requests. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET REQUEST BY ID (Full details)
// GET /api/services/requests/:id
// ═══════════════════════════════════════════════════════════════════════

exports.getRequestById = async (req, res) => {
    try {
        const { id } = req.params;
        const user_id = req.user.uuid;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid request ID. Please provide a valid numeric ID.',
            });
        }

        const request = await ServiceRequest.findOne({
            where: {
                id,
                [Op.or]: [
                    { customer_id: user_id },
                    { provider_id: user_id }
                ]
            },
            include: [
                {
                    model: ServiceListing,
                    as: 'listing',
                    attributes: ['id', 'listing_id', 'title', 'description', 'photos', 'pricing_type', 'hourly_rate', 'minimum_charge', 'fixed_price'],
                    include: [
                        {
                            model: ServiceCategory,
                            as: 'category',
                            attributes: ['id', 'name_en', 'description_en'],
                        }
                    ]
                },
                {
                    model: Account,
                    as: 'provider',
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'],
                },
                {
                    model: Account,
                    as: 'customer',
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'],
                },
            ],
        });

        if (!request) {
            return res.status(404).json({
                success: false,
                message: 'Request not found or you do not have permission to view it.',
            });
        }

        res.status(200).json({
            success: true,
            message: 'Request details retrieved successfully',
            data: request,
        });

    } catch (error) {
        console.error('❌ [SERVICE_REQUEST_CONTROLLER] Error in getRequestById:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve request details. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET ACTIVE SERVICE (Customer's current active service)
// GET /api/services/requests/active
// ═══════════════════════════════════════════════════════════════════════

exports.getActiveService = async (req, res) => {
    try {
        const customer_id = req.user.uuid;

        const request = await ServiceRequest.findOne({
            where: {
                customer_id,
                status: ['accepted', 'in_progress', 'payment_pending', 'payment_confirmation_pending'],
            },
            include: [
                {
                    model: ServiceListing,
                    as: 'listing',
                    attributes: ['id', 'listing_id', 'title'],
                },
                {
                    model: Account,
                    as: 'provider',
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'],
                },
            ],
            order: [['updated_at', 'DESC']],
        });

        if (!request) {
            return res.status(404).json({
                success: false,
                message: 'No active service found.',
            });
        }

        res.status(200).json({
            success: true,
            message: 'Active service retrieved successfully',
            data: request,
        });

    } catch (error) {
        console.error('❌ [SERVICE_REQUEST_CONTROLLER] Error in getActiveService:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve active service. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET PROVIDER'S ACTIVE SERVICES (Provider's current active services)
// GET /api/services/requests/provider-active
// ═══════════════════════════════════════════════════════════════════════

exports.getProviderActiveServices = async (req, res) => {
    try {
        const provider_id = req.user.uuid;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const offset = (page - 1) * limit;

        const { count, rows: requests } = await ServiceRequest.findAndCountAll({
            where: {
                provider_id,
                status: ['accepted', 'in_progress', 'payment_pending', 'payment_confirmation_pending'],
            },
            include: [
                {
                    model: ServiceListing,
                    as: 'listing',
                    attributes: ['id', 'listing_id', 'title'],
                },
                {
                    model: Account,
                    as: 'customer',
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'],
                },
            ],
            limit,
            offset,
            order: [['updated_at', 'DESC']],
        });

        const totalPages = Math.ceil(count / limit);

        res.status(200).json({
            success: true,
            message: 'Active services retrieved successfully',
            data: requests,
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
        console.error('❌ [SERVICE_REQUEST_CONTROLLER] Error in getProviderActiveServices:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve active services. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET REQUEST STATISTICS (For dashboard)
// GET /api/services/requests/stats
// ═══════════════════════════════════════════════════════════════════════

exports.getRequestStats = async (req, res) => {
    try {
        const user_id = req.user.uuid;
        const user_type = req.query.user_type || 'customer'; // customer or provider

        let stats = {};

        if (user_type === 'customer') {
            // Customer stats
            stats.total_requests = await ServiceRequest.count({ where: { customer_id: user_id } });
            stats.pending = await ServiceRequest.count({ where: { customer_id: user_id, status: 'pending' } });
            stats.accepted = await ServiceRequest.count({ where: { customer_id: user_id, status: 'accepted' } });
            stats.in_progress = await ServiceRequest.count({ where: { customer_id: user_id, status: 'in_progress' } });
            stats.completed = await ServiceRequest.count({ where: { customer_id: user_id, status: 'completed' } });
            stats.cancelled = await ServiceRequest.count({ where: { customer_id: user_id, status: 'cancelled' } });

            // Total spent
            const totalSpent = await ServiceRequest.sum('final_amount', {
                where: {
                    customer_id: user_id,
                    status: ['completed', 'payment_confirmed']
                }
            });
            stats.total_spent = totalSpent || 0;

        } else {
            // Provider stats
            stats.total_requests = await ServiceRequest.count({ where: { provider_id: user_id } });
            stats.pending = await ServiceRequest.count({ where: { provider_id: user_id, status: 'pending' } });
            stats.accepted = await ServiceRequest.count({ where: { provider_id: user_id, status: 'accepted' } });
            stats.in_progress = await ServiceRequest.count({ where: { provider_id: user_id, status: 'in_progress' } });
            stats.completed = await ServiceRequest.count({ where: { provider_id: user_id, status: 'completed' } });

            // Total earnings (net amount)
            const totalEarnings = await ServiceRequest.sum('provider_net_amount', {
                where: {
                    provider_id: user_id,
                    status: ['completed', 'payment_confirmed']
                }
            });
            stats.total_earnings = totalEarnings || 0;

            // Commission paid
            const totalCommission = await ServiceRequest.sum('commission_amount', {
                where: {
                    provider_id: user_id,
                    status: ['completed', 'payment_confirmed']
                }
            });
            stats.total_commission = totalCommission || 0;
        }

        res.status(200).json({
            success: true,
            message: 'Request statistics retrieved successfully',
            data: stats,
        });

    } catch (error) {
        console.error('❌ [SERVICE_REQUEST_CONTROLLER] Error in getRequestStats:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve statistics. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

module.exports = exports;