// routes/adminDataRoutes.js
const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const adminMiddleware = require('../middleware/adminMiddleware');
const adminDataController = require('../controllers/adminDataController');

const router = express.Router();

// Apply auth and admin middleware to all routes
router.use(authMiddleware);
router.use(adminMiddleware);

// ================================
// DASHBOARD & ANALYTICS
// ================================

// @route   GET /api/admin-data/stats
// @desc    Get dashboard statistics with recent users and transactions
// @access  Private/Admin
router.get('/stats', adminDataController.getStats);

// @route   GET /api/admin-data/chart-data
// @desc    Get chart data for deposits/withdrawals (today, week, month, custom)
// @access  Private/Admin
// @query   ?period=today|week|month|custom&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
router.get('/chart-data', adminDataController.getChartData);

// ================================
// USERS MANAGEMENT
// ================================

// @route   GET /api/admin-data/users
// @desc    Get users list with pagination and filters
// @access  Private/Admin
router.get('/users', adminDataController.getUsers);

// @route   GET /api/admin-data/users/:userId
// @desc    Get user details with transaction stats
// @access  Private/Admin
router.get('/users/:userId', adminDataController.getUserDetails);

// @route   PUT /api/admin-data/users/:userId/status
// @desc    Update user status (activate/suspend)
// @access  Private/Admin
router.put('/users/:userId/status', adminDataController.updateUserStatus);

// ================================
// ADMIN USER WALLET ACTIONS
// ================================

// @route   POST /api/admin-data/users/:userId/add-bonus
// @desc    Add bonus to user's bonus balance (admin action)
// @access  Private/Admin
// @body    { amount, description }
router.post('/users/:userId/add-bonus', adminDataController.addBonusToUser);

// @route   POST /api/admin-data/users/:userId/add-deposit
// @desc    Add deposit to user's regular balance (admin action)
// @access  Private/Admin
// @body    { amount, description }
router.post('/users/:userId/add-deposit', adminDataController.addDepositToUser);

// @route   POST /api/admin-data/users/:userId/redeem
// @desc    Redeem/deduct from user's balance (admin action)
// @access  Private/Admin
// @body    { amount, description, balanceType: 'regular' | 'bonus' }
router.post('/users/:userId/redeem', adminDataController.redeemFromUser);

// ================================
// TRANSACTIONS MANAGEMENT
// ================================

// @route   GET /api/admin-data/transactions
// @desc    Get transactions with advanced filtering
// @access  Private/Admin
// @query   ?page=1&limit=50&type=deposit|withdrawal&status=pending|completed|failed&paymentMethod=crypto|cashapp|chime&dateRange=lastWeek|lastMonth|lastYear|all
router.get('/transactions', adminDataController.getTransactions);

// @route   GET /api/admin-data/transactions/:transactionId
// @desc    Get single transaction details
// @access  Private/Admin
router.get('/transactions/:transactionId', adminDataController.getTransactionDetails);

// ================================
// WITHDRAWAL MANAGEMENT
// ================================

// @route   POST /api/admin-data/withdrawals/approve
// @desc    Approve/confirm withdrawal request
// @access  Private/Admin
// @body    { walletId, transactionId }
router.post('/withdrawals/approve', adminDataController.approveWithdrawal);

// @route   POST /api/admin-data/withdrawals/reject
// @desc    Reject withdrawal request and refund to user
// @access  Private/Admin
// @body    { walletId, transactionId, reason }
router.post('/withdrawals/reject', adminDataController.rejectWithdrawal);

// ================================
// DEPOSIT MANAGEMENT
// ================================

// @route   POST /api/admin-data/deposits/manual-complete
// @desc    Manually complete a pending deposit
// @access  Private/Admin
// @body    { walletId, transactionId, notes }
router.post('/deposits/manual-complete', adminDataController.manualCompleteDeposit);

// ================================
// GAMES & WALLET STATS
// ================================

// @route   GET /api/admin-data/games-stat
// @desc    Get games with player counts and revenue
// @access  Private/Admin
router.get('/games-stat', adminDataController.getGames);

// @route   GET /api/admin-data/wallet-stats
// @desc    Get wallet system statistics
// @access  Private/Admin
router.get('/wallet-stats', adminDataController.getWalletStats);

// ================================
// SETTINGS MANAGEMENT
// ================================

// @route   GET /api/admin-data/settings
// @desc    Get all settings
// @access  Private/Admin
router.get('/settings', adminDataController.getSettings);

// @route   PUT /api/admin-data/settings/signup-bonus
// @desc    Update signup bonus settings
// @access  Private/Admin
router.put('/settings/signup-bonus', adminDataController.updateSignupBonus);

// @route   PUT /api/admin-data/settings/first-deposit-bonus
// @desc    Update first deposit bonus settings
// @access  Private/Admin
router.put('/settings/first-deposit-bonus', adminDataController.updateFirstDepositBonus);

// @route   POST /api/admin-data/settings/promotional-bonus
// @desc    Create promotional bonus
// @access  Private/Admin
router.post('/settings/promotional-bonus', adminDataController.createPromotionalBonus);

// @route   PUT /api/admin-data/settings/promotional-bonus/:bonusId
// @desc    Update promotional bonus
// @access  Private/Admin
router.put('/settings/promotional-bonus/:bonusId', adminDataController.updatePromotionalBonus);

// @route   DELETE /api/admin-data/settings/promotional-bonus/:bonusId
// @desc    Delete promotional bonus
// @access  Private/Admin
router.delete('/settings/promotional-bonus/:bonusId', adminDataController.deletePromotionalBonus);

// @route   GET /api/admin-data/settings/promotional-bonus/active
// @desc    Get active promotional bonus
// @access  Private/Admin
router.get('/settings/promotional-bonus/active', adminDataController.getActivePromotionalBonus);

// @route   PUT /api/admin-data/settings/general
// @desc    Update general settings
// @access  Private/Admin
router.put('/settings/general', adminDataController.updateGeneralSettings);

// ================================
// ANNOUNCEMENTS MANAGEMENT
// ================================

// @route   POST /api/admin-data/announcements
// @desc    Create announcement
// @access  Private/Admin
router.post('/announcements', adminDataController.createAnnouncement);

// @route   PUT /api/admin-data/announcements/:announcementId
// @desc    Update announcement
// @access  Private/Admin
router.put('/announcements/:announcementId', adminDataController.updateAnnouncement);

// @route   DELETE /api/admin-data/announcements/:announcementId
// @desc    Delete announcement
// @access  Private/Admin
router.delete('/announcements/:announcementId', adminDataController.deleteAnnouncement);

// @route   GET /api/admin-data/announcements/active
// @desc    Get active announcements
// @access  Private/Admin
router.get('/announcements/active', adminDataController.getActiveAnnouncements);

// ================================
// DEBUG & UTILITY ROUTES
// ================================

// @route   GET /api/admin-data/user/:userId/wallet
// @desc    Get specific user's wallet (debug)
// @access  Private/Admin
router.get('/user/:userId/wallet', adminDataController.getUserWallet);

// @route   GET /api/admin-data/debug/users-with-wallets
// @desc    Debug: Get users with wallet structures
// @access  Private/Admin
router.get('/debug/users-with-wallets', adminDataController.getDebugUsersWithWallets);

module.exports = router;