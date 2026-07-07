// src/controllers/passwordReset.controller.js
//
// ═══════════════════════════════════════════════════════════════════════════
// FORGOT / RESET PASSWORD
// ═══════════════════════════════════════════════════════════════════════════
// Three steps, reusing the existing OTP infrastructure (otp.service +
// verification_codes, purpose = 'PASSWORD_RESET'):
//
//   POST /api/auth/forgot-password        { identifier }
//        → sends a reset code by email or SMS. Never reveals whether the
//          account exists (anti-enumeration): always returns a generic success.
//
//   POST /api/auth/reset-password/verify  { identifier, code }
//        → checks the code is valid WITHOUT consuming it (so the mobile OTP
//          screen can validate before showing the new-password screen).
//
//   POST /api/auth/reset-password         { identifier, code, newPassword }
//        → verifies + consumes the code, sets the new password (strength rules),
//          and fires an ACCOUNT_PASSWORD_CHANGED security notification.
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

const bcrypt = require('bcrypt');
const { Op } = require('sequelize');
const { VerificationCode, Account } = require('../models');
const { sendOtpByIdentifier } = require('../services/otp.service');
const NotificationService = require('../services/NotificationService');

const ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);

const channelOf = (identifier) => (String(identifier).includes('@') ? 'EMAIL' : 'SMS');

function passwordErrors(pw) {
    const e = [];
    if (!pw || pw.length < 8) e.push('at least 8 characters');
    if (!/[a-z]/.test(pw))    e.push('a lowercase letter');
    if (!/[A-Z]/.test(pw))    e.push('an uppercase letter');
    if (!/[0-9]/.test(pw))    e.push('a number');
    if (!/[!@#$%^&*(),.?":{}|<>]/.test(pw)) e.push('a special character');
    return e;
}

// Newest still-valid reset code for this identifier.
function findResetCode(identifier) {
    return VerificationCode.findOne({
        where: {
            purpose:     'PASSWORD_RESET',
            channel:     channelOf(identifier),
            target:      identifier,
            consumed_at: { [Op.is]: null },
            expires_at:  { [Op.gt]: new Date() },
        },
        order: [['createdAt', 'DESC']],
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/forgot-password
// ─────────────────────────────────────────────────────────────────────────────
exports.forgotPassword = async (req, res) => {
    try {
        const identifier = String(req.body.identifier || '').trim();
        if (!identifier) {
            return res.status(400).json({ success: false, message: 'Please provide your email or phone number.' });
        }

        const channel = channelOf(identifier);

        try {
            await sendOtpByIdentifier({ identifier, channel, purpose: 'PASSWORD_RESET' });
        } catch (err) {
            // Anti-enumeration: an unknown account must look identical to a known one.
            if (err.code === 'ACCOUNT_NOT_FOUND') {
                console.log('ℹ️  [FORGOT-PW] Unknown identifier — returning generic success');
            } else if (err.code === 'SMS_SEND_FAILED' || err.code === 'EMAIL_SEND_FAILED') {
                return res.status(503).json({ success: false, message: 'Could not send the code right now. Please try again shortly.' });
            } else {
                throw err;
            }
        }

        return res.status(200).json({
            success: true,
            message: `If an account exists, a reset code has been sent by ${channel === 'EMAIL' ? 'email' : 'SMS'}.`,
            channel,
        });
    } catch (e) {
        console.error('❌ [FORGOT-PW] error:', e.message);
        return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/reset-password/verify  — validate the code, do NOT consume
// ─────────────────────────────────────────────────────────────────────────────
exports.verifyResetOtp = async (req, res) => {
    try {
        const identifier = String(req.body.identifier || '').trim();
        const code = String(req.body.code || '').trim();
        if (!identifier || !code) {
            return res.status(400).json({ success: false, message: 'Identifier and code are required.' });
        }

        const vc = await findResetCode(identifier);
        if (!vc) return res.status(400).json({ success: false, message: 'This code has expired. Please request a new one.', code: 'OTP_EXPIRED' });
        if (vc.attempts >= vc.max_attempts) return res.status(429).json({ success: false, message: 'Too many attempts. Please request a new code.', code: 'TOO_MANY_ATTEMPTS' });

        const ok = await bcrypt.compare(code, vc.code_hash);
        await vc.update({ attempts: vc.attempts + 1 });
        if (!ok) return res.status(400).json({ success: false, message: 'Invalid code. Please try again.', code: 'INVALID_OTP' });

        return res.status(200).json({ success: true, message: 'Code verified.' });
    } catch (e) {
        console.error('❌ [RESET-VERIFY] error:', e.message);
        return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/reset-password  — verify + consume + set new password
// ─────────────────────────────────────────────────────────────────────────────
exports.resetPassword = async (req, res) => {
    try {
        const identifier = String(req.body.identifier || '').trim();
        const code = String(req.body.code || '').trim();
        const { newPassword } = req.body;

        if (!identifier || !code || !newPassword) {
            return res.status(400).json({ success: false, message: 'Identifier, code and new password are required.' });
        }
        const errs = passwordErrors(newPassword);
        if (errs.length) {
            return res.status(400).json({ success: false, message: `Password must contain ${errs.join(', ')}.`, errors: errs });
        }

        const vc = await findResetCode(identifier);
        if (!vc) return res.status(400).json({ success: false, message: 'This code has expired. Please request a new one.', code: 'OTP_EXPIRED' });
        if (vc.attempts >= vc.max_attempts) return res.status(429).json({ success: false, message: 'Too many attempts. Please request a new code.', code: 'TOO_MANY_ATTEMPTS' });

        const ok = await bcrypt.compare(code, vc.code_hash);
        await vc.update({ attempts: vc.attempts + 1 });
        if (!ok) return res.status(400).json({ success: false, message: 'Invalid code. Please try again.', code: 'INVALID_OTP' });

        const account = await Account.findOne({
            where: channelOf(identifier) === 'EMAIL' ? { email: identifier } : { phone_e164: identifier },
        });
        if (!account) {
            await vc.update({ consumed_at: new Date() });
            return res.status(404).json({ success: false, message: 'Account not found.' });
        }

        account.password_hash = await bcrypt.hash(String(newPassword), ROUNDS);
        account.password_algo = 'bcrypt';
        await account.save();
        await vc.update({ consumed_at: new Date() });

        console.log(`✅ [RESET-PW] Password reset for account ${account.uuid}`);

        // ── 🔔 SECURITY NOTIFICATION ──────────────────────────────────────────
        try {
            NotificationService.send({
                accountUuid: account.uuid,
                type:        'ACCOUNT_PASSWORD_CHANGED',
                title:       'Mot de passe réinitialisé',
                body:        "Votre mot de passe a été réinitialisé. Si ce n'est pas vous, contactez le support immédiatement.",
                data:        { screen: 'security' },
            });
        } catch (_) { /* never block */ }

        return res.status(200).json({ success: true, message: 'Your password has been reset. You can now log in with your new password.' });
    } catch (e) {
        console.error('❌ [RESET-PW] error:', e.message);
        return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
    }
};
