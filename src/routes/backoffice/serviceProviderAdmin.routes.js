// backend/src/routes/backoffice/serviceProviderAdmin.routes.js
// Routes for Service Provider Admin (Provider Management)

const express = require('express');
const router = express.Router();

const {
    getAllProviders,
    getProviderStats,
    getProviderById,
    suspendProvider,
    activateProvider,
} = require('../../controllers/backoffice/serviceProviderAdmin.controller');

const { authenticateEmployee, requireEmployeeRole } = require('../../middleware/employeeAuth.middleware');

// ═══════════════════════════════════════════════════════════════════════
// ALL ROUTES REQUIRE EMPLOYEE AUTHENTICATION
// ═══════════════════════════════════════════════════════════════════════
router.use(authenticateEmployee);

// ═══════════════════════════════════════════════════════════════════════
// PROVIDERS LIST + STATS
// ═══════════════════════════════════════════════════════════════════════

// GET /api/services/admin/providers
router.get(
    '/',
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    getAllProviders
);

// GET /api/services/admin/providers/stats
router.get(
    '/stats',
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    getProviderStats
);

// ═══════════════════════════════════════════════════════════════════════
// PROVIDER DETAILS
// ═══════════════════════════════════════════════════════════════════════

// GET /api/services/admin/providers/:id
router.get(
    '/:id',
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    getProviderById
);

// POST /api/services/admin/providers/:id/suspend
router.post(
    '/:id/suspend',
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    suspendProvider
);

// POST /api/services/admin/providers/:id/activate
router.post(
    '/:id/activate',
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    activateProvider
);

module.exports = router;
