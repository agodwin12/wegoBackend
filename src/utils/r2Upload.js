// backend/utils/r2Upload.js
// Cloudflare R2 Upload Utility using AWS S3 SDK

const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const path = require('path');

// Configure R2 Client (S3-compatible)
const r2Client = new S3Client({
    region: process.env.R2_REGION || 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

/**
 * Upload file to Cloudflare R2
 * @param {Buffer} fileBuffer - File buffer
 * @param {string} fileName - Original file name
 * @param {string} folder - Folder path in bucket (e.g., 'employees', 'drivers')
 * @param {string} mimeType - File MIME type
 * @returns {Promise<string>} - Public URL of uploaded file
 */
async function uploadToR2(fileBuffer, fileName, folder = 'uploads', mimeType = 'image/jpeg') {
    try {
        // Generate unique file name
        const fileExt = path.extname(fileName);
        const uniqueName = `${crypto.randomBytes(16).toString('hex')}${fileExt}`;
        const key = `${folder}/${uniqueName}`;

        // Upload to R2
        const command = new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key,
            Body: fileBuffer,
            ContentType: mimeType,
        });

        await r2Client.send(command);

        // Return public URL
        const publicUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
        return publicUrl;
    } catch (error) {
        console.error('❌ R2 Upload Error:', error);
        throw new Error('File upload failed');
    }
}

/**
 * Delete file from Cloudflare R2
 * @param {string} fileUrl - Full public URL of file
 * @returns {Promise<boolean>}
 */
async function deleteFromR2(fileUrl) {
    try {
        // Extract key from URL
        const urlObj = new URL(fileUrl);
        const key = urlObj.pathname.substring(1); // Remove leading slash

        const command = new DeleteObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key,
        });

        await r2Client.send(command);
        return true;
    } catch (error) {
        console.error('❌ R2 Delete Error:', error);
        return false;
    }
}

/**
 * Upload multiple files to R2
 * @param {Array} files - Array of file objects with buffer, name, mimeType
 * @param {string} folder - Folder path in bucket
 * @returns {Promise<Array<string>>} - Array of public URLs
 */
async function uploadMultipleToR2(files, folder = 'uploads') {
    const uploadPromises = files.map((file) =>
        uploadToR2(file.buffer, file.name, folder, file.mimeType)
    );
    return Promise.all(uploadPromises);
}

module.exports = {
    uploadToR2,
    deleteFromR2,
    uploadMultipleToR2,
    r2Client,
};