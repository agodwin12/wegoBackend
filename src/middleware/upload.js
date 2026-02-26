const multer = require("multer");
const path = require("path");
const { uploadToR2, deleteFromR2 } = require("../utils/r2Upload");

/* ================================
   STORAGE CONFIGURATION
   Using memoryStorage for R2 upload
================================= */

// Memory storage - files stored in memory as Buffer for R2 upload
const memoryStorage = multer.memoryStorage();

/* ================================
   FILE FILTERS (FIXED)
================================= */

// Accepts png even if Flutter sends wrong MIME "application/octet-stream"
const imageFilter = (req, file, cb) => {
    const allowedExtensions = /\.(jpg|jpeg|png|webp)$/i;

    const isValidExt = allowedExtensions.test(file.originalname);
    const isValidMime =
        file.mimetype.startsWith("image/") || file.mimetype === "application/octet-stream";

    if (isValidExt && isValidMime) {
        cb(null, true);
    } else {
        cb(new Error("Only image files (JPEG, JPG, PNG, WEBP) are allowed!"), false);
    }
};

// Allow images + PDF for documents
const documentFilter = (req, file, cb) => {
    const allowedExtensions = /\.(jpg|jpeg|png|pdf)$/i;

    const isValidExt = allowedExtensions.test(file.originalname);
    const isValidMime =
        file.mimetype.startsWith("image/") ||
        file.mimetype === "application/pdf" ||
        file.mimetype === "application/octet-stream";

    if (isValidExt && isValidMime) {
        cb(null, true);
    } else {
        cb(new Error("Only JPG, PNG or PDF files are allowed!"), false);
    }
};

/* ================================
   MULTER CONFIG
================================= */

const uploadProfile = multer({
    storage: memoryStorage,
    fileFilter: imageFilter,
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

const uploadDocuments = multer({
    storage: memoryStorage,
    fileFilter: documentFilter,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

const uploadVehicle = multer({
    storage: memoryStorage,
    fileFilter: imageFilter,
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

/* ================================
   R2 UPLOAD HELPERS
================================= */

/**
 * Upload single file to R2
 * @param {Object} file - Multer file object with buffer
 * @param {string} folder - R2 folder (profiles, documents, vehicles)
 * @returns {Promise<string>} - Public URL
 */
const uploadFileToR2 = async (file, folder = "uploads") => {
    if (!file || !file.buffer) {
        throw new Error("No file buffer provided");
    }

    const mimeType = file.mimetype || "application/octet-stream";
    return await uploadToR2(file.buffer, file.originalname, folder, mimeType);
};

/**
 * Upload profile picture to R2
 * @param {Object} file - Multer file object
 * @returns {Promise<string>} - Public URL
 */
const uploadProfileToR2 = async (file) => {
    return await uploadFileToR2(file, "profiles");
};

/**
 * Upload document to R2
 * @param {Object} file - Multer file object
 * @returns {Promise<string>} - Public URL
 */
const uploadDocumentToR2 = async (file) => {
    return await uploadFileToR2(file, "documents");
};

/**
 * Upload vehicle photo to R2
 * @param {Object} file - Multer file object
 * @returns {Promise<string>} - Public URL
 */
const uploadVehicleToR2 = async (file) => {
    return await uploadFileToR2(file, "vehicles");
};

/**
 * Upload multiple files to R2
 * @param {Array} files - Array of multer file objects
 * @param {string} folder - R2 folder
 * @returns {Promise<Array<string>>} - Array of public URLs
 */
const uploadMultipleFilesToR2 = async (files, folder = "uploads") => {
    if (!files || files.length === 0) {
        return [];
    }

    const uploadPromises = files.map((file) => uploadFileToR2(file, folder));
    return await Promise.all(uploadPromises);
};

/**
 * Delete file from R2
 * @param {string} fileUrl - Full public URL
 * @returns {Promise<boolean>}
 */
const deleteFile = async (fileUrl) => {
    try {
        if (!fileUrl) return false;

        const result = await deleteFromR2(fileUrl);
        if (result) {
            console.log(`🗑️ Deleted file from R2: ${fileUrl}`);
        }
        return result;
    } catch (err) {
        console.error("❌ Error deleting file from R2:", err);
        return false;
    }
};

/**
 * Delete multiple files from R2
 * @param {Array<string>} fileUrls - Array of public URLs
 * @returns {Promise<boolean>}
 */
const deleteMultipleFiles = async (fileUrls) => {
    if (!fileUrls || fileUrls.length === 0) return true;

    const deletePromises = fileUrls.map((url) => deleteFile(url));
    const results = await Promise.all(deletePromises);
    return results.every((result) => result === true);
};

/* ================================
   BACKWARD COMPATIBILITY HELPERS
================================= */

/**
 * Get file URL (for backward compatibility)
 * Now returns the full R2 URL
 */
const getFileUrl = (filename, type = "profile") => {
    if (!filename) return null;

    // If it's already a full URL, return it
    if (filename.startsWith("http")) return filename;

    // Otherwise, construct R2 URL
    return `${process.env.R2_PUBLIC_URL}/${type}s/${filename}`;
};

/**
 * Get filename from URL
 */
const getFilenameFromUrl = (url) => {
    if (!url) return null;
    return path.basename(url);
};

/* ================================
   MIDDLEWARE FOR AUTO R2 UPLOAD
================================= */

const upload = multer({
    storage: memoryStorage,
    fileFilter: imageFilter,
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});


/**
 * Middleware to automatically upload files to R2 after multer processing
 * Use after multer middleware
 */
const autoUploadToR2 = (folderName) => {
    return async (req, res, next) => {
        try {
            // Handle single file
            if (req.file) {
                req.file.r2Url = await uploadFileToR2(req.file, folderName);
                console.log(`✅ Uploaded to R2: ${req.file.r2Url}`);
            }

            // Handle multiple files
            if (req.files) {
                if (Array.isArray(req.files)) {
                    // req.files is array
                    req.files = await Promise.all(
                        req.files.map(async (file) => {
                            file.r2Url = await uploadFileToR2(file, folderName);
                            console.log(`✅ Uploaded to R2: ${file.r2Url}`);
                            return file;
                        })
                    );
                } else {
                    // req.files is object (multiple fields)
                    for (const fieldName in req.files) {
                        req.files[fieldName] = await Promise.all(
                            req.files[fieldName].map(async (file) => {
                                file.r2Url = await uploadFileToR2(file, folderName);
                                console.log(`✅ Uploaded to R2: ${file.r2Url}`);
                                return file;
                            })
                        );
                    }
                }
            }

            next();
        } catch (error) {
            console.error("❌ R2 Upload Error:", error);
            next(error);
        }
    };
};

/* ================================
   EXPORTS
================================= */
module.exports = {
    // Multer middleware (same as before)
    uploadProfile,
    uploadDocuments,
    uploadVehicle,

    // R2 upload functions
    uploadFileToR2,
    uploadProfileToR2,
    uploadDocumentToR2,
    uploadVehicleToR2,
    uploadMultipleFilesToR2,

    // Delete functions
    deleteFile,
    deleteMultipleFiles,

    // Helper functions (backward compatible)
    getFileUrl,
    getFilenameFromUrl,
    upload,
    // Middleware
    autoUploadToR2,
};