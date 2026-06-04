'use strict';

const express = require('express');
const multer  = require('multer');

const { authenticate }                              = require('../../middleware/auth.middleware');
const { authenticateEmployee, requireEmployeeRole } = require('../../middleware/employeeAuth.middleware');

const driverCtrl = require('../../controllers/delivery/walletTopUp.controller');
const adminCtrl  = require('../../controllers/delivery/walletTopUpAdmin.controller');

// ─── Multer — cash proof screenshot (memory → R2) ─────────────────────────────
const proofUpload = multer({
    storage: multer.memoryStorage(),
    limits:  { fileSize: 5 * 1024 * 1024 },
    fileFilter(_req, file, cb) {
        const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
        allowed.includes(file.mimetype)
            ? cb(null, true)
            : cb(new Error('Only JPEG, PNG, or WEBP images are accepted as payment proof.'), false);
    },
});

// ═══════════════════════════════════════════════════════════════════════════════
// DRIVER ROUTER  —  mounted at /api/deliveries/driver/wallet
// ═══════════════════════════════════════════════════════════════════════════════

const driverRouter = express.Router();

driverRouter.use(authenticate);

// Wallet balance
driverRouter.get('/', driverCtrl.getWallet);

// Top-up history + detail
driverRouter.get('/topup',     driverCtrl.getMyTopUps);
driverRouter.get('/topup/:id', driverCtrl.getTopUpDetail);

// CamPay digital top-up (MTN / Orange) — MUST be before /topup POST
// to avoid Express matching /topup/initiate as /topup with id='initiate'
driverRouter.post('/topup/initiate', driverCtrl.initiateDigitalTopUp);

// Cash top-up (manual backoffice review flow)
driverRouter.post('/topup', proofUpload.single('proof'), driverCtrl.submitTopUp);

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTER  —  mounted at /api/backoffice/delivery/topups
// ═══════════════════════════════════════════════════════════════════════════════

const adminRouter = express.Router();

adminRouter.use(authenticateEmployee);

const supportAndAbove  = requireEmployeeRole('super_admin', 'admin', 'manager', 'support');
const managerAndAbove  = requireEmployeeRole('super_admin', 'admin', 'manager');

adminRouter.get('/',    adminCtrl.getQueue);
adminRouter.get('/:id', adminCtrl.getTopUpDetail);

adminRouter.patch('/:id/review',  supportAndAbove, adminCtrl.markUnderReview);
adminRouter.patch('/:id/confirm', supportAndAbove, adminCtrl.confirmTopUp);
adminRouter.post( '/:id/credit',  managerAndAbove, adminCtrl.creditWallet);
adminRouter.post( '/:id/approve', managerAndAbove, adminCtrl.confirmAndCredit);
adminRouter.patch('/:id/reject',  supportAndAbove, adminCtrl.rejectTopUp);

module.exports = { driverRouter, adminRouter };