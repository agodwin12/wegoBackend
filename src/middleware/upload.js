// backend/middleware/upload.js
// Multer + R2 upload middleware
// Handles images, documents, vehicles, AND service listing media (photos + video)

'use strict';

const multer  = require('multer');
const path    = require('path');
const { uploadToR2, deleteFromR2 } = require('../utils/r2Upload');

/* ============================================================
   STORAGE — memory only (buffers go straight to R2)
============================================================ */
const memoryStorage = multer.memoryStorage();

/* ============================================================
   FILE FILTERS
============================================================ */

// Images only (JPEG, PNG, WEBP)
// Accepts application/octet-stream because Flutter sometimes sends that
const imageFilter = (req, file, cb) => {
    const validExt  = /\.(jpg|jpeg|png|webp)$/i.test(file.originalname);
    const validMime = file.mimetype.startsWith('image/') ||
        file.mimetype === 'application/octet-stream';

    if (validExt && validMime) {
        cb(null, true);
    } else {
        cb(new Error('Only image files (JPEG, PNG, WEBP) are allowed.'), false);
    }
};

// Images + PDF for driver/vehicle documents
const documentFilter = (req, file, cb) => {
    const validExt  = /\.(jpg|jpeg|png|pdf)$/i.test(file.originalname);
    const validMime = file.mimetype.startsWith('image/') ||
        file.mimetype === 'application/pdf'  ||
        file.mimetype === 'application/octet-stream';

    if (validExt && validMime) {
        cb(null, true);
    } else {
        cb(new Error('Only JPG, PNG or PDF files are allowed.'), false);
    }
};

// Service listing photos — same as imageFilter but higher size limit
const servicePhotoFilter = imageFilter;

// Service listing VIDEO — MP4, MOV, AVI, MKV, WEBM
// Also accepts application/octet-stream (Flutter quirk)
const serviceVideoFilter = (req, file, cb) => {
    const validExt  = /\.(mp4|mov|avi|mkv|webm)$/i.test(file.originalname);
    const validMime = file.mimetype.startsWith('video/') ||
        file.mimetype === 'application/octet-stream';

    if (validExt && validMime) {
        cb(null, true);
    } else {
        cb(
            new Error('Only video files (MP4, MOV, AVI, MKV, WEBM) are allowed.'),
            false
        );
    }
};

// Mixed filter — accepts both images AND videos
// Used by uploadServiceMedia (photos + optional video in one multipart request)
const serviceMediaFilter = (req, file, cb) => {
    const isImage = /\.(jpg|jpeg|png|webp)$/i.test(file.originalname) &&
        (file.mimetype.startsWith('image/') ||
            file.mimetype === 'application/octet-stream');

    const isVideo = /\.(mp4|mov|avi|mkv|webm)$/i.test(file.originalname) &&
        (file.mimetype.startsWith('video/') ||
            file.mimetype === 'application/octet-stream');

    if (isImage || isVideo) {
        cb(null, true);
    } else {
        cb(
            new Error('Only images (JPG, PNG, WEBP) and videos (MP4, MOV) are allowed.'),
            false
        );
    }
};

/* ============================================================
   MULTER INSTANCES
============================================================ */

// Profile picture — 5 MB
const uploadProfile = multer({
    storage:    memoryStorage,
    fileFilter: imageFilter,
    limits:     { fileSize: 5 * 1024 * 1024 },
});

// Driver / vehicle documents — 10 MB
const uploadDocuments = multer({
    storage:    memoryStorage,
    fileFilter: documentFilter,
    limits:     { fileSize: 10 * 1024 * 1024 },
});

// Vehicle photos — 5 MB
const uploadVehicle = multer({
    storage:    memoryStorage,
    fileFilter: imageFilter,
    limits:     { fileSize: 5 * 1024 * 1024 },
});

// Service listing PHOTOS — up to 5 files, 10 MB each
// Usage in route: uploadServicePhotos.array('photos', 5)
const uploadServicePhotos = multer({
    storage:    memoryStorage,
    fileFilter: servicePhotoFilter,
    limits:     { fileSize: 10 * 1024 * 1024 },
});

// Service listing VIDEO — single file, 100 MB
// Usage in route: uploadServiceVideo.single('video')
const uploadServiceVideo = multer({
    storage:    memoryStorage,
    fileFilter: serviceVideoFilter,
    limits:     { fileSize: 100 * 1024 * 1024 },
});

// Service listing PHOTOS + VIDEO in one request
// Route usage:
//   uploadServiceMedia.fields([
//     { name: 'photos', maxCount: 5 },
//     { name: 'video',  maxCount: 1 },
//   ])
//
// In controller:
//   const photos = req.files['photos'] || [];   // array of image files
//   const video  = req.files['video']?.[0];     // single video file or undefined
const uploadServiceMedia = multer({
    storage:    memoryStorage,
    fileFilter: serviceMediaFilter,
    limits: {
        fileSize: 100 * 1024 * 1024, // 100 MB — covers both photos and video
    },
});

// Generic fallback (backward compat)
const upload = multer({
    storage:    memoryStorage,
    fileFilter: imageFilter,
    limits:     { fileSize: 5 * 1024 * 1024 },
});

/* ============================================================
   R2 UPLOAD HELPERS
============================================================ */

/**
 * Upload a single multer file object to R2.
 * Works for any file type — images, videos, PDFs.
 * @param {Object} file   - Multer file object (must have .buffer and .originalname)
 * @param {string} folder - R2 folder path
 * @returns {Promise<string>} Public URL
 */
const uploadFileToR2 = async (file, folder = 'uploads') => {
    if (!file || !file.buffer) throw new Error('No file buffer provided');
    const mimeType = file.mimetype || 'application/octet-stream';
    return uploadToR2(file.buffer, file.originalname, folder, mimeType);
};

const uploadProfileToR2 = (file) => uploadFileToR2(file, 'profiles');
const uploadDocumentToR2 = (file) => uploadFileToR2(file, 'documents');
const uploadVehicleToR2  = (file) => uploadFileToR2(file, 'vehicles');

/**
 * Upload multiple multer file objects to R2 in parallel.
 * @param {Object[]} files  - Array of multer file objects
 * @param {string}   folder - R2 folder path
 * @returns {Promise<string[]>} Array of public URLs
 */
const uploadMultipleFilesToR2 = async (files, folder = 'uploads') => {
    if (!files || files.length === 0) return [];
    return Promise.all(files.map((f) => uploadFileToR2(f, folder)));
};

/**
 * Delete a file from R2 by its public URL.
 */
const deleteFile = async (fileUrl) => {
    try {
        if (!fileUrl) return false;
        const result = await deleteFromR2(fileUrl);
        if (result) console.log(`🗑️  Deleted from R2: ${fileUrl}`);
        return result;
    } catch (err) {
        console.error('❌ Error deleting from R2:', err);
        return false;
    }
};

/**
 * Delete multiple files from R2.
 */
const deleteMultipleFiles = async (fileUrls) => {
    if (!fileUrls || fileUrls.length === 0) return true;
    const results = await Promise.all(fileUrls.map(deleteFile));
    return results.every(Boolean);
};

/* ============================================================
   BACKWARD-COMPAT HELPERS
============================================================ */

const getFileUrl = (filename, type = 'profile') => {
    if (!filename) return null;
    if (filename.startsWith('http')) return filename;
    return `${process.env.R2_PUBLIC_URL}/${type}s/${filename}`;
};

const getFilenameFromUrl = (url) => {
    if (!url) return null;
    return require('path').basename(url);
};

/* ============================================================
   AUTO-UPLOAD MIDDLEWARE
   Attach after multer — automatically uploads all files to R2
   and adds .r2Url to each file object.
============================================================ */
const autoUploadToR2 = (folderName) => async (req, res, next) => {
    try {
        if (req.file) {
            req.file.r2Url = await uploadFileToR2(req.file, folderName);
            console.log(`✅ Uploaded to R2: ${req.file.r2Url}`);
        }

        if (req.files) {
            if (Array.isArray(req.files)) {
                req.files = await Promise.all(
                    req.files.map(async (f) => {
                        f.r2Url = await uploadFileToR2(f, folderName);
                        console.log(`✅ Uploaded to R2: ${f.r2Url}`);
                        return f;
                    })
                );
            } else {
                // fields() format: { photos: [...], video: [...] }
                for (const field of Object.keys(req.files)) {
                    req.files[field] = await Promise.all(
                        req.files[field].map(async (f) => {
                            f.r2Url = await uploadFileToR2(f, folderName);
                            console.log(`✅ Uploaded to R2: ${f.r2Url}`);
                            return f;
                        })
                    );
                }
            }
        }

        next();
    } catch (error) {
        console.error('❌ autoUploadToR2 error:', error);
        next(error);
    }
};

/* ============================================================
   EXPORTS
============================================================ */
module.exports = {
    // ── Multer middleware ──────────────────────────────────────────────────
    uploadProfile,
    uploadDocuments,
    uploadVehicle,

    // Service listing media (use these in serviceListing routes)
    uploadServicePhotos,   // array('photos', 5)         — images only, 10 MB
    uploadServiceVideo,    // single('video')             — video only, 100 MB
    uploadServiceMedia,    // fields([photos×5, video×1]) — both in one request

    upload,                // generic fallback

    // ── R2 helpers ────────────────────────────────────────────────────────
    uploadFileToR2,
    uploadProfileToR2,
    uploadDocumentToR2,
    uploadVehicleToR2,
    uploadMultipleFilesToR2,

    // ── Delete helpers ─────────────────────────────────────────────────────
    deleteFile,
    deleteMultipleFiles,

    // ── Misc ──────────────────────────────────────────────────────────────
    getFileUrl,
    getFilenameFromUrl,
    autoUploadToR2,
};