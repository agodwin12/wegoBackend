// src/routes/backoffice/deliveryAgents.routes.js

const express = require('express');
const router  = express.Router();
const multer  = require('multer');

const listCtrl   = require('../../controllers/backoffice/deliveryAgents.controller');
const createCtrl = require('../../controllers/backoffice/createDeliveryAgent.controller');

const { authenticateEmployee } = require('../../middleware/employeeAuth.middleware');
const { requireEmployeeRole }  = require('../../middleware/employeeAuth.middleware');

// ─── Multer for agent creation (memory storage, multi-field) ──────────────────
// profile_photo: 1 image (optional)
// driver_license: 1 document — image or PDF (required)
const memoryStorage = multer.memoryStorage();

const agentUpload = multer({
    storage: memoryStorage,
    limits:  { fileSize: 10 * 1024 * 1024 }, // 10MB per file
    fileFilter: (req, file, cb) => {
        const imageExts = /\.(jpg|jpeg|png|webp)$/i;
        const docExts   = /\.(jpg|jpeg|png|pdf)$/i;

        const isValidMime =
            file.mimetype.startsWith('image/') ||
            file.mimetype === 'application/pdf' ||
            file.mimetype === 'application/octet-stream';

        if (file.fieldname === 'profile_photo') {
            const isValid = imageExts.test(file.originalname) && isValidMime;
            return cb(isValid ? null : new Error('Profile photo must be JPG, PNG, or WEBP'), isValid);
        }

        if (file.fieldname === 'driver_license') {
            const isValid = docExts.test(file.originalname) && isValidMime;
            return cb(isValid ? null : new Error('Driver license must be JPG, PNG, or PDF'), isValid);
        }

        cb(new Error('Unexpected field'), false);
    },
}).fields([
    { name: 'profile_photo',  maxCount: 1 },
    { name: 'driver_license', maxCount: 1 },
]);

// All routes require employee auth
router.use(authenticateEmployee);

// ─── LIST & FILTER ────────────────────────────────────────────────────────────
// GET /api/backoffice/delivery/agents
router.get('/', listCtrl.getAgents);

// ─── CREATE ───────────────────────────────────────────────────────────────────
// POST /api/backoffice/delivery/agents/create
// multipart/form-data with profile_photo + driver_license files
router.post(
    '/create',
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    agentUpload,
    createCtrl.createAgent
);

// ─── SINGLE AGENT ─────────────────────────────────────────────────────────────
// GET /api/backoffice/delivery/agents/:driverId
router.get('/:driverId', listCtrl.getAgent);

// ─── UPDATE AGENT INFO + FILES ────────────────────────────────────────────────
// PUT /api/backoffice/delivery/agents/:driverId/update
router.put(
    '/:driverId/update',
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    agentUpload,
    createCtrl.updateAgent
);

// ─── SWITCH MODE ──────────────────────────────────────────────────────────────
// PATCH /api/backoffice/delivery/agents/:driverId/mode
router.patch(
    '/:driverId/mode',
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    listCtrl.switchMode
);

// ─── UPDATE STATUS (suspend/reactivate) ───────────────────────────────────────
// PATCH /api/backoffice/delivery/agents/:driverId/status
router.patch(
    '/:driverId/status',
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    createCtrl.updateStatus
);

// ─── RESEND CREDENTIALS ───────────────────────────────────────────────────────
// POST /api/backoffice/delivery/agents/:driverId/resend-credentials
router.post(
    '/:driverId/resend-credentials',
    requireEmployeeRole('super_admin', 'admin', 'manager'),
    createCtrl.resendCredentials
);

module.exports = router;