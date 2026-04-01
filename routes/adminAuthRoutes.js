// routes/adminAuthRoutes.js
const express = require('express');
const {
  adminLogin,
  createAdmin,
  getAdminProfile,
  changeAdminPassword,
  updateAdminProfile
} = require('../controllers/adminAuthController');
const authMiddleware = require('../middleware/authMiddleware');
const adminMiddleware = require('../middleware/adminMiddleware'); // ✅ Import the middleware

const router = express.Router();

// @route   POST /api/admin/login
// @desc    Admin/Staff login
// @access  Public
router.post('/login', adminLogin);

// @route   POST /api/admin/create-admin
// @desc    Create new admin/staff user
// @access  Private (Admin and Staff)
router.post('/create-admin', authMiddleware, adminMiddleware, createAdmin);

// @route   GET /api/admin/profile
// @desc    Get admin/staff profile
// @access  Private (Admin and Staff)
router.get('/profile', authMiddleware, adminMiddleware, getAdminProfile);

// @route   PUT /api/admin/profile
// @desc    Update admin/staff profile
// @access  Private (Admin and Staff)
router.put('/profile', authMiddleware, adminMiddleware, updateAdminProfile);

// @route   PUT /api/admin/change-password
// @desc    Change admin/staff password
// @access  Private (Admin and Staff)
router.put('/change-password', authMiddleware, adminMiddleware, changeAdminPassword);

module.exports = router;