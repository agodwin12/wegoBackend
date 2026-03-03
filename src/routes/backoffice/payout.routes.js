// src/routes/backoffice/payout.routes.js
//
// ═══════════════════════════════════════════════════════════════════════
// PAYOUT ROUTES (Backoffice)
// ═══════════════════════════════════════════════════════════════════════
//
// All routes require authenticateEmployee (logged-in backoffice employee).
//
// Role access matrix:
//
//   READ (list/get):
//     super_admin, admin, manager, accountant, support
//     → Everyone can view — support needs visibility for driver complaints
//
//   CREATE / PROCESS / CONFIRM / REJECT (financial actions):
//     super_admin, admin, manager, accountant
//     → Support staff CANNOT approve or reject financial transactions
//
//   CANCEL:
//     super_admin, admin, manager, accountant
//
//   CLOSE BALANCE SHEET:
//     super_admin, admin, accountant
//     → Manager cannot close sheets (financial close is accountant territory)
//
//   MANUAL BALANCE SHEET RUN:
//     super_admin only
//     → Too dangerous for anyone else — could create duplicate records
//
// ═══════════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');
const router  = express.Router();

const {
    authenticateEmployee,
    requireEmployeeRole,
} = require('../../middleware/employeeAuth.middleware');

const payoutController = require('../../controllers/backoffice/payout.controller');

// ── Financial action roles — used repeatedly below ─────────────────────
const FINANCE_ROLES = ['super_admin', 'admin', 'manager', 'accountant'];
const READ_ROLES    = ['super_admin', 'admin', 'manager', 'accountant', 'support'];
const CLOSE_ROLES   = ['super_admin', 'admin', 'accountant'];

// All routes require a valid employee session
router.use(authenticateEmployee);

// ═══════════════════════════════════════════════════════════════════════
// ── OVERVIEW ───────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/payouts/overview
 * Dashboard summary — pending counts, totals, blocked drivers
 * Access: all authenticated employees
 */
router.get(
    '/overview',
    requireEmployeeRole(...READ_ROLES),
    payoutController.getOverview
);

// ═══════════════════════════════════════════════════════════════════════
// ── PAYOUT REQUESTS (WEGO → Driver) ────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/payouts/requests
 * List payout requests — filterable by status, driverId, date range, overdue
 * Access: all roles
 */
router.get(
    '/requests',
    requireEmployeeRole(...READ_ROLES),
    payoutController.listPayoutRequests
);

/**
 * GET /api/admin/payouts/requests/:id
 * Single payout request detail with full audit trail
 * Access: all roles
 */
router.get(
    '/requests/:id',
    requireEmployeeRole(...READ_ROLES),
    payoutController.getPayoutRequest
);

/**
 * POST /api/admin/payouts/requests
 * Backoffice creates a payout for a driver
 * Body: driverId, amount, paymentMethod, paymentPhone?, balanceSheetId?, accountantNotes?
 * Access: super_admin, admin, manager, accountant
 */
router.post(
    '/requests',
    requireEmployeeRole(...FINANCE_ROLES),
    payoutController.createPayoutRequest
);

/**
 * PUT /api/admin/payouts/requests/:id/process
 * Mark payout as PROCESSING — accountant has started the transfer
 * Body: accountantNotes? (optional)
 * Access: super_admin, admin, manager, accountant
 */
router.put(
    '/requests/:id/process',
    requireEmployeeRole(...FINANCE_ROLES),
    payoutController.processPayoutRequest
);

/**
 * PUT /api/admin/payouts/requests/:id/confirm
 * Mark payout as PAID — transfer confirmed
 * Body: transactionRef (required for MOMO/OM), proofUrl?, accountantNotes?
 * Access: super_admin, admin, manager, accountant
 */
router.put(
    '/requests/:id/confirm',
    requireEmployeeRole(...FINANCE_ROLES),
    payoutController.confirmPayoutRequest
);

/**
 * PUT /api/admin/payouts/requests/:id/reject
 * Reject a payout request
 * Body: rejectionReason (required), accountantNotes?
 * Access: super_admin, admin, manager, accountant
 */
router.put(
    '/requests/:id/reject',
    requireEmployeeRole(...FINANCE_ROLES),
    payoutController.rejectPayoutRequest
);

/**
 * PUT /api/admin/payouts/requests/:id/cancel
 * Cancel a payout request
 * Body: accountantNotes? (optional)
 * Access: super_admin, admin, manager, accountant
 */
router.put(
    '/requests/:id/cancel',
    requireEmployeeRole(...FINANCE_ROLES),
    payoutController.cancelPayoutRequest
);

// ═══════════════════════════════════════════════════════════════════════
// ── DEBT COLLECTION (Driver → WEGO) ────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/payouts/debts
 * List debt payment submissions — filterable by status, driverId, date range
 * Access: all roles
 */
router.get(
    '/debts',
    requireEmployeeRole(...READ_ROLES),
    payoutController.listDebtPayments
);

/**
 * GET /api/admin/payouts/debts/:id
 * Single debt payment detail with full audit trail
 * Access: all roles
 */
router.get(
    '/debts/:id',
    requireEmployeeRole(...READ_ROLES),
    payoutController.getDebtPayment
);

/**
 * POST /api/admin/payouts/debts
 * Agent or accountant creates a debt payment record on behalf of driver
 * Body: driverId, amount, paymentMethod, driverTransactionRef?, balanceSheetId?,
 *       driverNote?, accountantNotes?, proofUrl?, submittedVia?
 * Access: super_admin, admin, manager, accountant
 */
router.post(
    '/debts',
    requireEmployeeRole(...FINANCE_ROLES),
    payoutController.createDebtPayment
);

/**
 * PUT /api/admin/payouts/debts/:id/confirm
 * Verify proof and confirm driver paid their debt
 * Body: wegoTransactionRef?, accountantNotes?
 * Access: super_admin, admin, manager, accountant
 */
router.put(
    '/debts/:id/confirm',
    requireEmployeeRole(...FINANCE_ROLES),
    payoutController.confirmDebtPayment
);

/**
 * PUT /api/admin/payouts/debts/:id/reject
 * Reject a debt payment (wrong amount, fake proof, etc.)
 * Body: rejectionReason (required), accountantNotes?
 * Access: super_admin, admin, manager, accountant
 */
router.put(
    '/debts/:id/reject',
    requireEmployeeRole(...FINANCE_ROLES),
    payoutController.rejectDebtPayment
);

// ═══════════════════════════════════════════════════════════════════════
// ── BALANCE SHEETS ─────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/payouts/balance-sheets
 * List balance sheets — filterable by driverId, date, from/to, status
 * Access: all roles
 */
router.get(
    '/balance-sheets',
    requireEmployeeRole(...READ_ROLES),
    payoutController.listBalanceSheets
);

/**
 * GET /api/admin/payouts/balance-sheets/:id
 * Single balance sheet detail including linked payout requests and debt payments
 * Access: all roles
 */
router.get(
    '/balance-sheets/:id',
    requireEmployeeRole(...READ_ROLES),
    payoutController.getBalanceSheet
);

/**
 * PUT /api/admin/payouts/balance-sheets/:id/close
 * Manually close a balance sheet
 * Body: notes? (optional)
 * Access: super_admin, admin, accountant only
 * (Manager cannot close — closing is a financial-sign-off action)
 */
router.put(
    '/balance-sheets/:id/close',
    requireEmployeeRole(...CLOSE_ROLES),
    payoutController.closeBalanceSheet
);

/**
 * POST /api/admin/payouts/balance-sheets/run
 * Manually trigger balance sheet generation for a specific date
 * Body: date (YYYY-MM-DD)
 * Access: super_admin ONLY — too risky for anyone else
 */
router.post(
    '/balance-sheets/run',
    requireEmployeeRole('super_admin'),
    payoutController.runBalanceSheet
);

router.post(
    '/settle',
    requireEmployeeRole(...FINANCE_ROLES),
    payoutController.settleAtOffice
);
module.exports = router;