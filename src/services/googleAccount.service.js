// src/services/googleAccount.service.js
'use strict';

const { Op } = require('sequelize');

const {
    Account,
    PassengerProfile,
    DriverProfile,
    Driver,
    DeliveryWallet,
} = require('../models');

const { verifyGoogleIdToken } = require('./googleAuth.service');
const { generateTokens } = require('./login.service');

const ALLOWED_GOOGLE_USER_TYPES = ['PASSENGER', 'DRIVER'];

function makeGoogleAccountError(message, status = 400, code = 'GOOGLE_ACCOUNT_ERROR') {
    const err = new Error(message);
    err.status = status;
    err.code = code;
    return err;
}

function normalizeRequestedUserType(userType) {
    const normalized = String(userType || '').trim().toUpperCase();

    if (!normalized) {
        throw makeGoogleAccountError(
            'user_type is required. Use PASSENGER or DRIVER.',
            400,
            'GOOGLE_USER_TYPE_REQUIRED'
        );
    }

    if (!ALLOWED_GOOGLE_USER_TYPES.includes(normalized)) {
        throw makeGoogleAccountError(
            'Google authentication is only available for passengers and drivers.',
            403,
            'GOOGLE_SIGNUP_NOT_ALLOWED_FOR_USER_TYPE'
        );
    }

    return normalized;
}

function splitNameFallback(googleProfile) {
    let firstName = googleProfile.first_name;
    let lastName = googleProfile.last_name;

    if ((!firstName || !lastName) && googleProfile.full_name) {
        const parts = String(googleProfile.full_name).trim().split(/\s+/);

        if (!firstName) {
            firstName = parts.shift() || null;
        }

        if (!lastName) {
            lastName = parts.join(' ') || null;
        }
    }

    return {
        firstName,
        lastName,
    };
}

async function loadAccountForAuth(whereClause) {
    return Account.findOne({
        where: whereClause,
        include: [
            {
                model: PassengerProfile,
                as: 'passenger_profile',
                required: false,
            },
            {
                model: DriverProfile,
                as: 'driver_profile',
                required: false,
            },
            {
                model: Driver,
                as: 'driver_record',
                foreignKey: 'userId',
                required: false,
                include: [
                    {
                        model: DeliveryWallet,
                        as: 'delivery_wallet',
                        required: false,
                    },
                ],
            },
        ],
    });
}

async function reloadAccountByUuid(uuid) {
    return loadAccountForAuth({ uuid });
}

function buildCompleteUser(account) {
    const raw = account.toJSON ? account.toJSON() : account;

    const {
        password_hash,
        password_algo,
        passenger_profile,
        driver_profile,
        ...safeAccount
    } = raw;

    const user = {
        ...safeAccount,
        user_type: account.user_type,
        active_mode: account.active_mode || account.user_type,
        status: account.status,
    };

    if (account.user_type === 'PASSENGER' && account.passenger_profile) {
        const profile = account.passenger_profile.toJSON
            ? account.passenger_profile.toJSON()
            : account.passenger_profile;

        user.profile = {
            address_text: profile.address_text,
            notes: profile.notes,
        };
    }

    if (account.user_type === 'DRIVER' && account.driver_profile) {
        const profile = account.driver_profile.toJSON
            ? account.driver_profile.toJSON()
            : account.driver_profile;

        user.profile = {
            cni_number: profile.cni_number,
            license_number: profile.license_number,
            license_expiry: profile.license_expiry,
            license_document_url: profile.license_document_url,

            insurance_number: profile.insurance_number,
            insurance_expiry: profile.insurance_expiry,
            insurance_document_url: profile.insurance_document_url,

            vehicle_type: profile.vehicle_type,
            vehicle_make_model: profile.vehicle_make_model,
            vehicle_color: profile.vehicle_color,
            vehicle_year: profile.vehicle_year,
            vehicle_plate: profile.vehicle_plate,
            vehicle_photo_url: profile.vehicle_photo_url,

            verification_state: profile.verification_state,
            is_online: profile.is_online,
            is_available: profile.is_available,
        };
    }

    return user;
}

async function linkGoogleToExistingAccount(account, googleProfile, requestedUserType) {
    console.log('🔗 [GOOGLE ACCOUNT] Existing account found. Checking link rules...');

    if (account.user_type !== requestedUserType) {
        throw makeGoogleAccountError(
            `This email is already registered as ${account.user_type}.`,
            409,
            'ACCOUNT_EXISTS_WITH_DIFFERENT_ROLE'
        );
    }

    if (
        account.google_id &&
        account.google_id !== googleProfile.google_id
    ) {
        throw makeGoogleAccountError(
            'This account is already linked to another Google account.',
            409,
            'GOOGLE_ACCOUNT_ALREADY_LINKED'
        );
    }

    const updates = {
        google_id: googleProfile.google_id,
        email_verified: true,
        last_login_provider: 'GOOGLE',
    };

    if (account.auth_provider === 'LOCAL') {
        updates.auth_provider = 'LOCAL_GOOGLE';
    } else if (!account.auth_provider) {
        updates.auth_provider = 'GOOGLE';
    }

    if (!account.google_avatar_url && googleProfile.avatar_url) {
        updates.google_avatar_url = googleProfile.avatar_url;
    }

    if (!account.avatar_url && googleProfile.avatar_url) {
        updates.avatar_url = googleProfile.avatar_url;
    }

    await account.update(updates);

    console.log('✅ [GOOGLE ACCOUNT] Google linked to existing account');

    return reloadAccountByUuid(account.uuid);
}

async function createGooglePassengerAccount(googleProfile) {
    const { firstName, lastName } = splitNameFallback(googleProfile);

    console.log('👤 [GOOGLE ACCOUNT] Creating PASSENGER account...');

    const account = await Account.create({
        user_type: 'PASSENGER',
        active_mode: 'PASSENGER',

        google_id: googleProfile.google_id,
        auth_provider: 'GOOGLE',
        last_login_provider: 'GOOGLE',
        google_avatar_url: googleProfile.avatar_url,

        email: googleProfile.email,
        email_verified: true,

        // Google does not reliably provide phone.
        phone_e164: null,
        phone_verified: false,

        password_hash: null,
        password_algo: null,

        first_name: firstName,
        last_name: lastName,
        avatar_url: googleProfile.avatar_url,

        // Passenger can enter dashboard only after phone verification if your app enforces it.
        // We return requires_phone_verification = true to guide Flutter.
        status: 'ACTIVE',
    });

    await PassengerProfile.create({
        account_uuid: account.uuid,
        address_text: null,
        notes: 'Created with Google OAuth',
    });

    console.log('✅ [GOOGLE ACCOUNT] Passenger account created:', account.uuid);

    return reloadAccountByUuid(account.uuid);
}

async function createGoogleDriverAccount(googleProfile) {
    const { firstName, lastName } = splitNameFallback(googleProfile);

    console.log('🚗 [GOOGLE ACCOUNT] Creating DRIVER account...');

    /**
     * Important:
     * We keep status ACTIVE so refresh tokens continue to work.
     * The driver still cannot work until driver_profile/documents are completed
     * and verification_state becomes approved in your driver flow.
     */
    const account = await Account.create({
        user_type: 'DRIVER',
        active_mode: 'DRIVER',

        google_id: googleProfile.google_id,
        auth_provider: 'GOOGLE',
        last_login_provider: 'GOOGLE',
        google_avatar_url: googleProfile.avatar_url,

        email: googleProfile.email,
        email_verified: true,

        phone_e164: null,
        phone_verified: false,

        password_hash: null,
        password_algo: null,

        first_name: firstName,
        last_name: lastName,
        avatar_url: googleProfile.avatar_url,

        status: 'ACTIVE',
    });

    console.log('✅ [GOOGLE ACCOUNT] Driver base account created:', account.uuid);
    console.log('⚠️ [GOOGLE ACCOUNT] Driver profile still required');

    return reloadAccountByUuid(account.uuid);
}

function buildGoogleAuthFlags(account) {
    const requiresPhoneVerification = !account.phone_verified;

    const requiresDriverProfile =
        account.user_type === 'DRIVER' &&
        !account.driver_profile;

    const requiresAdminApproval =
        account.user_type === 'DRIVER' &&
        (
            !account.driver_profile ||
            account.driver_profile.verification_state !== 'APPROVED'
        );

    return {
        requires_phone_verification: requiresPhoneVerification,
        requires_driver_profile: requiresDriverProfile,
        requires_admin_approval: requiresAdminApproval,
    };
}

async function googleAuth({ idToken, userType, tokenOptions = {} }) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔐 [GOOGLE ACCOUNT] Starting Google auth flow...');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const requestedUserType = normalizeRequestedUserType(userType);

    const googleProfile = await verifyGoogleIdToken(idToken);

    console.log('📧 [GOOGLE ACCOUNT] Email:', googleProfile.email);
    console.log('👤 [GOOGLE ACCOUNT] Requested user type:', requestedUserType);

    let account = await loadAccountForAuth({
        [Op.or]: [
            {
                google_id: googleProfile.google_id,
            },
            {
                email: googleProfile.email,
            },
        ],
    });

    if (account) {
        account = await linkGoogleToExistingAccount(
            account,
            googleProfile,
            requestedUserType
        );
    } else if (requestedUserType === 'PASSENGER') {
        account = await createGooglePassengerAccount(googleProfile);
    } else if (requestedUserType === 'DRIVER') {
        account = await createGoogleDriverAccount(googleProfile);
    }

    if (!account) {
        throw makeGoogleAccountError(
            'Failed to create or retrieve Google account.',
            500,
            'GOOGLE_ACCOUNT_CREATE_FAILED'
        );
    }

    if (account.status === 'DELETED') {
        throw makeGoogleAccountError(
            'This account has been deleted.',
            403,
            'ACCOUNT_DELETED'
        );
    }

    if (account.status === 'SUSPENDED') {
        throw makeGoogleAccountError(
            'Your account has been suspended. Please contact support.',
            403,
            'ACCOUNT_SUSPENDED'
        );
    }

    await account.update({
        last_login_provider: 'GOOGLE',
    });

    account = await reloadAccountByUuid(account.uuid);

    const tokens = await generateTokens(account, tokenOptions);
    const user = buildCompleteUser(account);
    const flags = buildGoogleAuthFlags(account);

    console.log('✅ [GOOGLE ACCOUNT] Google auth successful');
    console.log('   UUID:', account.uuid);
    console.log('   Type:', account.user_type);
    console.log('   Phone required:', flags.requires_phone_verification);
    console.log('   Driver profile required:', flags.requires_driver_profile);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    return {
        account,
        user,
        tokens,
        flags,
        isNewAccount: account.created_at === account.updated_at,
    };
}

module.exports = {
    googleAuth,
};