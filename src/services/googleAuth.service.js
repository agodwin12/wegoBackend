// src/services/googleAuth.service.js
'use strict';

const { OAuth2Client } = require('google-auth-library');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

const client = new OAuth2Client(GOOGLE_CLIENT_ID);

function makeGoogleAuthError(message, status = 400, code = 'GOOGLE_AUTH_ERROR') {
    const err = new Error(message);
    err.status = status;
    err.code = code;
    return err;
}

function requireGoogleClientId() {
    if (!GOOGLE_CLIENT_ID) {
        throw makeGoogleAuthError(
            'Google OAuth is not configured on the server.',
            500,
            'GOOGLE_CLIENT_ID_MISSING'
        );
    }
}

function normalizeGooglePayload(payload) {
    if (!payload) {
        throw makeGoogleAuthError(
            'Invalid Google token payload.',
            401,
            'INVALID_GOOGLE_PAYLOAD'
        );
    }

    const googleId = payload.sub;
    const email = payload.email ? String(payload.email).toLowerCase() : null;
    const emailVerified = payload.email_verified === true;
    const firstName = payload.given_name || null;
    const lastName = payload.family_name || null;
    const fullName = payload.name || null;
    const avatarUrl = payload.picture || null;

    if (!googleId) {
        throw makeGoogleAuthError(
            'Google token is missing subject.',
            401,
            'GOOGLE_SUB_MISSING'
        );
    }

    if (!email) {
        throw makeGoogleAuthError(
            'Google account email is missing.',
            401,
            'GOOGLE_EMAIL_MISSING'
        );
    }

    if (!emailVerified) {
        throw makeGoogleAuthError(
            'Google email is not verified.',
            403,
            'GOOGLE_EMAIL_NOT_VERIFIED'
        );
    }

    return {
        google_id: googleId,
        email,
        email_verified: emailVerified,
        first_name: firstName,
        last_name: lastName,
        full_name: fullName,
        avatar_url: avatarUrl,
    };
}

async function verifyGoogleIdToken(idToken) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔐 [GOOGLE AUTH] Verifying Google ID token...');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    requireGoogleClientId();

    if (!idToken) {
        throw makeGoogleAuthError(
            'Google ID token is required.',
            400,
            'GOOGLE_ID_TOKEN_REQUIRED'
        );
    }

    try {
        const ticket = await client.verifyIdToken({
            idToken,
            audience: GOOGLE_CLIENT_ID,
        });

        const payload = ticket.getPayload();
        const normalized = normalizeGooglePayload(payload);

        console.log('✅ [GOOGLE AUTH] Token verified');
        console.log('   Google ID :', normalized.google_id);
        console.log('   Email     :', normalized.email);
        console.log('   Name      :', normalized.full_name || 'N/A');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return normalized;

    } catch (err) {
        console.error('❌ [GOOGLE AUTH] Token verification failed:', err.message);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        throw makeGoogleAuthError(
            'Invalid Google token.',
            401,
            'INVALID_GOOGLE_TOKEN'
        );
    }
}

module.exports = {
    verifyGoogleIdToken,
};