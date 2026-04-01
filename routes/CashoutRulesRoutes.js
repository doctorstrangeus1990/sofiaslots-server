// routes/cashoutRules.js
const express = require('express');
const router = express.Router();
const cashoutRuleController = require('../controllers/cashoutRuleController');
const authMiddleware = require('../middleware/authMiddleware');
const adminMiddleware = require('../middleware/adminMiddleware');

// Public routes (no authentication needed) - MUST come before middleware
/**
 * @route   GET /api/cashout-rules
 * @desc    Get all active cashout rules
 * @access  Public
 */
router.get('/', cashoutRuleController.getAllActiveRules);

/**
 * @route   GET /api/cashout-rules/check/:depositAmount
 * @desc    Get applicable rule for a specific deposit amount
 * @access  Public
 */
router.get('/check/:depositAmount', cashoutRuleController.getApplicableRule);

/**
 * @route   POST /api/cashout-rules/validate
 * @desc    Validate a cashout amount against rules
 * @access  Public
 */
router.post('/validate', cashoutRuleController.validateCashout);

// Apply authentication middleware to all admin routes below this point
router.use(authMiddleware);
router.use(adminMiddleware);

// Admin routes - protected by middleware above
/**
 * @route   POST /api/cashout-rules/admin
 * @desc    Create a new cashout rule
 * @access  Admin
 */
router.post('/admin', cashoutRuleController.createRule);

/**
 * @route   GET /api/cashout-rules/admin/all
 * @desc    Get all cashout rules (including inactive)
 * @access  Admin
 */
router.get('/admin/all', cashoutRuleController.getAllRules);

/**
 * @route   POST /api/cashout-rules/admin/initialize
 * @desc    Create default cashout rules
 * @access  Admin
 */
router.post('/admin/initialize', cashoutRuleController.createDefaultRules);

/**
 * @route   GET /api/cashout-rules/admin/:id
 * @desc    Get a specific cashout rule
 * @access  Admin
 */
router.get('/admin/:id', cashoutRuleController.getRuleById);

/**
 * @route   PUT /api/cashout-rules/admin/:id
 * @desc    Update a cashout rule
 * @access  Admin
 */
router.put('/admin/:id', cashoutRuleController.updateRule);

/**
 * @route   DELETE /api/cashout-rules/admin/:id
 * @desc    Delete a cashout rule
 * @access  Admin
 */
router.delete('/admin/:id', cashoutRuleController.deleteRule);

/**
 * @route   PATCH /api/cashout-rules/admin/:id/status
 * @desc    Toggle rule status (active/inactive)
 * @access  Admin
 */
router.patch('/admin/:id/status', cashoutRuleController.toggleStatus);

module.exports = router;