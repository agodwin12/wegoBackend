const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Create upload directories if they don't exist
const uploadDirs = {
    profiles: path.join(__dirname, '../../uploads/profiles'),
    documents: path.join(__dirname, '../../uploads/documents'),
    vehicles: path.join(__dirname, '../../uploads/vehicles'),
};

// Create directories
Object.values(uploadDirs).forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`✅ Created directory: ${dir}`);
    }
});

// Storage configuration for PROFILE PICTURES
const profileStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDirs.profiles);
    },
    filename: (req, file, cb) => {
        // Generate unique filename: profile-1699999999999-123456789.jpg
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, `profile-${uniqueSuffix}${ext}`);
    }
});

// Storage configuration for DRIVER DOCUMENTS (license, insurance, CNI)
const documentStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDirs.documents);
    },
    filename: (req, file, cb) => {
        // Generate unique filename with field name: license-1699999999999-123456789.jpg
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        const fieldName = file.fieldname; // 'license', 'insurance', 'cni'
        cb(null, `${fieldName}-${uniqueSuffix}${ext}`);
    }
});

// Storage configuration for VEHICLE PHOTOS
const vehicleStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDirs.vehicles);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, `vehicle-${uniqueSuffix}${ext}`);
    }
});

// File filter - Accept ONLY IMAGES (for profile pictures and vehicle photos)
const imageFilter = (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
        return cb(null, true);
    } else {
        cb(new Error('Only image files (JPEG, JPG, PNG, WEBP) are allowed!'));
    }
};

// File filter - Accept IMAGES and PDFs (for driver documents)
const documentFilter = (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|pdf/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
        return cb(null, true);
    } else {
        cb(new Error('Only image files (JPEG, JPG, PNG) or PDF are allowed!'));
    }
};

// Create multer instances for different upload types
const uploadProfile = multer({
    storage: profileStorage,
    fileFilter: imageFilter,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB max
    }
});

const uploadDocuments = multer({
    storage: documentStorage,
    fileFilter: documentFilter,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB max
    }
});

const uploadVehicle = multer({
    storage: vehicleStorage,
    fileFilter: imageFilter,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB max
    }
});

// Helper function to DELETE a file from filesystem
const deleteFile = (filePath) => {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`🗑️  Deleted file: ${filePath}`);
            return true;
        }
        return false;
    } catch (error) {
        console.error('Error deleting file:', error);
        return false;
    }
};

// Helper to get PUBLIC URL for uploaded file
const getFileUrl = (filename, type = 'profile') => {
    if (!filename) return null;
    // Returns: /uploads/profiles/profile-1699999999999-123456789.jpg
    return `/uploads/${type}s/${filename}`;
};

// Helper to extract filename from URL
const getFilenameFromUrl = (url) => {
    if (!url) return null;
    return path.basename(url);
};

module.exports = {
    uploadProfile,      // Use for profile picture uploads
    uploadDocuments,    // Use for driver document uploads (license, insurance, CNI)
    uploadVehicle,      // Use for vehicle photo uploads
    deleteFile,         // Delete file helper
    getFileUrl,         // Generate public URL
    getFilenameFromUrl, // Extract filename from URL
    uploadDirs          // Directory paths (in case you need them)
};