// routes/userRoutes.js
const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

// All routes require authentication
router.use(authMiddleware);

// ============================================
// IMPORT CONTROLLERS
// ============================================

// Auth controller for profile routes
const {
  getCurrentUser,
  updateProfile,
  changePassword
} = require('../controllers/authController');

// Wallet controller for wallet routes
const walletController = require('../controllers/walletController');

// ============================================
// PROFILE ROUTES (for frontend compatibility)
// ============================================

// @route   GET /api/user/profile
// @desc    Get current user profile
// @access  Private
router.get('/profile', getCurrentUser);

// @route   PUT /api/user/profile
// @desc    Update user profile
// @access  Private
router.put('/profile', updateProfile);

// @route   PUT /api/user/change-password
// @desc    Change user password
// @access  Private
router.put('/change-password', changePassword);

// ============================================
// WALLET ROUTES
// ============================================

// @route   GET /api/user/wallet
// @desc    Get user wallet balance
// @access  Private
router.get('/wallet', walletController.getWalletBalance);

// @route   GET /api/user/wallet/transactions
// @desc    Get wallet transaction history
// @access  Private
router.get('/wallet/transactions', walletController.getTransactionHistory);

// ============================================
// DEPOSIT ROUTES
// ============================================

// @route   POST /api/user/deposit
// @desc    Create a new deposit request
// @access  Private
router.post('/deposit', walletController.depositFunds);

// @route   GET /api/user/deposits
// @desc    Get user's deposit history
// @access  Private
router.get('/deposits', (req, res) => {
  // Filter transaction history for deposits only
  req.query.type = 'deposit';
  walletController.getTransactionHistory(req, res);
});

// ============================================
// WITHDRAWAL ROUTES
// ============================================

// @route   POST /api/user/withdrawal
// @desc    Create a new withdrawal request
// @access  Private
router.post('/withdrawal', walletController.withdrawFunds);

// @route   GET /api/user/withdrawals
// @desc    Get user's withdrawal history
// @access  Private
router.get('/withdrawals', (req, res) => {
  // Filter transaction history for withdrawals only
  req.query.type = 'withdrawal';
  walletController.getTransactionHistory(req, res);
});

// ============================================
// GAME TRANSFER ROUTES
// ============================================

// // @route   POST /api/user/transfer-to-game
// // @desc    Transfer funds to game account
// // @access  Private
// router.post('/transfer-to-game', walletController.transferToGame);

// // @route   POST /api/user/transfer-from-game
// // @desc    Transfer funds from game account
// // @access  Private
// router.post('/transfer-from-game', walletController.transferFromGame);

// ============================================
// ADDITIONAL USER ROUTES (if needed)
// ============================================

// @route   GET /api/user/stats
// @desc    Get user statistics
// @access  Private
// router.get('/stats', getUserStats);

// @route   GET /api/user/activity
// @desc    Get user activity log
// @access  Private
// router.get('/activity', getUserActivity);

// @route   GET /api/user/referrals
// @desc    Get user's referral information
// @access  Private
// router.get('/referrals', getUserReferrals);

module.exports = router;