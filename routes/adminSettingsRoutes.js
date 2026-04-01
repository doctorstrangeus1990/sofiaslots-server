// routes/adminSettingsRoutes.js
const express = require('express');
const router = express.Router();

// ✅ CORRECT MIDDLEWARE IMPORTS
const authMiddleware = require('../middleware/authMiddleware');
const adminMiddleware = require('../middleware/adminMiddleware');

// Import the settings controller functions from adminDataController
const {
  getSettings,
  updateSignupBonus,
  updateFirstDepositBonus,
  createPromotionalBonus,
  updatePromotionalBonus,
  deletePromotionalBonus,
  getActivePromotionalBonus,
  updateGeneralSettings,
  // ✅ NEW: Announcement functions
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  getActiveAnnouncements
} = require('../controllers/adminDataController');

// ================================
// PUBLIC ROUTES (No Authentication Required)
// ================================

// @route   GET /api/settings/active-bonus
// @desc    Get active promotional bonus (PUBLIC - for hero section)
// @access  Public
router.get('/active-bonus', getActivePromotionalBonus);

// @route   GET /api/settings/active-announcements
// @desc    Get active announcements (PUBLIC - for announcement modal)
// @access  Public
router.get('/active-announcements', getActiveAnnouncements);

// ================================
// APPLY MIDDLEWARE TO PROTECTED ROUTES ONLY
// ================================
router.use(authMiddleware);
router.use(adminMiddleware);

// ================================
// ADMIN BONUS SETTINGS ROUTES (All Protected)
// ================================

// @route   GET /api/admin/settings
// @desc    Get all settings (signup bonus, first deposit, promotional, announcements)
// @access  Private/Admin
router.get('/', getSettings);

// @route   PUT /api/admin/settings/signup-bonus
// @desc    Update signup bonus amount and status
// @access  Private/Admin
// @body    { amount: Number, enabled: Boolean }
router.put('/signup-bonus', updateSignupBonus);

// @route   PUT /api/admin/settings/first-deposit-bonus
// @desc    Update first deposit bonus settings
// @access  Private/Admin
// @body    { percentage: Number, minDeposit: Number, maxBonus: Number, enabled: Boolean }
router.put('/first-deposit-bonus', updateFirstDepositBonus);

// @route   POST /api/admin/settings/promotional-bonus
// @desc    Create new promotional campaign
// @access  Private/Admin
// @body    { title, description, bonusPercentage, bonusType, startDate, endDate, minDeposit, maxBonus, termsAndConditions, isVisible }
router.post('/promotional-bonus', createPromotionalBonus);

// @route   PUT /api/admin/settings/promotional-bonus/:bonusId
// @desc    Update existing promotional campaign
// @access  Private/Admin
// @body    { title, description, bonusPercentage, startDate, endDate, etc. }
router.put('/promotional-bonus/:bonusId', updatePromotionalBonus);

// @route   DELETE /api/admin/settings/promotional-bonus/:bonusId
// @desc    Delete promotional campaign
// @access  Private/Admin
router.delete('/promotional-bonus/:bonusId', deletePromotionalBonus);

// ================================
// ADMIN ANNOUNCEMENT ROUTES (All Protected)
// ================================

// @route   POST /api/admin/settings/announcement
// @desc    Create new announcement
// @access  Private/Admin
// @body    { title, description, icon, iconColor, tag, priority, isActive, startDate, endDate, targetUsers, clickAction }
router.post('/announcement', createAnnouncement);

// @route   PUT /api/admin/settings/announcement/:announcementId
// @desc    Update existing announcement
// @access  Private/Admin
// @body    { title, description, icon, iconColor, tag, priority, isActive, startDate, endDate, targetUsers, clickAction }
router.put('/announcement/:announcementId', updateAnnouncement);

// @route   DELETE /api/admin/settings/announcement/:announcementId
// @desc    Delete announcement
// @access  Private/Admin
router.delete('/announcement/:announcementId', deleteAnnouncement);

// ================================
// GENERAL SETTINGS
// ================================

// @route   PUT /api/admin/settings/general
// @desc    Update general settings
// @access  Private/Admin
// @body    { siteName, siteDescription, maintenanceMode, registrationEnabled, emailVerificationRequired }
router.put('/general', updateGeneralSettings);

module.exports = router;