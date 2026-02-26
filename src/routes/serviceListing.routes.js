// backend/src/routes/serviceListing.routes.js
const express = require('express');
const router = express.Router();
const serviceListingController = require('../controllers/serviceListing.controller');
const serviceListingAdminController = require('../controllers/serviceListingAdmin.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const { authenticateEmployee, requireEmployeeRole } = require('../middleware/employeeAuth.middleware');
const { upload } = require('../middleware/upload');
const validate = require('../middleware/validate');
const serviceListingValidator = require('../validators/servicesMarketplace.validator');

router.get('/', serviceListingController.getAllListings);

router.get('/my/listings', authenticateToken, serviceListingController.getMyListings);

router.post(
    '/',
    authenticateToken,
    upload.array('photos', 5),
    validate(serviceListingValidator.createListing),
    serviceListingController.createListing
);

router.get('/:id', serviceListingController.getListingById);

router.put(
    '/:id',
    authenticateToken,
    upload.array('photos', 5),
    validate(serviceListingValidator.updateListing),
    serviceListingController.updateListing
);

router.delete('/:id', authenticateToken, serviceListingController.deleteListing);

router.get(
    '/admin/stats',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    serviceListingAdminController.getModerationStats
);

router.get(
    '/admin/pending',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    serviceListingAdminController.getPendingListings
);

router.get(
    '/admin/all',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    serviceListingAdminController.getAllListingsAdmin
);

router.get(
    '/admin/:id',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    serviceListingAdminController.getListingByIdAdmin
);

router.post(
    '/admin/:id/approve',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    serviceListingAdminController.approveListing
);

router.post(
    '/admin/:id/reject',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    serviceListingAdminController.rejectListing
);

router.post(
    '/admin/:id/activate',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    serviceListingAdminController.activateListing
);

router.post(
    '/admin/:id/deactivate',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    serviceListingAdminController.deactivateListing
);

router.delete(
    '/admin/:id',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    serviceListingAdminController.deleteListingPermanently
);

module.exports = router;