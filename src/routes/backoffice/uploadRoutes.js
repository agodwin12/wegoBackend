// wegobackend/src/routes/backoffice/uploadRoutes.js

const express = require('express');
const router = express.Router();
const uploadController = require('../../controllers/backoffice/uploadController');
const { uploadProfile } = require('../../middleware/upload');
const { authenticateEmployee, requireEmployeeRole } = require('../../middleware/employeeAuth.middleware');

/**
 * 📤 UPLOAD IMAGE
 * POST /api/backoffice/upload
 * Uploads a single image to Cloudflare R2
 */
router.post(
    '/',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager', 'support'),
    uploadProfile.single('image'), // Multer middleware - expects 'image' field
    uploadController.uploadImage
);

/**
 * 🗑️ DELETE IMAGE
 * DELETE /api/backoffice/upload
 * Deletes an image from Cloudflare R2
 */
router.delete(
    '/',
    authenticateEmployee,
    requireEmployeeRole('super_admin', 'admin', 'manager', 'support'),
    uploadController.deleteImage
);





module.exports = router;