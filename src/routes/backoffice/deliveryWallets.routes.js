// src/routes/backoffice/deliveryWallets.routes.js

const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/backoffice/deliveryWallets.controller');
const { authenticateEmployee } = require('../../middleware/employeeAuth.middleware');
const { requireEmployeeRole }  = require('../../middleware/employeeAuth.middleware');

router.use(authenticateEmployee);

// ─── WALLETS ──────────────────────────────────────────────────────────────────
// GET  /api/backoffice/delivery/wallets                     — list all wallets
router.get('/wallets',                       ctrl.getWallets);

// GET  /api/backoffice/delivery/wallets/export              — Excel export
router.get('/wallets/export',                ctrl.exportWallets);

// GET  /api/backoffice/delivery/wallets/:walletId           — single wallet + transactions
router.get('/wallets/:walletId',             ctrl.getWallet);

// POST /api/backoffice/delivery/wallets/:walletId/adjust    — manual credit/debit
router.post('/wallets/:walletId/adjust',
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    ctrl.adjustWallet
);

// POST /api/backoffice/delivery/wallets/:walletId/settle-commission
router.post('/wallets/:walletId/settle-commission',
    requireEmployeeRole('super_admin', 'admin', 'manager', 'accountant'),
    ctrl.settleCommission
);

// PATCH /api/backoffice/delivery/wallets/:walletId/status   — freeze/unfreeze
router.patch('/wallets/:walletId/status',
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    ctrl.updateWalletStatus
);

// ─── PAYOUTS ──────────────────────────────────────────────────────────────────
// GET  /api/backoffice/delivery/payouts                     — list all payout requests
router.get('/payouts',                       ctrl.getPayouts);

// GET  /api/backoffice/delivery/payouts/export              — Excel export
router.get('/payouts/export',                ctrl.exportPayouts);

// POST /api/backoffice/delivery/payouts/:id/approve         — approve payout
router.post('/payouts/:id/approve',
    requireEmployeeRole('super_admin', 'admin', 'accountant'),
    ctrl.approvePayout
);

// POST /api/backoffice/delivery/payouts/:id/reject          — reject payout
router.post('/payouts/:id/reject',
    requireEmployeeRole('super_admin', 'admin', 'accountant'),
    ctrl.rejectPayout
);

module.exports = router;