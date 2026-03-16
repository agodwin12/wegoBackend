// backend/src/sockets/serviceSocket.js
// Socket.IO Event Emitters for Services Marketplace
// All real-time events for service requests flow through here

// ═══════════════════════════════════════════════════════════════════════
// GET IO INSTANCE
// ═══════════════════════════════════════════════════════════════════════

const getIO = () => {
    const io = require('../server').io;
    if (!io) {
        console.warn('⚠️ [SERVICE_SOCKET] Socket.IO instance not available');
        return null;
    }
    return io;
};

// ═══════════════════════════════════════════════════════════════════════
// HELPER: EMIT TO USER SAFELY
// ═══════════════════════════════════════════════════════════════════════

const emitToUser = (userUUID, event, data) => {
    try {
        const io = getIO();
        if (!io) return;

        io.to(userUUID).emit(event, data);
        console.log(`📡 [SERVICE_SOCKET] Emitted "${event}" to user: ${userUUID}`);
    } catch (error) {
        console.error(`❌ [SERVICE_SOCKET] Failed to emit "${event}" to user ${userUUID}:`, error.message);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// 1. REQUEST ACCEPTED
// Provider accepts → Customer notified
// ═══════════════════════════════════════════════════════════════════════

const emitRequestAccepted = (request, providerData) => {
    emitToUser(request.customer_id, 'service:request_accepted', {
        request_id: request.request_id,
        id: request.id,
        status: 'accepted',
        accepted_at: request.accepted_at,
        provider_response: request.provider_response,
        provider: {
            uuid: providerData.uuid,
            first_name: providerData.first_name,
            last_name: providerData.last_name,
            phone_e164: providerData.phone_e164,
            avatar_url: providerData.avatar_url,
        },
        message: `${providerData.first_name} accepted your service request!`,
    });
};

// ═══════════════════════════════════════════════════════════════════════
// 2. REQUEST REJECTED
// Provider rejects → Customer notified
// ═══════════════════════════════════════════════════════════════════════

const emitRequestRejected = (request, providerData) => {
    emitToUser(request.customer_id, 'service:request_rejected', {
        request_id: request.request_id,
        id: request.id,
        status: 'rejected',
        rejected_at: request.rejected_at,
        rejection_reason: request.rejection_reason,
        provider: {
            uuid: providerData.uuid,
            first_name: providerData.first_name,
            last_name: providerData.last_name,
            avatar_url: providerData.avatar_url,
        },
        message: `${providerData.first_name} declined your service request.`,
    });
};

// ═══════════════════════════════════════════════════════════════════════
// 3. SERVICE STARTED
// Provider marks started → Customer notified
// ═══════════════════════════════════════════════════════════════════════

const emitServiceStarted = (request, providerData) => {
    emitToUser(request.customer_id, 'service:started', {
        request_id: request.request_id,
        id: request.id,
        status: 'in_progress',
        started_at: request.started_at,
        provider: {
            uuid: providerData.uuid,
            first_name: providerData.first_name,
            last_name: providerData.last_name,
            phone_e164: providerData.phone_e164,
            avatar_url: providerData.avatar_url,
        },
        message: `${providerData.first_name} is on the way!`,
    });
};

// ═══════════════════════════════════════════════════════════════════════
// 4. SERVICE COMPLETED - PAYMENT REQUESTED
// Provider marks complete → Customer notified with amount
// ═══════════════════════════════════════════════════════════════════════

const emitPaymentRequested = (request, providerData) => {
    emitToUser(request.customer_id, 'service:payment_requested', {
        request_id: request.request_id,
        id: request.id,
        status: 'payment_pending',
        completed_at: request.completed_at,
        final_amount: request.final_amount,
        work_summary: request.work_summary,
        hours_worked: request.hours_worked,
        materials_cost: request.materials_cost,
        after_photos: request.after_photos,
        provider: {
            uuid: providerData.uuid,
            first_name: providerData.first_name,
            last_name: providerData.last_name,
            avatar_url: providerData.avatar_url,
        },
        message: `${providerData.first_name} completed the service. Payment of ${request.final_amount} FCFA requested.`,
    });
};

// ═══════════════════════════════════════════════════════════════════════
// 5. PAYMENT PROOF UPLOADED
// Customer uploads proof → Provider notified
// ═══════════════════════════════════════════════════════════════════════

const emitPaymentProofUploaded = (request, customerData) => {
    emitToUser(request.provider_id, 'service:payment_proof_uploaded', {
        request_id: request.request_id,
        id: request.id,
        status: 'payment_confirmation_pending',
        payment_method: request.payment_method,
        payment_proof_url: request.payment_proof_url,
        payment_reference: request.payment_reference,
        payment_marked_at: request.payment_marked_at,
        final_amount: request.final_amount,
        customer: {
            uuid: customerData.uuid,
            first_name: customerData.first_name,
            last_name: customerData.last_name,
            avatar_url: customerData.avatar_url,
        },
        message: `${customerData.first_name} has uploaded payment proof. Please confirm receipt.`,
    });
};

// ═══════════════════════════════════════════════════════════════════════
// 6. PAYMENT CONFIRMED
// Provider confirms payment → Customer notified
// ═══════════════════════════════════════════════════════════════════════

const emitPaymentConfirmed = (request, providerData) => {
    emitToUser(request.customer_id, 'service:payment_confirmed', {
        request_id: request.request_id,
        id: request.id,
        status: 'payment_confirmed',
        payment_confirmed_at: request.payment_confirmed_at,
        final_amount: request.final_amount,
        commission_amount: request.commission_amount,
        provider_net_amount: request.provider_net_amount,
        provider: {
            uuid: providerData.uuid,
            first_name: providerData.first_name,
            last_name: providerData.last_name,
            avatar_url: providerData.avatar_url,
        },
        message: `Payment of ${request.final_amount} FCFA confirmed! Please rate your experience.`,
    });
};

// ═══════════════════════════════════════════════════════════════════════
// 7. REQUEST CANCELLED
// Either party cancels → Other party notified
// ═══════════════════════════════════════════════════════════════════════

const emitRequestCancelled = (request, cancellerData, cancellerType) => {
    // Notify the other party
    const targetUserId = cancellerType === 'customer'
        ? request.provider_id
        : request.customer_id;

    emitToUser(targetUserId, 'service:cancelled', {
        request_id: request.request_id,
        id: request.id,
        status: 'cancelled',
        cancelled_at: request.cancelled_at,
        cancellation_reason: request.cancellation_reason,
        cancelled_by_type: cancellerType,
        cancelled_by: {
            uuid: cancellerData.uuid,
            first_name: cancellerData.first_name,
            last_name: cancellerData.last_name,
            avatar_url: cancellerData.avatar_url,
        },
        message: `${cancellerData.first_name} cancelled the service request.`,
    });
};

// ═══════════════════════════════════════════════════════════════════════
// 8. NEW SERVICE REQUEST (Provider gets notified of new request)
// Customer creates request → Provider notified
// ═══════════════════════════════════════════════════════════════════════

const emitNewServiceRequest = (request, customerData, listingTitle) => {
    emitToUser(request.provider_id, 'service:new_request', {
        request_id: request.request_id,
        id: request.id,
        status: 'pending',
        listing_title: listingTitle,
        description: request.description,
        service_location: request.service_location,
        needed_when: request.needed_when,
        scheduled_date: request.scheduled_date,
        scheduled_time: request.scheduled_time,
        customer_budget: request.customer_budget,
        expires_at: request.expires_at,
        customer: {
            uuid: customerData.uuid,
            first_name: customerData.first_name,
            last_name: customerData.last_name,
            phone_e164: customerData.phone_e164,
            avatar_url: customerData.avatar_url,
        },
        message: `New service request from ${customerData.first_name}!`,
    });
};

// ═══════════════════════════════════════════════════════════════════════
// 9. DISPUTE FILED
// Either party files dispute → Other party notified
// ═══════════════════════════════════════════════════════════════════════

const emitDisputeFiled = (dispute, filedByData, targetUserId) => {
    emitToUser(targetUserId, 'service:dispute_filed', {
        dispute_id: dispute.dispute_id,
        id: dispute.id,
        status: dispute.status,
        dispute_type: dispute.dispute_type,
        resolution_requested: dispute.resolution_requested,
        filed_by: {
            uuid: filedByData.uuid,
            first_name: filedByData.first_name,
            last_name: filedByData.last_name,
            avatar_url: filedByData.avatar_url,
        },
        message: `${filedByData.first_name} has filed a dispute. Please respond within 48 hours.`,
    });
};

// ═══════════════════════════════════════════════════════════════════════
// 10. DISPUTE RESOLVED
// Admin resolves → Both parties notified
// ═══════════════════════════════════════════════════════════════════════

const emitDisputeResolved = (dispute, customerUUID, providerUUID) => {
    const payload = {
        dispute_id: dispute.dispute_id,
        id: dispute.id,
        status: 'resolved',
        resolution_type: dispute.resolution_type,
        resolution_details: dispute.resolution_details,
        refund_granted: dispute.refund_granted,
        resolved_at: dispute.resolved_at,
        message: 'Your dispute has been resolved by our team.',
    };

    emitToUser(customerUUID, 'service:dispute_resolved', payload);
    emitToUser(providerUUID, 'service:dispute_resolved', payload);
};

// ═══════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════

module.exports = {
    emitNewServiceRequest,
    emitRequestAccepted,
    emitRequestRejected,
    emitServiceStarted,
    emitPaymentRequested,
    emitPaymentProofUploaded,
    emitPaymentConfirmed,
    emitRequestCancelled,
    emitDisputeFiled,
    emitDisputeResolved,
};