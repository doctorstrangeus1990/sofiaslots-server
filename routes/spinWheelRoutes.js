// routes/spinWheelRoutes.js - FRONTEND FIRST APPROACH
const express = require('express');
const router = express.Router();
const spinWheelController = require('../controllers/spinWheelController');
const { spinLimit } = require('../middleware/spinRateLimit');
const authMiddleware = require('../middleware/authMiddleware');

// Apply authentication middleware to all routes
router.use(authMiddleware);

// USER ROUTES

// Get spin wheel configuration and user's spin status
router.get('/config', spinWheelController.getSpinConfig);

// Submit spin result from frontend (with rate limiting)
router.post('/spin', spinLimit, spinWheelController.spinWheel);

// Get user's spin history
router.get('/history', spinWheelController.getSpinHistory);

// Get user's pending rewards (for retry functionality)
router.get('/pending-rewards', spinWheelController.getPendingRewards);

// Note: No separate claim route needed - rewards are auto-processed in frontend-first approach
// Note: Admin routes are handled in separate adminSpinRoutes.js file

module.exports = router;