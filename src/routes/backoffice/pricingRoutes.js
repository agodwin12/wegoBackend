const express = require('express');
const router = express.Router();
const pricingController = require('../../controllers/backoffice/pricingController');
const { authenticateEmployee, requireEmployeeRole } = require('../../middleware/employeeAuth.middleware');

// All routes require authentication and specific roles
const allowedRoles = ['admin', 'super_admin', 'manager'];

// Apply authentication middleware to all routes
router.use(authenticateEmployee);
router.use(requireEmployeeRole(...allowedRoles));

// GET /api/backoffice/pricing - Get all price rules with pagination and filters
router.get('/', pricingController.getAllPriceRules);

// GET /api/backoffice/pricing/cities - Get all active cities
router.get('/cities', pricingController.getActiveCities);

// GET /api/backoffice/pricing/:id - Get single price rule by ID
router.get('/:id', pricingController.getPriceRuleById);

// GET /api/backoffice/pricing/city/:city - Get price rule by city
router.get('/city/:city', pricingController.getPriceRuleByCity);

// POST /api/backoffice/pricing - Create new price rule
router.post('/', pricingController.createPriceRule);

// POST /api/backoffice/pricing/calculate - Calculate fare estimate
router.post('/calculate', pricingController.calculateFareEstimate);

// PUT /api/backoffice/pricing/:id - Update price rule
router.put('/:id', pricingController.updatePriceRule);

// PATCH /api/backoffice/pricing/:id/toggle - Toggle price rule status
router.patch('/:id/toggle', pricingController.togglePriceRuleStatus);

// DELETE /api/backoffice/pricing/:id - Delete price rule
router.delete('/:id', pricingController.deletePriceRule);

module.exports = router;