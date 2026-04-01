// routes/referral.js
const express = require('express');
const router = express.Router();
const { body, param } = require('express-validator');
const referralController = require('../controllers/referralController');
const authMiddleware = require('../middleware/authMiddleware');

// Test route
router.get('/test', (req, res) => {
  res.json({ success: true, message: 'Referral routes working!' });
});

// Validation middleware
const validateReferralCode = [
  body('referralCode')
    .isLength({ min: 6, max: 12 })
    .withMessage('Referral code must be between 6 and 12 characters')
    .matches(/^[A-Z0-9]+$/)
    .withMessage('Referral code must contain only uppercase letters and numbers'),
  body('newUserId')
    .isMongoId()
    .withMessage('Valid user ID is required')
];

const validateReferralCodeParam = [
  param('code')
    .isLength({ min: 6, max: 12 })
    .withMessage('Referral code must be between 6 and 12 characters')
    .matches(/^[A-Z0-9]+$/i)
    .withMessage('Referral code must contain only letters and numbers')
];

// Public routes (no auth required)
router.get('/validate/:code', validateReferralCodeParam, referralController.validateReferralCode);
router.get('/leaderboard', referralController.getLeaderboard);

// Protected routes (auth required)
router.post('/generate', authMiddleware, referralController.generateReferralCode);
router.post('/apply', authMiddleware, validateReferralCode, referralController.applyReferralCode);
router.get('/stats', authMiddleware, referralController.getReferralStats);
router.get('/my-code', authMiddleware, referralController.getMyCode);

// Note: completeReferral route removed - referrals complete automatically on 5th deposit
// If you want to keep manual completion option, uncomment below:
// router.put('/:referralId/complete', 
//   authMiddleware,
//   param('referralId').isMongoId().withMessage('Valid referral ID is required'),
//   referralController.completeReferral
// );

module.exports = router;