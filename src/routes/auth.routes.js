// src/routes/auth.routes.js
const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { uploadProfile } = require('../middleware/upload'); // ← FIX: Changed from middleware to config
const { authenticate } = require('../middleware/auth.middleware');

// Registration with optional avatar
router.post('/signup/passenger', uploadProfile.single('avatar'), authController.registerPassenger);
router.post('/signup/driver', uploadProfile.single('avatar'), authController.registerDriver);

router.post('/refresh', authController.refreshToken);

// OTP routes
router.post('/otp/send', authController.sendOtp);
router.post('/otp/verify', authController.verifyOtp);

// Login
router.post('/login', authController.login);

// Profile routes
router.get('/me', authenticate, authController.getProfile);
router.patch('/me/avatar', authenticate, uploadProfile.single('avatar'), authController.updateAvatar); // ← NEW

// Logout
router.post('/logout', authenticate, authController.logout);

module.exports = router;