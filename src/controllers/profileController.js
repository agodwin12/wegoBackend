// backend/controllers/profileController.js
// WEGO - Profile Management Controller
// Complete & Fixed - Uses correct column naming conventions

const { Account, Trip, ServiceListing, ServiceRequest, ServiceRating } = require('../models');
const { uploadProfileToR2, deleteFile } = require('../middleware/upload');

/**
 * @route   GET /api/users/profile
 * @desc    Get current user's profile with basic stats
 * @access  Private
 */
exports.getProfile = async (req, res) => {
    try {
        const user = req.user;
        const userUuid = user.uuid;

        console.log('📱 [PROFILE CONTROLLER] Getting profile for user:', userUuid);

        // Calculate basic stats (errors are caught and return zeros)
        const stats = await calculateUserStats(userUuid);

        // Check if user is also a service provider
        let isServiceProvider = false;
        try {
            isServiceProvider = await ServiceListing.count({
                where: { provider_id: userUuid }
            }) > 0;
        } catch (error) {
            console.log('⚠️ [PROFILE] Could not check service provider status:', error.message);
        }

        // Format response with null safety
        const profileData = {
            uuid: user.uuid,
            userType: user.user_type,
            firstName: user.first_name || '',
            lastName: user.last_name || '',
            fullName: `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'User',
            email: user.email || '',
            phone: user.phone_e164 || '',
            phoneVerified: user.phone_verified || false,
            emailVerified: user.email_verified || false,
            avatarUrl: user.avatar_url || null,
            civility: user.civility || null,
            birthDate: user.birth_date || null,
            isVerified: (user.phone_verified && user.email_verified) || false,
            isServiceProvider,
            createdAt: user.created_at,
            updatedAt: user.updated_at,
            stats
        };

        console.log('✅ [PROFILE CONTROLLER] Profile retrieved successfully');

        res.status(200).json({
            success: true,
            message: 'Profile retrieved successfully',
            data: {
                user: profileData
            }
        });

    } catch (error) {
        console.error('❌ [PROFILE] Get profile error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve profile',
            error: error.message
        });
    }
};

/**
 * @route   PUT /api/users/profile
 * @desc    Update user profile
 * @access  Private
 */
exports.updateProfile = async (req, res) => {
    try {
        const user = req.user;
        const userUuid = user.uuid;
        const { firstName, lastName, civility, birthDate } = req.body;

        console.log('📱 [PROFILE CONTROLLER] Updating profile for user:', userUuid);

        // Update fields (only if provided)
        if (firstName) user.first_name = firstName;
        if (lastName) user.last_name = lastName;
        if (civility) user.civility = civility;
        if (birthDate) user.birth_date = birthDate;

        await user.save();

        // Return updated profile
        const stats = await calculateUserStats(userUuid);

        let isServiceProvider = false;
        try {
            isServiceProvider = await ServiceListing.count({
                where: { provider_id: userUuid }
            }) > 0;
        } catch (error) {
            console.log('⚠️ [PROFILE] Could not check service provider status:', error.message);
        }

        // Format response with null safety
        const profileData = {
            uuid: user.uuid,
            userType: user.user_type,
            firstName: user.first_name || '',
            lastName: user.last_name || '',
            fullName: `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'User',
            email: user.email || '',
            phone: user.phone_e164 || '',
            phoneVerified: user.phone_verified || false,
            emailVerified: user.email_verified || false,
            avatarUrl: user.avatar_url || null,
            civility: user.civility || null,
            birthDate: user.birth_date || null,
            isVerified: (user.phone_verified && user.email_verified) || false,
            isServiceProvider,
            createdAt: user.created_at,
            updatedAt: user.updated_at,
            stats
        };

        console.log('✅ [PROFILE CONTROLLER] Profile updated successfully');

        res.status(200).json({
            success: true,
            message: 'Profile updated successfully',
            data: {
                user: profileData
            }
        });

    } catch (error) {
        console.error('❌ [PROFILE] Update profile error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update profile',
            error: error.message
        });
    }
};

/**
 * @route   POST /api/users/profile/avatar
 * @desc    Upload/update user avatar
 * @access  Private
 */
exports.uploadAvatar = async (req, res) => {
    try {
        const user = req.user;
        const userUuid = user.uuid;

        console.log('📱 [PROFILE CONTROLLER] Uploading avatar for user:', userUuid);

        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No avatar file provided'
            });
        }

        // Delete old avatar from R2 if exists
        if (user.avatar_url) {
            try {
                await deleteFile(user.avatar_url);
                console.log('🗑️ [PROFILE] Old avatar deleted');
            } catch (deleteError) {
                console.error('⚠️ [PROFILE] Failed to delete old avatar:', deleteError.message);
            }
        }

        // Upload to R2
        const avatarUrl = await uploadProfileToR2(req.file);

        // Update user avatar URL
        user.avatar_url = avatarUrl;
        await user.save();

        console.log('✅ [PROFILE] Avatar uploaded:', avatarUrl);

        res.status(200).json({
            success: true,
            message: 'Avatar uploaded successfully',
            data: {
                avatarUrl
            }
        });

    } catch (error) {
        console.error('❌ [PROFILE] Upload avatar error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to upload avatar',
            error: error.message
        });
    }
};

/**
 * @route   DELETE /api/users/profile/avatar
 * @desc    Delete user avatar
 * @access  Private
 */
exports.deleteAvatar = async (req, res) => {
    try {
        const user = req.user;
        const userUuid = user.uuid;

        console.log('📱 [PROFILE CONTROLLER] Deleting avatar for user:', userUuid);

        if (!user.avatar_url) {
            return res.status(400).json({
                success: false,
                message: 'No avatar to delete'
            });
        }

        // Delete from R2
        try {
            await deleteFile(user.avatar_url);
            console.log('🗑️ [PROFILE] Avatar deleted from R2');
        } catch (deleteError) {
            console.error('⚠️ [PROFILE] Failed to delete avatar from R2:', deleteError.message);
        }

        // Remove avatar URL from database
        user.avatar_url = null;
        await user.save();

        console.log('✅ [PROFILE] Avatar deleted successfully');

        res.status(200).json({
            success: true,
            message: 'Avatar deleted successfully'
        });

    } catch (error) {
        console.error('❌ [PROFILE] Delete avatar error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete avatar',
            error: error.message
        });
    }
};

/**
 * @route   GET /api/users/stats
 * @desc    Get detailed user statistics
 * @access  Private
 */
exports.getStats = async (req, res) => {
    try {
        const user = req.user;
        const userUuid = user.uuid;

        console.log('📱 [PROFILE CONTROLLER] Getting stats for user:', userUuid);

        // Get detailed stats
        const detailedStats = await calculateDetailedStats(userUuid);

        console.log('✅ [PROFILE CONTROLLER] Stats retrieved successfully');

        res.status(200).json({
            success: true,
            message: 'Statistics retrieved successfully',
            data: detailedStats
        });

    } catch (error) {
        console.error('❌ [PROFILE] Get stats error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve statistics',
            error: error.message
        });
    }
};

/**
 * @route   PUT /api/users/change-password
 * @desc    Change user password
 * @access  Private
 */
exports.changePassword = async (req, res) => {
    try {
        const user = req.user;
        const userUuid = user.uuid;
        const { currentPassword, newPassword } = req.body;

        console.log('📱 [PROFILE CONTROLLER] Changing password for user:', userUuid);

        // Verify current password
        const bcrypt = require('bcrypt');
        const isPasswordValid = await bcrypt.compare(currentPassword, user.password_hash);

        if (!isPasswordValid) {
            return res.status(401).json({
                success: false,
                message: 'Current password is incorrect'
            });
        }

        // Check if new password is different from current
        const isSamePassword = await bcrypt.compare(newPassword, user.password_hash);
        if (isSamePassword) {
            return res.status(400).json({
                success: false,
                message: 'New password must be different from current password'
            });
        }

        // Hash new password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);

        // Update password
        user.password_hash = hashedPassword;
        await user.save();

        console.log('✅ [PROFILE] Password changed for user:', userUuid);

        res.status(200).json({
            success: true,
            message: 'Password changed successfully'
        });

    } catch (error) {
        console.error('❌ [PROFILE] Change password error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to change password',
            error: error.message
        });
    }
};

/**
 * @route   DELETE /api/users/account
 * @desc    Soft delete user account (30-day grace period)
 * @access  Private
 */
exports.deleteAccount = async (req, res) => {
    try {
        const user = req.user;
        const userUuid = user.uuid;
        const { password } = req.body;

        console.log('📱 [PROFILE CONTROLLER] Deleting account for user:', userUuid);

        // Verify password
        const bcrypt = require('bcrypt');
        const isPasswordValid = await bcrypt.compare(password, user.password_hash);

        if (!isPasswordValid) {
            return res.status(401).json({
                success: false,
                message: 'Password is incorrect'
            });
        }

        // Soft delete (set deleted_at)
        const deletedAt = new Date();
        user.deleted_at = deletedAt;
        await user.save();

        console.log('🗑️ [PROFILE] Account soft deleted:', userUuid);

        res.status(200).json({
            success: true,
            message: 'Account deleted successfully. You have 30 days to recover your account.',
            data: {
                deletedAt,
                recoveryDeadline: new Date(deletedAt.getTime() + 30 * 24 * 60 * 60 * 1000)
            }
        });

    } catch (error) {
        console.error('❌ [PROFILE] Delete account error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete account',
            error: error.message
        });
    }
};

// ═══════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS - FIXED: Mixed naming conventions
// Trip model uses camelCase (passengerId, driverId)
// Service models use snake_case (provider_id)
// ═══════════════════════════════════════════════════════════════════

/**
 * Calculate basic user statistics
 */
async function calculateUserStats(userUuid) {
    try {
        // Total rides as passenger (camelCase)
        let totalRidesAsPassenger = 0;
        try {
            totalRidesAsPassenger = await Trip.count({
                where: {
                    passengerId: userUuid,
                    status: 'COMPLETED'
                }
            });
        } catch (error) {
            console.log('⚠️ [PROFILE] Error counting passenger rides:', error.message);
        }

        // Total rides as driver (camelCase)
        let totalRidesAsDriver = 0;
        try {
            totalRidesAsDriver = await Trip.count({
                where: {
                    driverId: userUuid,
                    status: 'COMPLETED'
                }
            });
        } catch (error) {
            console.log('⚠️ [PROFILE] Error counting driver rides:', error.message);
        }

        // Service provider stats (snake_case)
        let activeListings = 0;
        try {
            activeListings = await ServiceListing.count({
                where: {
                    provider_id: userUuid,
                    status: 'active'
                }
            });
        } catch (error) {
            console.log('⚠️ [PROFILE] Error counting active moderation:', error.message);
        }

        let completedServices = 0;
        try {
            completedServices = await ServiceRequest.count({
                where: {
                    provider_id: userUuid,
                    status: 'completed'
                }
            });
        } catch (error) {
            console.log('⚠️ [PROFILE] Error counting completed services:', error.message);
        }

        // Average rating as service provider (snake_case)
        let providerRatingData = null;
        try {
            const { Sequelize } = require('sequelize');
            providerRatingData = await ServiceRating.findOne({
                where: { provider_id: userUuid },
                attributes: [
                    [Sequelize.fn('AVG', Sequelize.col('rating')), 'avgRating'],
                    [Sequelize.fn('COUNT', Sequelize.col('rating')), 'totalRatings']
                ],
                raw: true
            });
        } catch (error) {
            console.log('⚠️ [PROFILE] Error calculating provider ratings:', error.message);
        }

        const stats = {
            totalRidesAsPassenger,
            totalRidesAsDriver,
            averageRatingAsDriver: null,
            totalRatingsAsDriver: 0,
            activeListings,
            completedServices,
            averageRatingAsProvider: providerRatingData?.avgRating
                ? parseFloat(providerRatingData.avgRating).toFixed(1)
                : null,
            totalRatingsAsProvider: parseInt(providerRatingData?.totalRatings || 0),
            totalRides: totalRidesAsPassenger + totalRidesAsDriver,
            totalServices: completedServices
        };

        console.log('📊 [PROFILE] Stats calculated:', stats);

        return stats;

    } catch (error) {
        console.error('❌ [PROFILE] Error calculating stats:', error);

        return {
            totalRidesAsPassenger: 0,
            totalRidesAsDriver: 0,
            averageRatingAsDriver: null,
            totalRatingsAsDriver: 0,
            activeListings: 0,
            completedServices: 0,
            averageRatingAsProvider: null,
            totalRatingsAsProvider: 0,
            totalRides: 0,
            totalServices: 0
        };
    }
}

/**
 * Calculate detailed user statistics with earnings
 */
async function calculateDetailedStats(userUuid) {
    try {
        const basicStats = await calculateUserStats(userUuid);

        // Total earnings from rides (as driver) - camelCase
        let ridesEarnings = 0;
        try {
            ridesEarnings = await Trip.sum('fareFinal', {
                where: {
                    driverId: userUuid,
                    status: 'COMPLETED'
                }
            }) || 0;
        } catch (error) {
            console.log('⚠️ [PROFILE] Error calculating rides earnings:', error.message);
        }

        // Total earnings from services - snake_case
        let servicesEarnings = 0;
        try {
            servicesEarnings = await ServiceRequest.sum('final_amount', {
                where: {
                    provider_id: userUuid,
                    status: 'completed',
                    payment_status: 'confirmed'
                }
            }) || 0;
        } catch (error) {
            console.log('⚠️ [PROFILE] Error calculating services earnings:', error.message);
        }

        const commissionOwed = servicesEarnings * 0.15;
        const netEarnings = servicesEarnings - commissionOwed;

        const detailedStats = {
            ...basicStats,
            earnings: {
                totalEarningsFromRides: parseFloat(ridesEarnings).toFixed(2),
                totalEarningsFromServices: parseFloat(servicesEarnings).toFixed(2),
                commissionOwed: parseFloat(commissionOwed).toFixed(2),
                netEarnings: parseFloat(netEarnings).toFixed(2),
                totalEarnings: parseFloat(ridesEarnings + netEarnings).toFixed(2)
            }
        };

        console.log('📊 [PROFILE] Detailed stats calculated:', detailedStats);

        return detailedStats;

    } catch (error) {
        console.error('❌ [PROFILE] Error calculating detailed stats:', error);
        throw error;
    }
}

module.exports = exports;