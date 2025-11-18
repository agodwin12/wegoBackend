const multer = require("multer");
const path = require("path");
const fs = require("fs");

/* ================================
   CREATE UPLOAD DIRECTORIES
================================= */
const uploadDirs = {
    profiles: path.join(__dirname, "../../uploads/profiles"),
    documents: path.join(__dirname, "../../uploads/documents"),
    vehicles: path.join(__dirname, "../../uploads/vehicles"),
};

Object.values(uploadDirs).forEach((dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`✅ Created directory: ${dir}`);
    }
});

/* ================================
   STORAGE ENGINES
================================= */

// Profile Picture Storage
const profileStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDirs.profiles),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname);
        cb(null, `profile-${uniqueSuffix}${ext}`);
    }
});

// Driver Document Storage
const documentStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDirs.documents),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname);
        cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
    }
});

// Vehicle Photo Storage
const vehicleStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDirs.vehicles),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname);
        cb(null, `vehicle-${uniqueSuffix}${ext}`);
    }
});

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
    storage: profileStorage,
    fileFilter: imageFilter,
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

const uploadDocuments = multer({
    storage: documentStorage,
    fileFilter: documentFilter,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

const uploadVehicle = multer({
    storage: vehicleStorage,
    fileFilter: imageFilter,
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

/* ================================
   HELPERS
================================= */

const deleteFile = (filePath) => {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`🗑️ Deleted file: ${filePath}`);
            return true;
        }
    } catch (err) {
        console.error("❌ Error deleting file:", err);
    }
    return false;
};

const getFileUrl = (filename, type = "profile") => {
    if (!filename) return null;
    return `/uploads/${type}s/${filename}`;
};

const getFilenameFromUrl = (url) => {
    if (!url) return null;
    return path.basename(url);
};

/* ================================
   EXPORTS
================================= */
module.exports = {
    uploadProfile,
    uploadDocuments,
    uploadVehicle,
    deleteFile,
    getFileUrl,
    getFilenameFromUrl,
    uploadDirs,
};
