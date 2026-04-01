// models/Referral.js - UPDATED FOR 10% + 5% LIFETIME (Compatible with old data)
const mongoose = require('mongoose');

const referralSchema = new mongoose.Schema({
  referrerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  referredUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false,
    index: true,
    default: null
  },
  referralCode: {
    type: String,
    required: true,
    uppercase: true,
    index: true
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'cancelled', 'active'], // ✅ Added 'active'
    default: 'pending' // Keep default for compatibility
  },
  rewards: {
    referrerReward: {
      type: Number,
      default: 0
    },
    referredReward: {
      type: Number,
      default: 0 // ✅ Changed from 5 to 0 (no signup bonus)
    },
    rewardType: {
      type: String,
      enum: ['cash', 'bonus', 'free_spins', 'percentage'],
      default: 'percentage'
    }
  },
  conditions: {
    minDeposit: {
      type: Number,
      default: 10
    },
    minGamesPlayed: {
      type: Number,
      default: 0 // ✅ Changed from 1 to 0
    },
    maxRewardDeposits: {
      type: Number,
      default: 5 // First 5 deposits at 10%
    },
    lifetimeRewardRate: { // ✅ NEW: After 5th deposit
      type: Number,
      default: 5 // 5% on all deposits after the 5th
    },
    completedAt: {
      type: Date,
      default: null
    }
  },
  metadata: {
    referredUserIP: String,
    referredUserAgent: String,
    referralSource: String,
    campaignId: String,
    depositCount: {
      type: Number,
      default: 0
    },
    totalReferralEarnings: {
      type: Number,
      default: 0
    },
    highRewardEarnings: { // ✅ NEW: Track 10% earnings
      type: Number,
      default: 0
    },
    lifetimeEarnings: { // ✅ NEW: Track 5% earnings
      type: Number,
      default: 0
    }
  },
  completedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Compound indexes for better query performance
referralSchema.index({ referrerId: 1, status: 1 });
referralSchema.index({ referredUserId: 1, status: 1 });
referralSchema.index({ referralCode: 1, status: 1 });
referralSchema.index({ referralCode: 1, referredUserId: 1 }, { unique: true, sparse: true });
referralSchema.index({ createdAt: -1 });

// Virtual for calculating referral completion rate
referralSchema.virtual('isCompleted').get(function() {
  return this.status === 'completed';
});

// Static method to generate unique referral code
referralSchema.statics.generateReferralCode = function(username) {
  const randomString = Math.random().toString(36).substring(2, 8).toUpperCase();
  const userPrefix = username.substring(0, 3).toUpperCase();
  return `${userPrefix}${randomString}`;
};

// Static method to find or create referral code for a user
referralSchema.statics.findOrCreateReferralCode = async function(userId, username) {
  // Check if user already has a referral code
  let referral = await this.findOne({
    referrerId: userId,
    referredUserId: null // Template referral
  });

  if (referral) {
    return referral.referralCode;
  }

  // Generate new unique code
  let referralCode;
  let isUnique = false;
  let attempts = 0;
  const maxAttempts = 10;

  while (!isUnique && attempts < maxAttempts) {
    referralCode = this.generateReferralCode(username);
    const existing = await this.findOne({ 
      referralCode,
      referredUserId: null 
    });
    if (!existing) {
      isUnique = true;
    }
    attempts++;
  }

  if (!isUnique) {
    throw new Error('Unable to generate unique referral code');
  }

  // Create template referral
  await this.create({
    referrerId: userId,
    referredUserId: null,
    referralCode,
    status: 'pending', // Keep 'pending' for templates
    rewards: {
      referrerReward: 0,
      referredReward: 0, // ✅ No signup bonus
      rewardType: 'percentage'
    },
    conditions: {
      minDeposit: 10,
      minGamesPlayed: 0,
      maxRewardDeposits: 5,
      lifetimeRewardRate: 5 // ✅ NEW
    },
    metadata: {
      depositCount: 0,
      totalReferralEarnings: 0,
      highRewardEarnings: 0, // ✅ NEW
      lifetimeEarnings: 0 // ✅ NEW
    }
  });

  return referralCode;
};

// ✅ UPDATED: Process deposit with 10% (first 5) + 5% (lifetime) logic
referralSchema.methods.processDeposit = async function(depositAmount) {
  if (this.status === 'cancelled') {
    return { success: false, message: 'Referral cancelled' };
  }

  if (!this.referredUserId) {
    return { success: false, message: 'No referred user' };
  }

  const depositCount = this.metadata?.depositCount || 0;
  const maxHighRewards = this.conditions?.maxRewardDeposits || 5;
  const lifetimeRate = this.conditions?.lifetimeRewardRate || 5;

  const minDeposit = this.conditions?.minDeposit || 10;
  if (depositAmount < minDeposit) {
    return { success: false, message: `Deposit amount below minimum ($${minDeposit})` };
  }

  // ✅ CALCULATE REWARD: 10% for first 5, then 5% forever
  let rewardAmount = 0;
  let rewardType = '';
  
  if (depositCount < maxHighRewards) {
    // First 5 deposits: 10%
    rewardAmount = depositAmount * 0.10;
    rewardType = 'high_reward';
    this.metadata.highRewardEarnings = (this.metadata.highRewardEarnings || 0) + rewardAmount;
  } else {
    // After 5th deposit: 5% lifetime
    rewardAmount = depositAmount * (lifetimeRate / 100);
    rewardType = 'lifetime_reward';
    this.metadata.lifetimeEarnings = (this.metadata.lifetimeEarnings || 0) + rewardAmount;
  }

  // Update metadata
  this.metadata.depositCount = depositCount + 1;
  this.metadata.totalReferralEarnings = (this.metadata.totalReferralEarnings || 0) + rewardAmount;

  // ✅ NEVER mark as "completed" - it's lifetime now!
  // Keep status as 'pending' or 'active' forever

  await this.save();

  return {
    success: true,
    rewardAmount,
    rewardType,
    depositNumber: this.metadata.depositCount,
    totalEarnings: this.metadata.totalReferralEarnings,
    highRewardEarnings: this.metadata.highRewardEarnings,
    lifetimeEarnings: this.metadata.lifetimeEarnings,
    isLifetime: depositCount >= maxHighRewards
  };
};

// ✅ REMOVED auto-completion logic since referrals are lifetime now
referralSchema.pre('save', async function(next) {
  // Don't auto-complete anymore - referrals are lifetime
  next();
});

module.exports = mongoose.model('Referral', referralSchema);