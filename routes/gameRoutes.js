// routes/gameRoutes.js
const express = require('express');
const {
  getAllGames,
  getGameBySlug,
  getUserGameAccounts,
  createGameAccount,
  getAccountBalance,
  rechargeAccount,
  redeemFromAccount,
  getDownloadCode,
  getAccountTransactions,
  resetAccountPassword,
  deactivateAccount,
  startGameSession,
  getAccountSummary,
  refreshAccountBalance,
  getCashoutInfo
} = require('../gmcontrollers/gameController');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

// @route   GET /api/games
// @desc    Get all available games
// @access  Public
router.get('/', getAllGames);

// @route   GET /api/games/:slug
// @desc    Get single game by slug
// @access  Public
router.get('/:slug', getGameBySlug);

// @route   GET /api/games/accounts/my-accounts
// @desc    Get user's game accounts
// @access  Private
router.get('/accounts/my-accounts', authMiddleware, getUserGameAccounts);

// @route   POST /api/games/:slug/accounts/create
// @desc    Create new game account for specific game
// @access  Private
router.post('/:slug/accounts/create', authMiddleware, createGameAccount);

// @route   GET /api/games/:slug/accounts/:accountId/balance
// @desc    Get account balance
// @access  Private
router.get('/:slug/accounts/:accountId/balance', authMiddleware, getAccountBalance);

// @route   POST /api/games/:slug/accounts/:accountId/recharge
// @desc    Recharge game account
// @access  Private
router.post('/:slug/accounts/:accountId/recharge', authMiddleware, rechargeAccount);

// @route   POST /api/games/:slug/accounts/:accountId/redeem
// @desc    Redeem from game account
// @access  Private
router.post('/:slug/accounts/:accountId/redeem', authMiddleware, redeemFromAccount);

// @route   GET /api/games/:slug/accounts/:accountId/download-code
// @desc    Get download code for game account
// @access  Private
router.get('/:slug/accounts/:accountId/download-code', authMiddleware, getDownloadCode);

// @route   GET /api/games/:slug/accounts/:accountId/transactions
// @desc    Get account transaction history
// @access  Private
router.get('/:slug/accounts/:accountId/transactions', authMiddleware, getAccountTransactions);

// @route   POST /api/games/:slug/accounts/:accountId/reset-password
// @desc    Reset game account password
// @access  Private
router.post('/:slug/accounts/:accountId/reset-password', authMiddleware, resetAccountPassword);

// @route   DELETE /api/games/:slug/accounts/:accountId
// @desc    Delete/deactivate game account
// @access  Private
router.delete('/:slug/accounts/:accountId', authMiddleware, deactivateAccount);

// @route   POST /api/games/:slug/play
// @desc    Start playing a game
// @access  Private
router.post('/:slug/play', authMiddleware, startGameSession);

// @route   GET /api/games/:slug/accounts/:accountId/summary
// @desc    Get account summary
// @access  Private
router.get('/:slug/accounts/:accountId/summary', authMiddleware, getAccountSummary);

// @route   POST /api/games/:slug/accounts/:accountId/refresh-balance
// @desc    Force refresh account balance
// @access  Private
router.post('/:slug/accounts/:accountId/refresh-balance', authMiddleware, refreshAccountBalance);

// @route   GET /api/games/:slug/accounts/:accountId/cashout-info
// @desc    Get cashout information (last deposit and applicable rules)
// @access  Private
router.get('/:slug/accounts/:accountId/cashout-info', authMiddleware, getCashoutInfo);

module.exports = router;