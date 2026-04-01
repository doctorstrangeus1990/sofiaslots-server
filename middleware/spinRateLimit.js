// middleware/spinRateLimit.js
const SpinReward = require('../models/SpinReward');
const Wallet = require('../models/Wallet');

// Custom rate limiting middleware for spin wheel
// Requirements:
// 1. Only 1 spin per day per user
// 2. Minimum $10 deposit in last 24 hours
const spinLimit = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }
    
    // CHECK 1: Check if user can spin today (already spun or not)
    const canSpin = await SpinReward.canUserSpinToday(userId);
    
    if (!canSpin) {
      return res.status(429).json({
        success: false,
        message: 'You can only spin once per day. Come back tomorrow!',
        code: 'ALREADY_SPUN_TODAY'
      });
    }
    
    // CHECK 2: Verify user has made at least $10 deposit in last 24 hours
    const wallet = await Wallet.findOne({ userId });
    
    if (!wallet) {
      return res.status(403).json({
        success: false,
        message: 'Wallet not found',
        code: 'NO_WALLET'
      });
    }
    
    // Get transactions from last 24 hours
    const last24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    // Sum completed deposits from last 24 hours
    const recentDeposits = wallet.transactions
      .filter(tx => 
        tx.type === 'deposit' && 
        tx.status === 'completed' && 
        new Date(tx.createdAt) >= last24Hours
      )
      .reduce((sum, tx) => sum + (tx.amount || 0), 0);
    
    console.log('Spin eligibility check:', {
      userId,
      recentDeposits,
      last24Hours: last24Hours.toISOString(),
      eligible: recentDeposits >= 10
    });
    
    if (recentDeposits < 10) {
      return res.status(403).json({
        success: false,
        message: `You need at least $10 in deposits within the last 24 hours to spin. Current: $${recentDeposits.toFixed(2)}`,
        code: 'INSUFFICIENT_DEPOSITS',
        data: {
          required: 10,
          current: recentDeposits,
          remaining: Math.max(0, 10 - recentDeposits)
        }
      });
    }
    
    // All checks passed - user can spin
    next();
    
  } catch (error) {
    console.error('Spin rate limit error:', error);
    res.status(500).json({
      success: false,
      message: 'Error checking spin availability'
    });
  }
};

module.exports = { spinLimit };