// routes/authRoutes.js
const express = require('express');
const {
  sendOTP,
  verifyOTP,
  resetPassword,   // ✅ NEW
  register,
  login,
  changePassword,
  changePin,
  getCurrentUser,
  updateProfile
} = require('../controllers/authController');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

// ========================================
// OTP ROUTES
// ========================================
router.post('/send-otp', sendOTP);
router.post('/verify-otp', verifyOTP);

// ========================================
// PASSWORD RESET (public — no auth needed)
// ========================================

// Step 1: POST /api/auth/send-otp          { email, purpose: "password_reset" }
// Step 2: POST /api/auth/verify-otp        { email, otp, purpose: "password_reset" }
// Step 3: POST /api/auth/reset-password    { email, otp, newPassword }
router.post('/reset-password', resetPassword);  // ✅ NEW

// ========================================
// AUTH ROUTES
// ========================================
router.post('/register', register);
router.post('/login', login);

// ========================================
// PROTECTED ROUTES
// ========================================
router.get('/me', authMiddleware, getCurrentUser);
router.put('/profile', authMiddleware, updateProfile);
router.put('/change-password', authMiddleware, changePassword);
router.put('/change-pin', authMiddleware, changePin);

module.exports = router;