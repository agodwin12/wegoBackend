const express = require('express');
const router = express.Router();
const serviceRequestController = require('../controllers/serviceRequest.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const { upload } = require('../middleware/upload');
const validate = require('../middleware/validate');
const schemas = require('../validators/servicesMarketplace.validator');

// Create service request (Customer contacts provider)
router.post(
    '/',
    authenticateToken,
    upload.array('photos', 3),
    validate(schemas.createRequest),
    serviceRequestController.createRequest
);

// Get customer's service requests
router.get(
    '/my-requests',
    authenticateToken,
    validate(schemas.getRequests),
    serviceRequestController.getMyRequests
);

// Get provider's incoming service requests
router.get(
    '/incoming',
    authenticateToken,
    validate(schemas.getRequests),
    serviceRequestController.getIncomingRequests
);

// Get customer's current active service
router.get(
    '/active',
    authenticateToken,
    serviceRequestController.getActiveService
);

// Get provider's current active services
router.get(
    '/provider-active',
    authenticateToken,
    validate(schemas.getRequests),
    serviceRequestController.getProviderActiveServices
);

// Get request statistics for dashboard
router.get(
    '/stats',
    authenticateToken,
    serviceRequestController.getRequestStats
);

// Get service request by ID
router.get(
    '/:id',
    authenticateToken,
    serviceRequestController.getRequestById
);

// Accept service request (Provider)
router.post(
    '/:id/accept',
    authenticateToken,
    validate(schemas.acceptRequest),
    serviceRequestController.acceptRequest
);

// Reject service request (Provider)
router.post(
    '/:id/reject',
    authenticateToken,
    validate(schemas.rejectRequest),
    serviceRequestController.rejectRequest
);

// Start service / Mark as "on the way" (Provider)
router.post(
    '/:id/start',
    authenticateToken,
    serviceRequestController.startService
);

// Mark service as complete & request payment (Provider)
router.post(
    '/:id/complete',
    authenticateToken,
    upload.array('after_photos', 5),
    validate(schemas.completeService),
    serviceRequestController.completeService
);

// Upload payment proof screenshot (Customer)
router.post(
    '/:id/payment-proof',
    authenticateToken,
    upload.single('payment_proof'),
    validate(schemas.uploadPaymentProof),
    serviceRequestController.uploadPaymentProof
);

// Confirm payment (Provider)
router.post(
    '/:id/confirm-payment',
    authenticateToken,
    serviceRequestController.confirmPayment
);

// Mark as completed (Provider)
router.post(
    '/:id/mark-completed',
    authenticateToken,
    serviceRequestController.markAsCompleted
);

// Cancel request
router.post(
    '/:id/cancel',
    authenticateToken,
    validate(schemas.cancelRequest),
    serviceRequestController.cancelRequest
);

module.exports = router;