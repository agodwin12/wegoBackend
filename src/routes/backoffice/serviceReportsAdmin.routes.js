// backend/src/routes/backoffice/serviceReportsAdmin.routes.js

const express = require('express');
const router = express.Router();

// ═══════════════════════════════════════════════════════════════════════
// MIDDLEWARE IMPORTS
// ═══════════════════════════════════════════════════════════════════════

const {
    authenticateEmployee,
    requireEmployeeRole
} = require('../../middleware/employeeAuth.middleware');

// ═══════════════════════════════════════════════════════════════════════
// CONTROLLER IMPORTS
// ═══════════════════════════════════════════════════════════════════════

const {
    getReportsData,
    exportToExcel,
    exportToPDF,
    exportToCSV
} = require('../../controllers/backoffice/serviceReportsAdmin.controller');

// ═══════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   GET /api/services/admin/reports
 * @desc    Get comprehensive reports data with analytics
 * @access  Employee Only (super_admin, admin, manager, accountant, support)
 * @query   date_range (week|month|quarter|year|custom)
 * @query   start_date (ISO format, required if date_range=custom)
 * @query   end_date (ISO format, required if date_range=custom)
 * @query   category_id (optional filter)
 * @query   provider_id (optional filter)
 */
router.get(
    '/',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager', 'accountant', 'support'),
    getReportsData
);

/**
 * @route   GET /api/services/admin/reports/export
 * @desc    Unified export endpoint - routes to appropriate format handler
 * @access  Employee Only (super_admin, admin, manager, accountant)
 * @query   format (pdf|excel|csv) - REQUIRED
 * @query   start_date (ISO format, optional)
 * @query   end_date (ISO format, optional)
 * @query   report_type (transactions|providers|categories|all)
 */
router.get(
    '/export',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager', 'accountant'),
    (req, res, next) => {
        const { format } = req.query;

        console.log('📤 [REPORTS EXPORT] Export request received');
        console.log('   Format:', format);
        console.log('   Employee:', req.user.email);
        console.log('   Employee Role:', req.user.role);

        // Route to appropriate controller based on format
        switch (format) {
            case 'excel':
                console.log('   → Routing to Excel export');
                return exportToExcel(req, res, next);
            case 'pdf':
                console.log('   → Routing to PDF export');
                return exportToPDF(req, res, next);
            case 'csv':
                console.log('   → Routing to CSV export');
                return exportToCSV(req, res, next);
            default:
                console.log('   ❌ Invalid format specified');
                return res.status(400).json({
                    success: false,
                    message: 'Invalid export format. Use: pdf, excel, or csv',
                    validFormats: ['pdf', 'excel', 'csv']
                });
        }
    }
);

/**
 * @route   GET /api/services/admin/reports/export/excel
 * @desc    Export reports to Excel format (direct endpoint)
 * @access  Employee Only (super_admin, admin, manager, accountant)
 * @query   start_date (ISO format, optional)
 * @query   end_date (ISO format, optional)
 * @query   report_type (transactions|providers|categories|all)
 */
router.get(
    '/export/excel',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager', 'accountant'),
    exportToExcel
);

/**
 * @route   GET /api/services/admin/reports/export/pdf
 * @desc    Export reports to PDF format (direct endpoint)
 * @access  Employee Only (super_admin, admin, manager, accountant)
 * @query   start_date (ISO format, optional)
 * @query   end_date (ISO format, optional)
 * @query   report_type (summary|detailed)
 */
router.get(
    '/export/pdf',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager', 'accountant'),
    exportToPDF
);

/**
 * @route   GET /api/services/admin/reports/export/csv
 * @desc    Export reports to CSV format (direct endpoint)
 * @access  Employee Only (super_admin, admin, manager, accountant)
 * @query   start_date (ISO format, optional)
 * @query   end_date (ISO format, optional)
 * @query   report_type (transactions|providers|categories)
 */
router.get(
    '/export/csv',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager', 'accountant'),
    exportToCSV
);

// ═══════════════════════════════════════════════════════════════════════
// EXPORT ROUTER
// ═══════════════════════════════════════════════════════════════════════

module.exports = router;