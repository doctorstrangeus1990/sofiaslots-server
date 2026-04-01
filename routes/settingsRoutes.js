// routes/settingsRoutes.js
const express = require('express');
const {
  getSettings,
  updateSettings,
  updateNotifications,
  updatePrivacy,
  updateSecurity,
  updateDisplay,
  updateGamePreferences,
  updateCommunication,
  updateResponsibleGaming,
  resetSettings,
  addTrustedDevice,
  removeTrustedDevice
} = require('../controllers/settingsController');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

// All routes require authentication
router.use(authMiddleware);

// @route   GET /api/settings
// @desc    Get user settings
// @access  Private
router.get('/', getSettings);

// @route   PUT /api/settings
// @desc    Update all settings
// @access  Private
router.put('/', updateSettings);

// @route   PUT /api/settings/notifications
// @desc    Update notification preferences
// @access  Private
router.put('/notifications', updateNotifications);

// @route   PUT /api/settings/privacy
// @desc    Update privacy settings
// @access  Private
router.put('/privacy', updatePrivacy);

// @route   PUT /api/settings/security
// @desc    Update security settings
// @access  Private
router.put('/security', updateSecurity);

// @route   PUT /api/settings/display
// @desc    Update display preferences
// @access  Private
router.put('/display', updateDisplay);

// @route   PUT /api/settings/game
// @desc    Update game preferences
// @access  Private
router.put('/game', updateGamePreferences);

// @route   PUT /api/settings/communication
// @desc    Update communication preferences
// @access  Private
router.put('/communication', updateCommunication);

// @route   PUT /api/settings/responsible-gaming
// @desc    Update responsible gaming settings
// @access  Private
router.put('/responsible-gaming', updateResponsibleGaming);

// @route   POST /api/settings/reset
// @desc    Reset settings to default
// @access  Private
router.post('/reset', resetSettings);

// @route   POST /api/settings/trusted-devices
// @desc    Add trusted device
// @access  Private
router.post('/trusted-devices', addTrustedDevice);

// @route   DELETE /api/settings/trusted-devices/:deviceId
// @desc    Remove trusted device
// @access  Private
router.delete('/trusted-devices/:deviceId', removeTrustedDevice);

module.exports = router;