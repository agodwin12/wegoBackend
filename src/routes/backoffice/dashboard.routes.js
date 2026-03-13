// ═══════════════════════════════════════════════════════════════════════════════
// backend/src/routes/backoffice/dashboard.routes.js
// WEGO Backoffice — Dashboard Routes
// ═══════════════════════════════════════════════════════════════════════════════

const express    = require('express');
const router     = express.Router();

const {
    getDashboardStats,
    getActivityFeed,
} = require('../../controllers/backoffice/dashboard.controller');

const {
    authenticateEmployee,
    requireEmployeeRole,
} = require('../../middleware/employeeAuth.middleware');

// All dashboard routes require a valid employee token
// Any role can view the dashboard (super_admin, admin, manager, accountant, support)
router.use(authenticateEmployee);

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * GET /api/backoffice/dashboard/stats
 * Query params:
 *   range  — today | week | month | custom  (default: today)
 *   from   — ISO date string (only for custom range)
 *   to     — ISO date string (only for custom range)
 *
 * Returns: KPIs, revenue chart, trips chart, payment breakdown, top drivers
 * Cached in Redis for 2 minutes per range key
 */
router.get(
    '/stats',
    requireEmployeeRole('super_admin', 'admin', 'manager', 'accountant'),
    getDashboardStats
);

/**
 * GET /api/backoffice/dashboard/activity-feed
 * Returns: last 15 events (trips, signups, disputes, service requests)
 * NOT cached — always live
 */
router.get(
    '/activity-feed',
    getActivityFeed
);

module.exports = router;