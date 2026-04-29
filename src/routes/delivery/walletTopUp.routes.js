

'use strict';

const express = require('express');
const multer  = require('multer');

const { authenticate }                          = require('../../middleware/auth.middleware');
const { authenticateEmployee, requireEmployeeRole } = require('../../middleware/employeeAuth.middleware');

const driverCtrl = require('../../controllers/delivery/walletTopUp.controller');
const adminCtrl  = require('../../controllers/delivery/walletTopUpAdmin.controller');

// ─── Multer — proof screenshot upload ────────────────────────────────────────
// Memory storage: file goes straight to R2 without touching disk.
// 5 MB cap — screenshots are never larger.
// Images only — PDF proofs are not accepted (easy to fake, hard to verify).

const proofUpload = multer({
    storage: multer.memoryStorage(),
    limits:  { fileSize: 5 * 1024 * 1024 },
    fileFilter(_req, file, cb) {
        const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only JPEG, PNG, or WEBP images are accepted as payment proof.'), false);
        }
    },
});

// ═══════════════════════════════════════════════════════════════════════════════
// DRIVER ROUTER
// Mounted at: /api/deliveries/driver/wallet
// ═══════════════════════════════════════════════════════════════════════════════

const driverRouter = express.Router();

// All driver top-up routes require a valid passenger/driver JWT
driverRouter.use(authenticate);

/**
 * GET /api/deliveries/driver/wallet
 * Returns the driver's wallet balances.
 * Called on app load and after every status change.
 */
driverRouter.get('/', driverCtrl.getWallet);

/**
 * GET /api/deliveries/driver/wallet/topup
 * Driver's own top-up history.
 * Query: page, limit, status
 */
driverRouter.get('/topup', driverCtrl.getMyTopUps);

/**
 * GET /api/deliveries/driver/wallet/topup/:id
 * Single top-up request detail.
 * Scoped to the calling driver — cannot view other drivers' requests.
 */
driverRouter.get('/topup/:id', driverCtrl.getTopUpDetail);

/**
 * POST /api/deliveries/driver/wallet/topup
 * Submit a new wallet reload request.
 *
 * Body (multipart/form-data):
 *   amount            {number}  required
 *   payment_channel   {string}  required  — cash | mtn_mobile_money | orange_money
 *   proof             {file}    optional  — required for MTN/Orange
 *   payment_reference {string}  optional
 *   sender_phone      {string}  optional
 *   driver_note       {string}  optional
 *
 * The 'proof' field name must match what the Flutter app sends.
 */
driverRouter.post(
    '/topup',
    proofUpload.single('proof'),
    driverCtrl.submitTopUp,
);

// ═══════════════════════════════════════════════════════════════════════════════
// BACKOFFICE ROUTER
// Mounted at: /api/backoffice/delivery/topups
// ═══════════════════════════════════════════════════════════════════════════════

const adminRouter = express.Router();

// All backoffice top-up routes require employee authentication
adminRouter.use(authenticateEmployee);

/**
 * GET /api/backoffice/delivery/topups
 * Paginated queue of top-up requests.
 * Query: status (default: pending,under_review), channel, page, limit
 * All employees can view the queue.
 */
adminRouter.get('/', adminCtrl.getQueue);

/**
 * GET /api/backoffice/delivery/topups/:id
 * Full detail for a single top-up request, including driver account info.
 * All employees can view.
 */
adminRouter.get('/:id', adminCtrl.getTopUpDetail);

/**
 * PATCH /api/backoffice/delivery/topups/:id/review
 * Claim a pending request for review (pending → under_review).
 * Support staff and above.
 */
adminRouter.patch(
    '/:id/review',
    requireEmployeeRole('super_admin', 'admin', 'manager', 'support'),
    adminCtrl.markUnderReview,
);

/**
 * PATCH /api/backoffice/delivery/topups/:id/confirm
 * Mark payment as verified (under_review → confirmed).
 * Does NOT yet credit wallet. Separate credit step follows.
 * Support staff and above.
 */
adminRouter.patch(
    '/:id/confirm',
    requireEmployeeRole('super_admin', 'admin', 'manager', 'support'),
    adminCtrl.confirmTopUp,
);

/**
 * POST /api/backoffice/delivery/topups/:id/credit
 * Credit the driver's wallet (confirmed → credited).
 * Restricted to managers and above — enforces two-step approval.
 */
adminRouter.post(
    '/:id/credit',
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    adminCtrl.creditWallet,
);

/**
 * POST /api/backoffice/delivery/topups/:id/approve
 * Confirm + credit in one call (pending/under_review → credited).
 * Use when a single employee has full approval rights.
 * Restricted to managers and above.
 */
adminRouter.post(
    '/:id/approve',
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    adminCtrl.confirmAndCredit,
);

/**
 * PATCH /api/backoffice/delivery/topups/:id/reject
 * Reject the request — driver's wallet is not touched.
 * Body: { reason: string }  — required, shown to driver in the app.
 * Support staff and above.
 */
adminRouter.patch(
    '/:id/reject',
    requireEmployeeRole('super_admin', 'admin', 'manager', 'support'),
    adminCtrl.rejectTopUp,
);

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
    driverRouter,
    adminRouter,
};
