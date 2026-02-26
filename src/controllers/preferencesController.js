// backend/controllers/preferencesController.js
// WEGO - User Preferences Controller
// Handles notification settings, privacy settings, and user preferences

const { User, UserPreferences } = require('../models');

// ═══════════════════════════════════════════════════════════════════
// GET PREFERENCES
// ═══════════════════════════════════════════════════════════════════

/**
 * @route   GET /api/preferences
 * @desc    Get user preferences
 * @access  Private
 */
exports.getPreferences = async (req, res) => {
    try {
        const userId = req.user.id;

        // Find or create preferences
        let preferences = await UserPreferences.findOne({
            where: { user_id: userId }
        });

        // If preferences don't exist, create default ones
        if (!preferences) {
            preferences = await UserPreferences.create({
                user_id: userId,
                // Notification preferences (default: all enabled)
                push_notifications: true,
                email_notifications: true,
                sms_notifications: true,
                ride_notifications: true,
                service_notifications: true,
                payment_notifications: true,
                marketing_notifications: false,
                // Privacy preferences (default: moderate privacy)
                show_phone_to_drivers: true,
                show_profile_photo: true,
                share_location_history: false,
                allow_ratings: true,
                // App preferences
                language: 'en',
                theme: 'light'
            });

            console.log('✅ [PREFERENCES] Default preferences created for user:', userId);
        }

        res.status(200).json({
            success: true,
            message: 'Preferences retrieved successfully',
            data: preferences
        });

    } catch (error) {
        console.error('❌ [PREFERENCES] Get preferences error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve preferences',
            error: error.message
        });
    }
};

// ═══════════════════════════════════════════════════════════════════
// UPDATE NOTIFICATION PREFERENCES
// ═══════════════════════════════════════════════════════════════════

/**
 * @route   PUT /api/preferences/notifications
 * @desc    Update notification preferences
 * @access  Private
 */
exports.updateNotificationPreferences = async (req, res) => {
    try {
        const userId = req.user.id;
        const {
            pushNotifications,
            emailNotifications,
            smsNotifications,
            rideNotifications,
            serviceNotifications,
            paymentNotifications,
            marketingNotifications
        } = req.body;

        // Find or create preferences
        let preferences = await UserPreferences.findOne({
            where: { user_id: userId }
        });

        if (!preferences) {
            preferences = await UserPreferences.create({ user_id: userId });
        }

        // Update notification preferences (only if provided)
        if (pushNotifications !== undefined) preferences.push_notifications = pushNotifications;
        if (emailNotifications !== undefined) preferences.email_notifications = emailNotifications;
        if (smsNotifications !== undefined) preferences.sms_notifications = smsNotifications;
        if (rideNotifications !== undefined) preferences.ride_notifications = rideNotifications;
        if (serviceNotifications !== undefined) preferences.service_notifications = serviceNotifications;
        if (paymentNotifications !== undefined) preferences.payment_notifications = paymentNotifications;
        if (marketingNotifications !== undefined) preferences.marketing_notifications = marketingNotifications;

        await preferences.save();

        console.log('✅ [PREFERENCES] Notification preferences updated for user:', userId);

        res.status(200).json({
            success: true,
            message: 'Notification preferences updated successfully',
            data: preferences
        });

    } catch (error) {
        console.error('❌ [PREFERENCES] Update notification preferences error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update notification preferences',
            error: error.message
        });
    }
};

// ═══════════════════════════════════════════════════════════════════
// UPDATE PRIVACY PREFERENCES
// ═══════════════════════════════════════════════════════════════════

/**
 * @route   PUT /api/preferences/privacy
 * @desc    Update privacy preferences
 * @access  Private
 */
exports.updatePrivacyPreferences = async (req, res) => {
    try {
        const userId = req.user.id;
        const {
            showPhoneToDrivers,
            showProfilePhoto,
            shareLocationHistory,
            allowRatings
        } = req.body;

        // Find or create preferences
        let preferences = await UserPreferences.findOne({
            where: { user_id: userId }
        });

        if (!preferences) {
            preferences = await UserPreferences.create({ user_id: userId });
        }

        // Update privacy preferences (only if provided)
        if (showPhoneToDrivers !== undefined) preferences.show_phone_to_drivers = showPhoneToDrivers;
        if (showProfilePhoto !== undefined) preferences.show_profile_photo = showProfilePhoto;
        if (shareLocationHistory !== undefined) preferences.share_location_history = shareLocationHistory;
        if (allowRatings !== undefined) preferences.allow_ratings = allowRatings;

        await preferences.save();

        console.log('✅ [PREFERENCES] Privacy preferences updated for user:', userId);

        res.status(200).json({
            success: true,
            message: 'Privacy preferences updated successfully',
            data: preferences
        });

    } catch (error) {
        console.error('❌ [PREFERENCES] Update privacy preferences error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update privacy preferences',
            error: error.message
        });
    }
};

// ═══════════════════════════════════════════════════════════════════
// UPDATE APP PREFERENCES
// ═══════════════════════════════════════════════════════════════════

/**
 * @route   PUT /api/preferences/app
 * @desc    Update app preferences (language, theme)
 * @access  Private
 */
exports.updateAppPreferences = async (req, res) => {
    try {
        const userId = req.user.id;
        const { language, theme } = req.body;

        // Find or create preferences
        let preferences = await UserPreferences.findOne({
            where: { user_id: userId }
        });

        if (!preferences) {
            preferences = await UserPreferences.create({ user_id: userId });
        }

        // Update app preferences (only if provided)
        if (language !== undefined) preferences.language = language;
        if (theme !== undefined) preferences.theme = theme;

        await preferences.save();

        console.log('✅ [PREFERENCES] App preferences updated for user:', userId);

        res.status(200).json({
            success: true,
            message: 'App preferences updated successfully',
            data: preferences
        });

    } catch (error) {
        console.error('❌ [PREFERENCES] Update app preferences error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update app preferences',
            error: error.message
        });
    }
};

// ═══════════════════════════════════════════════════════════════════
// RESET PREFERENCES
// ═══════════════════════════════════════════════════════════════════

/**
 * @route   POST /api/preferences/reset
 * @desc    Reset all preferences to default
 * @access  Private
 */
exports.resetPreferences = async (req, res) => {
    try {
        const userId = req.user.id;

        // Find preferences
        let preferences = await UserPreferences.findOne({
            where: { user_id: userId }
        });

        if (!preferences) {
            return res.status(404).json({
                success: false,
                message: 'No preferences found to reset'
            });
        }

        // Reset to defaults
        preferences.push_notifications = true;
        preferences.email_notifications = true;
        preferences.sms_notifications = true;
        preferences.ride_notifications = true;
        preferences.service_notifications = true;
        preferences.payment_notifications = true;
        preferences.marketing_notifications = false;
        preferences.show_phone_to_drivers = true;
        preferences.show_profile_photo = true;
        preferences.share_location_history = false;
        preferences.allow_ratings = true;
        preferences.language = 'en';
        preferences.theme = 'light';

        await preferences.save();

        console.log('✅ [PREFERENCES] Preferences reset to default for user:', userId);

        res.status(200).json({
            success: true,
            message: 'Preferences reset to default successfully',
            data: preferences
        });

    } catch (error) {
        console.error('❌ [PREFERENCES] Reset preferences error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to reset preferences',
            error: error.message
        });
    }
};

module.exports = exports;