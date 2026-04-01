// routes/adminSpinRoutes.js
const express = require('express');
const router = express.Router();
const adminSpinController = require('../controllers/adminSpinWheelController');

// ✅ IMPORTANT: Import BOTH middlewares like in adminSettingsRoutes
const authMiddleware = require('../middleware/authMiddleware');
const adminMiddleware = require('../middleware/adminMiddleware');

// ✅ Apply BOTH middlewares in the correct order
router.use(authMiddleware);      // First: Authenticate user
router.use(adminMiddleware);     // Second: Check if user is admin

// SPIN REWARDS CRUD
router.get('/rewards', adminSpinController.getAllSpinRewards);
router.get('/rewards/:rewardId', adminSpinController.getSpinReward);
router.put('/rewards/:rewardId/status', adminSpinController.updateRewardStatus);
router.delete('/rewards/:rewardId', adminSpinController.deleteSpinReward);

// SPIN CONFIGURATION CRUD
router.get('/config', adminSpinController.getSpinConfig);
router.put('/config', adminSpinController.updateSpinConfig);
router.put('/settings', adminSpinController.updateGlobalSettings);

// ANALYTICS & REPORTS
router.get('/analytics', adminSpinController.getSpinAnalytics);
router.get('/reports', adminSpinController.getDetailedReports);
router.get('/export', adminSpinController.exportSpinData);

// USER MANAGEMENT
router.get('/users', adminSpinController.getUsersWithSpins);
router.get('/users/:userId/spins', adminSpinController.getUserSpinHistory);
router.post('/users/:userId/reset-spin', adminSpinController.resetUserSpin);

module.exports = router;