// src/routes/auth.routes.js
const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { uploadProfile } = require('../middleware/upload');
const { authenticate } = require('../middleware/auth.middleware');

// ═══════════════════════════════════════════════════════════════════════
// REGISTRATION ROUTES
// ═══════════════════════════════════════════════════════════════════════

/**
 * Register Passenger with optional profile picture
 * POST /api/auth/signup/passenger
 * Content-Type: multipart/form-data
 * Fields: email, phone_e164, password, first_name, last_name, etc.
 * File: avatar (optional)
 */
router.post('/signup/passenger', uploadProfile.single('avatar'), authController.registerPassenger);

/**
 * Register Driver with multiple file uploads
 * POST /api/auth/signup/driver
 * Content-Type: multipart/form-data
 * Fields: email, phone_e164, password, first_name, last_name, license_number, cni_number, etc.
 * Files:
 *   - avatar (optional): Profile picture
 *   - license (required): Driver's license document
 *   - insurance (optional): Insurance document
 *   - vehicle_photo (optional): Vehicle photo
 *
 * NOTE: Multer middleware is handled inside the controller for multiple files
 */
router.post('/signup/driver', authController.registerDriver); // ✅ No multer here - handled in controller

// ═══════════════════════════════════════════════════════════════════════
// TOKEN REFRESH
// ═══════════════════════════════════════════════════════════════════════

/**
 * Refresh access token using refresh token
 * POST /api/auth/refresh
 * Body: { refresh_token: string }
 */
router.post('/refresh', authController.refreshToken);

// ═══════════════════════════════════════════════════════════════════════
// OTP ROUTES
// ═══════════════════════════════════════════════════════════════════════

/**
 * Send OTP to user for verification
 * POST /api/auth/otp/send
 * Body: { identifier: string, channel: 'EMAIL'|'SMS', purpose: string }
 */
router.post('/otp/send', authController.sendOtp);

/**
 * Verify OTP code
 * POST /api/auth/otp/verify
 * Body: { identifier: string, purpose: string, code: string }
 */
router.post('/otp/verify', authController.verifyOtp);

// ═══════════════════════════════════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════════════════════════════════

/**
 * Login with email/phone and password
 * POST /api/auth/login
 * Body: { identifier: string, password: string }
 */
router.post('/login', authController.login);

// ═══════════════════════════════════════════════════════════════════════
// PROFILE ROUTES (Protected)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Get current user profile
 * GET /api/auth/me
 * Headers: Authorization: Bearer <access_token>
 */
router.get('/me', authenticate, authController.getProfile);

/**
 * Update user avatar (profile picture)
 * PATCH /api/auth/me/avatar
 * Headers: Authorization: Bearer <access_token>
 * Content-Type: multipart/form-data
 * File: avatar (required)
 */
router.patch('/me/avatar', authenticate, uploadProfile.single('avatar'), authController.updateAvatar);

// ═══════════════════════════════════════════════════════════════════════
// LOGOUT
// ═══════════════════════════════════════════════════════════════════════

/**
 * Logout (client should delete tokens)
 * POST /api/auth/logout
 * Headers: Authorization: Bearer <access_token>
 */
router.post('/logout', authenticate, authController.logout);

module.exports = router;