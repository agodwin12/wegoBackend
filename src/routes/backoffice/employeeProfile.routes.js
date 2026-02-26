// backend/src/routes/backoffice/employeeProfile.routes.js
// Employee Profile Routes

const express = require('express');
const router = express.Router();
const multer = require('multer');

// ✅ CORRECT IMPORT - From backend/middleware/employeeAuth.middleware.js
const { authenticateEmployee } = require('../../middleware/employeeAuth.middleware');

const {
    getProfile,
    updateProfile,
    updateProfilePhoto,
    changePassword
} = require('../../controllers/backoffice/employeeProfile.controller');

// ═══════════════════════════════════════════════════════════════════════
// MULTER CONFIGURATION (In-memory storage for R2)
// ═══════════════════════════════════════════════════════════════════════

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
    const allowedExtensions = /\.(jpg|jpeg|png|webp)$/i;
    const isValidExt = allowedExtensions.test(file.originalname);
    const isValidMime =
        file.mimetype.startsWith('image/') ||
        file.mimetype === 'application/octet-stream';

    if (isValidExt && isValidMime) {
        cb(null, true);
    } else {
        cb(new Error('Only image files (JPG, PNG, WEBP) are allowed!'), false);
    }
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// ═══════════════════════════════════════════════════════════════════════
// EMPLOYEE PROFILE ROUTES
// ═══════════════════════════════════════════════════════════════════════

router.get('/', authenticateEmployee, getProfile);
router.put('/', authenticateEmployee, updateProfile);
router.put('/photo', authenticateEmployee, upload.single('photo'), updateProfilePhoto);
router.put('/password', authenticateEmployee, changePassword);

module.exports = router;