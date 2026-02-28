// src/routes/backoffice/adminEarnings.routes.js
//
// ═══════════════════════════════════════════════════════════════════════
// ADMIN EARNINGS ROUTES (Backoffice)
// ═══════════════════════════════════════════════════════════════════════
//
// Mount in app.js:
//   const adminEarningsRoutes = require('./routes/backoffice/adminEarnings.routes');
//   app.use('/api/admin/earnings', adminEarningsRoutes);
//
// Role matrix:
//   READ  (GET)          → super_admin, admin, manager, accountant
//   WRITE (POST/PUT/DEL) → super_admin, admin, manager only
//
// All routes require authenticateEmployee first.
//
// ═══════════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');
const router  = express.Router();

const {
    authenticateEmployee,
    requireEmployeeRole,
} = require('../../middleware/employeeAuth.middleware');

const ctrl = require('../../controllers/backoffice/adminEarnings.controller');

// All earnings admin routes require a valid employee JWT
router.use(authenticateEmployee);

// ── READ-ONLY roles (GET) ─────────────────────────────────────────────
const canRead  = requireEmployeeRole('super_admin', 'admin', 'manager', 'accountant');

// ── WRITE roles (POST / PUT / DELETE) ────────────────────────────────
const canWrite = requireEmployeeRole('super_admin', 'admin', 'manager');

// ═══════════════════════════════════════════════════════════════════════
// EARNING RULES
// ═══════════════════════════════════════════════════════════════════════

// GET  /api/admin/earnings/rules       → list all rules
router.get('/rules', canRead, ctrl.listRules);

// POST /api/admin/earnings/rules       → create a rule
router.post('/rules', canWrite, ctrl.createRule);

// PUT  /api/admin/earnings/rules/:id   → update a rule
router.put('/rules/:id', canWrite, ctrl.updateRule);

// DELETE /api/admin/earnings/rules/:id → deactivate a rule
router.delete('/rules/:id', canWrite, ctrl.deleteRule);

// ═══════════════════════════════════════════════════════════════════════
// BONUS PROGRAMS
// ═══════════════════════════════════════════════════════════════════════

// GET  /api/admin/earnings/programs       → list all programs
router.get('/programs', canRead, ctrl.listPrograms);

// POST /api/admin/earnings/programs       → create a program
router.post('/programs', canWrite, ctrl.createProgram);

// PUT  /api/admin/earnings/programs/:id   → update a program
router.put('/programs/:id', canWrite, ctrl.updateProgram);

// DELETE /api/admin/earnings/programs/:id → deactivate a program
router.delete('/programs/:id', canWrite, ctrl.deleteProgram);

// ═══════════════════════════════════════════════════════════════════════
// DRIVER EARNINGS (READ-ONLY for admin)
// ═══════════════════════════════════════════════════════════════════════

// GET /api/admin/earnings/overview              → platform revenue stats
// Query: period (today | week | month | all)
router.get('/overview', canRead, ctrl.getOverview);

// GET /api/admin/earnings/drivers               → all driver wallets
// Query: page, limit, search, status
router.get('/drivers', canRead, ctrl.listDriverWallets);

// GET /api/admin/earnings/drivers/:uuid         → one driver full detail
// Query: period (today | week | month | all)
router.get('/drivers/:uuid', canRead, ctrl.getDriverEarningsDetail);

module.exports = router;