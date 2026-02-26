// backend/controllers/driverProfileController.js
// WEGO - Driver Profile Management Controller
// FIXED: Uses existing upload middleware

const { Account, Driver, Vehicle, DriverDocument } = require('../models');
const { uploadDocumentToR2, uploadVehicleToR2, deleteFile } = require('../middleware/upload'); // ← FIXED
const path = require('path');

// ═══════════════════════════════════════════════════════════════════
// DRIVER PROFILE INFO
// ═══════════════════════════════════════════════════════════════════

/**
 * @route   GET /api/profile/driver
 * @desc    Get driver profile information (for profile section)
 * @access  Private (Driver only)
 */
exports.getDriverProfile = async (req, res) => {
    try {
        const userId = req.user.id;

        // Check if user is a driver
        const driver = await Driver.findOne({
            where: { user_id: userId },
            include: [
                {
                    model: Account,
                    as: 'user',
                    attributes: ['id', 'first_name', 'last_name', 'email', 'phone', 'avatar_url']
                },
                {
                    model: Vehicle,
                    as: 'vehicle'
                }
            ]
        });

        if (!driver) {
            return res.status(404).json({
                success: false,
                message: 'Driver profile not found'
            });
        }

        // Get documents count
        const documentsCount = await DriverDocument.count({
            where: { driver_id: driver.id }
        });

        const profileData = {
            driverId: driver.id,
            userId: driver.user_id,
            licenseNumber: driver.license_number,
            licenseExpiry: driver.license_expiry,
            verificationStatus: driver.verification_status,
            isAvailable: driver.is_available,
            totalRides: driver.total_rides || 0,
            rating: driver.rating,
            documentsCount,
            vehicle: driver.vehicle || null,
            user: driver.user
        };

        res.status(200).json({
            success: true,
            message: 'Driver profile retrieved successfully',
            data: profileData
        });

    } catch (error) {
        console.error('❌ [DRIVER_PROFILE] Get driver profile error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve driver profile',
            error: error.message
        });
    }
};

// ═══════════════════════════════════════════════════════════════════
// VEHICLE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

/**
 * @route   GET /api/profile/driver/vehicle
 * @desc    Get vehicle information
 * @access  Private (Driver only)
 */
exports.getVehicle = async (req, res) => {
    try {
        const userId = req.user.id;

        // Find driver
        const driver = await Driver.findOne({
            where: { user_id: userId }
        });

        if (!driver) {
            return res.status(404).json({
                success: false,
                message: 'Driver not found'
            });
        }

        // Get vehicle
        const vehicle = await Vehicle.findOne({
            where: { driver_id: driver.id }
        });

        if (!vehicle) {
            return res.status(404).json({
                success: false,
                message: 'No vehicle registered yet'
            });
        }

        res.status(200).json({
            success: true,
            message: 'Vehicle information retrieved successfully',
            data: vehicle
        });

    } catch (error) {
        console.error('❌ [DRIVER_PROFILE] Get vehicle error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve vehicle information',
            error: error.message
        });
    }
};

/**
 * @route   POST /api/profile/driver/vehicle
 * @desc    Create or update vehicle information
 * @access  Private (Driver only)
 */
exports.upsertVehicle = async (req, res) => {
    try {
        const userId = req.user.id;
        const {
            brand,
            model,
            year,
            color,
            licensePlate,
            vehicleType,
            capacity,
            insuranceNumber,
            insuranceExpiry
        } = req.body;

        // Find driver
        const driver = await Driver.findOne({
            where: { user_id: userId }
        });

        if (!driver) {
            return res.status(404).json({
                success: false,
                message: 'Driver not found'
            });
        }

        // Check if vehicle exists
        let vehicle = await Vehicle.findOne({
            where: { driver_id: driver.id }
        });

        if (vehicle) {
            // Update existing vehicle
            vehicle.brand = brand || vehicle.brand;
            vehicle.model = model || vehicle.model;
            vehicle.year = year || vehicle.year;
            vehicle.color = color || vehicle.color;
            vehicle.license_plate = licensePlate || vehicle.license_plate;
            vehicle.vehicle_type = vehicleType || vehicle.vehicle_type;
            vehicle.capacity = capacity || vehicle.capacity;
            vehicle.insurance_number = insuranceNumber || vehicle.insurance_number;
            vehicle.insurance_expiry = insuranceExpiry || vehicle.insurance_expiry;

            await vehicle.save();

            console.log('✅ [DRIVER_PROFILE] Vehicle updated:', vehicle.id);

            res.status(200).json({
                success: true,
                message: 'Vehicle information updated successfully',
                data: vehicle
            });

        } else {
            // Create new vehicle
            vehicle = await Vehicle.create({
                driver_id: driver.id,
                brand,
                model,
                year,
                color,
                license_plate: licensePlate,
                vehicle_type: vehicleType,
                capacity,
                insurance_number: insuranceNumber,
                insurance_expiry: insuranceExpiry
            });

            console.log('✅ [DRIVER_PROFILE] Vehicle created:', vehicle.id);

            res.status(201).json({
                success: true,
                message: 'Vehicle information created successfully',
                data: vehicle
            });
        }

    } catch (error) {
        console.error('❌ [DRIVER_PROFILE] Upsert vehicle error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to save vehicle information',
            error: error.message
        });
    }
};

/**
 * @route   DELETE /api/profile/driver/vehicle
 * @desc    Delete vehicle information
 * @access  Private (Driver only)
 */
exports.deleteVehicle = async (req, res) => {
    try {
        const userId = req.user.id;

        // Find driver
        const driver = await Driver.findOne({
            where: { user_id: userId }
        });

        if (!driver) {
            return res.status(404).json({
                success: false,
                message: 'Driver not found'
            });
        }

        // Find and delete vehicle
        const vehicle = await Vehicle.findOne({
            where: { driver_id: driver.id }
        });

        if (!vehicle) {
            return res.status(404).json({
                success: false,
                message: 'No vehicle found to delete'
            });
        }

        await vehicle.destroy();

        console.log('🗑️ [DRIVER_PROFILE] Vehicle deleted:', vehicle.id);

        res.status(200).json({
            success: true,
            message: 'Vehicle information deleted successfully'
        });

    } catch (error) {
        console.error('❌ [DRIVER_PROFILE] Delete vehicle error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete vehicle information',
            error: error.message
        });
    }
};

// ═══════════════════════════════════════════════════════════════════
// DRIVER DOCUMENTS MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

/**
 * @route   GET /api/profile/driver/documents
 * @desc    Get all driver documents
 * @access  Private (Driver only)
 */
exports.getDocuments = async (req, res) => {
    try {
        const userId = req.user.id;

        // Find driver
        const driver = await Driver.findOne({
            where: { user_id: userId }
        });

        if (!driver) {
            return res.status(404).json({
                success: false,
                message: 'Driver not found'
            });
        }

        // Get all documents
        const documents = await DriverDocument.findAll({
            where: { driver_id: driver.id },
            order: [['created_at', 'DESC']]
        });

        res.status(200).json({
            success: true,
            message: 'Documents retrieved successfully',
            data: documents
        });

    } catch (error) {
        console.error('❌ [DRIVER_PROFILE] Get documents error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve documents',
            error: error.message
        });
    }
};

/**
 * @route   POST /api/profile/driver/documents
 * @desc    Upload driver document
 * @access  Private (Driver only)
 */
exports.uploadDocument = async (req, res) => {
    try {
        const userId = req.user.id;
        const { documentType, documentNumber, expiryDate } = req.body;

        // Check if file was uploaded
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No document file provided'
            });
        }

        // Find driver
        const driver = await Driver.findOne({
            where: { user_id: userId }
        });

        if (!driver) {
            return res.status(404).json({
                success: false,
                message: 'Driver not found'
            });
        }

        // Upload to R2 using your existing function
        const documentUrl = await uploadDocumentToR2(req.file);

        // Create document record
        const document = await DriverDocument.create({
            driver_id: driver.id,
            document_type: documentType,
            document_url: documentUrl,
            document_number: documentNumber || null,
            expiry_date: expiryDate || null,
            status: 'pending' // pending, approved, rejected
        });

        console.log('✅ [DRIVER_PROFILE] Document uploaded:', document.id);

        res.status(201).json({
            success: true,
            message: 'Document uploaded successfully. Awaiting admin approval.',
            data: document
        });

    } catch (error) {
        console.error('❌ [DRIVER_PROFILE] Upload document error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to upload document',
            error: error.message
        });
    }
};

/**
 * @route   DELETE /api/profile/driver/documents/:id
 * @desc    Delete driver document
 * @access  Private (Driver only)
 */
exports.deleteDocument = async (req, res) => {
    try {
        const userId = req.user.id;
        const documentId = req.params.id;

        // Find driver
        const driver = await Driver.findOne({
            where: { user_id: userId }
        });

        if (!driver) {
            return res.status(404).json({
                success: false,
                message: 'Driver not found'
            });
        }

        // Find document
        const document = await DriverDocument.findOne({
            where: {
                id: documentId,
                driver_id: driver.id
            }
        });

        if (!document) {
            return res.status(404).json({
                success: false,
                message: 'Document not found'
            });
        }

        // Delete from R2
        try {
            await deleteFile(document.document_url);
            console.log('🗑️ [DRIVER_PROFILE] Document deleted from R2');
        } catch (deleteError) {
            console.error('⚠️ [DRIVER_PROFILE] Failed to delete from R2:', deleteError.message);
            // Continue to delete from database even if R2 deletion fails
        }

        // Delete from database
        await document.destroy();

        res.status(200).json({
            success: true,
            message: 'Document deleted successfully'
        });

    } catch (error) {
        console.error('❌ [DRIVER_PROFILE] Delete document error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete document',
            error: error.message
        });
    }
};

module.exports = exports;