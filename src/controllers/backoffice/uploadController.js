// wegobackend/src/controllers/backoffice/uploadController.js

const { uploadFileToR2 } = require('../../middleware/upload');

/**
 * 📤 UPLOAD IMAGE
 * Handles image uploads to Cloudflare R2
 */
exports.uploadImage = async (req, res) => {
    try {
        console.log('📤 Upload request received');

        // Check if file exists in request (multer puts it in req.file)
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No image file provided'
            });
        }

        const imageFile = req.file;

        console.log('📷 Image details:', {
            originalname: imageFile.originalname,
            size: imageFile.size,
            mimetype: imageFile.mimetype
        });

        // Upload to R2 (using your existing utility)
        const imageUrl = await uploadFileToR2(imageFile, 'backoffice/partners');

        console.log('✅ Image uploaded successfully:', imageUrl);

        return res.status(200).json({
            success: true,
            message: 'Image uploaded successfully',
            data: {
                url: imageUrl
            }
        });

    } catch (error) {
        console.error('❌ Error uploading image:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to upload image',
            error: error.message
        });
    }
};

/**
 * 🗑️ DELETE IMAGE
 * Handles image deletion from Cloudflare R2
 */
exports.deleteImage = async (req, res) => {
    try {
        const { url } = req.body;

        if (!url) {
            return res.status(400).json({
                success: false,
                message: 'Image URL is required'
            });
        }

        console.log('🗑️ Deleting image:', url);

        const { deleteFile } = require('../../middleware/upload');
        await deleteFile(url);

        console.log('✅ Image deleted successfully');

        return res.status(200).json({
            success: true,
            message: 'Image deleted successfully'
        });

    } catch (error) {
        console.error('❌ Error deleting image:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to delete image',
            error: error.message
        });
    }
};