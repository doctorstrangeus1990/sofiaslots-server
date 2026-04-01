// routes/walletRoutes.js - UPDATED WITH BONUS SUPPORT
const express = require('express');
const {
    getWallet,
    getWalletBalance,
    addBonus, // ✅ NEW - Add bonus endpoint
    depositFunds,
    withdrawFunds,
    transferToGame,
    transferFromGame,
    getTransactionHistory,
    getTransaction,
    updateWalletSettings,
    getRecentWinners
} = require('../controllers/walletController');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

// ✅ PUBLIC ROUTE - No authentication needed for winners display
// @route   GET /api/wallet/recent-winners
// @desc    Get recent game winners (last 10)
// @access  Public
router.get('/recent-winners', getRecentWinners);

// All wallet routes require authentication
router.use(authMiddleware);

// @route   GET /api/wallet
// @desc    Get user's complete wallet information (including bonus balance)
// @access  Private
router.get('/', getWallet);

// @route   GET /api/wallet/balance
// @desc    Get wallet balance only (for header, includes bonus balance)
// @access  Private
router.get('/balance', getWalletBalance);

// ✅ NEW ROUTE
// @route   POST /api/wallet/bonus
// @desc    Add bonus to user's wallet (Admin only - add admin middleware if needed)
// @access  Private (Admin)
router.post('/bonus', addBonus);

// @route   POST /api/wallet/deposit
// @desc    Add funds to wallet
// @access  Private
router.post('/deposit', depositFunds);

// @route   POST /api/wallet/withdraw
// @desc    Withdraw funds from wallet (only regular balance, not bonus)
// @access  Private
router.post('/withdraw', withdrawFunds);

// // @route   POST /api/wallet/transfer-to-game
// // @desc    Transfer funds from wallet to game account (supports bonus balance with useBonus flag)
// // @access  Private
// router.post('/transfer-to-game', transferToGame);

// // @route   POST /api/wallet/transfer-from-game
// // @desc    Transfer funds from game account to wallet (applies 10% rule for bonus deposits)
// // @access  Private
// router.post('/transfer-from-game', transferFromGame);

// @route   GET /api/wallet/transactions
// @desc    Get transaction history with pagination and filters (includes bonus transactions)
// @access  Private
router.get('/transactions', getTransactionHistory);

// @route   GET /api/wallet/transactions/:transactionId
// @desc    Get single transaction details
// @access  Private
router.get('/transactions/:transactionId', getTransaction);

// @route   PUT /api/wallet/settings
// @desc    Update wallet settings (withdrawal limits)
// @access  Private
router.put('/settings', updateWalletSettings);

module.exports = router;