// src/services/login.service.js
const { Op } = require('sequelize');
const bcrypt = require('bcrypt');
const { Account, PassengerProfile, DriverProfile } = require('../models');

/**
 * Find account by email or phone number
 * Also includes associated profile data (driver or passenger)
 */
async function findAccountByIdentifier(identifier) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔍 [FIND ACCOUNT] Looking up account...');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📧 Identifier:', identifier);

    // Determine if identifier is email or phone
    const isEmail = identifier.includes('@');
    const whereClause = isEmail
        ? { email: identifier }
        : { phone_e164: identifier };

    console.log('🔍 [SEARCH] Searching by:', isEmail ? 'EMAIL' : 'PHONE');

    // ═══════════════════════════════════════════════════════════════
    // FETCH ACCOUNT WITH PROFILE DATA
    // ═══════════════════════════════════════════════════════════════
    const account = await Account.findOne({
        where: whereClause,
        include: [
            {
                model: PassengerProfile,
                as: 'passenger_profile',
                required: false, // LEFT JOIN - only for passengers
            },
            {
                model: DriverProfile,
                as: 'driver_profile',
                required: false, // LEFT JOIN - only for drivers
            }
        ]
    });

    if (!account) {
        console.log('❌ [FIND ACCOUNT] Account not found');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        return null;
    }

    console.log('✅ [FIND ACCOUNT] Account found!');
    console.log('   UUID:', account.uuid);
    console.log('   User Type:', account.user_type);
    console.log('   Email:', account.email || 'N/A');
    console.log('   Phone:', account.phone_e164 || 'N/A');
    console.log('   Status:', account.status);
    console.log('   Email Verified:', account.email_verified);
    console.log('   Phone Verified:', account.phone_verified);

    if (account.user_type === 'PASSENGER' && account.passenger_profile) {
        console.log('👤 [PASSENGER PROFILE] Loaded');
        console.log('   Address:', account.passenger_profile.address_text || 'N/A');
    }

    if (account.user_type === 'DRIVER' && account.driver_profile) {
        console.log('🚗 [DRIVER PROFILE] Loaded');
        console.log('   License:', account.driver_profile.license_number);
        console.log('   Vehicle Plate:', account.driver_profile.vehicle_plate || 'N/A');
        console.log('   Verification:', account.driver_profile.verification_state);
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    return account;
}

/**
 * Verify password against hash
 */
async function verifyPassword(plainPassword, hash) {
    console.log('🔐 [PASSWORD] Verifying password...');
    const isValid = await bcrypt.compare(plainPassword, hash);
    console.log(isValid ? '✅ [PASSWORD] Valid' : '❌ [PASSWORD] Invalid');
    return isValid;
}

module.exports = {
    findAccountByIdentifier,
    verifyPassword,
};