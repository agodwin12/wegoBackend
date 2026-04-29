
'use strict';

const express = require('express');
const router  = express.Router();

const { uploadProfile, uploadFileToR2 } = require('../middleware/upload');
const { authenticate }                   = require('../middleware/auth.middleware');

/**
 * POST /api/upload/package-photo
 * Multipart field name: "image"
 * Response: { success: true, url: "https://..." }
 */
router.post(
    '/package-photo',
    authenticate,
    uploadProfile.single('image'),
    async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    message: 'No image file provided. Use field name "image".',
                });
            }
            const url = await uploadFileToR2(req.file, 'delivery/packages');
            return res.status(200).json({ success: true, url });
        } catch (error) {
            console.error('❌ [UPLOAD] Package photo failed:', error.message);
            return res.status(500).json({
                success: false,
                message: 'Upload failed. Please try again.',
            });
        }
    }
);

module.exports = router;