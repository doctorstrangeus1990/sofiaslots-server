const express = require('express');
const publicController = require('../controllers/publicController');
const { getActivePromotionalBonus } = require('../controllers/adminDataController');

const router = express.Router();

// Public routes (no authentication required)
router.get('/games', publicController.getPublicGames);
router.get('/stats', publicController.getPlatformStats);

// @route   GET /api/public/active-bonus
// @desc    Get active promotional bonus and settings for hero section
// @access  Public
router.get('/active-bonus', getActivePromotionalBonus);

module.exports = router;