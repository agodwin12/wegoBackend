const express = require('express');
const router = express.Router();
const supportController = require('../../controllers/backoffice/supportController');
const { authenticateEmployee } = require('../../middleware/employeeAuth.middleware');

// Apply authentication to all routes - ALL backoffice employees can access
router.use(authenticateEmployee);

// Get all support tickets (with pagination and filters)
router.get('/', supportController.getAllTickets);

// Get single ticket by ID
router.get('/:id', supportController.getTicketById);

// Update ticket status
router.patch('/:id/status', supportController.updateTicketStatus);

// Assign ticket to employee
router.patch('/:id/assign', supportController.assignTicket);

// Add response/note to ticket
router.post('/:id/response', supportController.addTicketResponse);

// Get ticket responses/history
router.get('/:id/responses', supportController.getTicketResponses);

module.exports = router;