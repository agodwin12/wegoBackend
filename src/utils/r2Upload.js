// backend/utils/r2Upload.js
// Cloudflare R2 Upload Utility using AWS S3 SDK
// Handles images AND videos for service listings

const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const path   = require('path');

// ── R2 Client ─────────────────────────────────────────────────────────────────
const r2Client = new S3Client({
    region:   process.env.R2_REGION || 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId:     process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

// ─────────────────────────────────────────────────────────────────────────────
// UPLOAD SINGLE FILE TO R2
// Works for any file type — images, videos, PDFs.
// @param {Buffer} fileBuffer  - File content as Buffer
// @param {string} fileName    - Original filename (used for extension only)
// @param {string} folder      - Destination folder in bucket
// @param {string} mimeType    - MIME type (e.g. 'image/jpeg', 'video/mp4')
// @returns {Promise<string>}  - Public URL
// ─────────────────────────────────────────────────────────────────────────────
async function uploadToR2(fileBuffer, fileName, folder = 'uploads', mimeType = 'image/jpeg') {
    try {
        const fileExt   = path.extname(fileName).toLowerCase();
        const uniqueName = `${crypto.randomBytes(16).toString('hex')}${fileExt}`;
        const key        = `${folder}/${uniqueName}`;

        const command = new PutObjectCommand({
            Bucket:      process.env.R2_BUCKET_NAME,
            Key:         key,
            Body:        fileBuffer,
            ContentType: mimeType,
        });

        await r2Client.send(command);

        const publicUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
        return publicUrl;
    } catch (error) {
        console.error('❌ R2 Upload Error:', error);
        throw new Error('File upload failed');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE FILE FROM R2
// ─────────────────────────────────────────────────────────────────────────────
async function deleteFromR2(fileUrl) {
    try {
        const urlObj = new URL(fileUrl);
        const key    = urlObj.pathname.substring(1); // remove leading slash

        const command = new DeleteObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key:    key,
        });

        await r2Client.send(command);
        return true;
    } catch (error) {
        console.error('❌ R2 Delete Error:', error);
        return false;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// UPLOAD MULTIPLE FILES TO R2
// ─────────────────────────────────────────────────────────────────────────────
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