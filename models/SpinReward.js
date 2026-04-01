// models/SpinReward.js - UPDATED to prevent auto-deletion
const mongoose = require('mongoose');

const spinRewardSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  rewardType: {
    type: String,
    enum: ['cash', 'freeplay', 'deposit_bonus', 'vip_xp', 'retry'],
    required: true
  },
  rewardValue: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  rewardLabel: {
    type: String,
    required: true
  },
  segmentId: {
    type: Number,
    required: true
  },
  claimed: {
    type: Boolean,
    default: false
  },
  claimedAt: {
    type: Date,
    default: null
  },
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours from now
  },
  spinDate: {
    type: Date,
    default: Date.now,
    index: true
  },
  ipAddress: {
    type: String,
    required: false
  },
  userAgent: {
    type: String,
    required: false
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  adminNotes: {
    type: String,
    default: ''
  }
}, {
  timestamps: true
});

// Compound index for checking daily spins per user
spinRewardSchema.index({ userId: 1, spinDate: 1 });

// ❌ REMOVED TTL INDEX - This was auto-deleting old rewards
// spinRewardSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Static method to check if user can spin today
spinRewardSchema.statics.canUserSpinToday = async function(userId) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);
  
  const todaySpin = await this.findOne({
    userId,
    spinDate: {
      $gte: startOfDay,
      $lte: endOfDay
    }
  });
  
  return !todaySpin;
};

// Instance method to claim reward
spinRewardSchema.methods.claimReward = async function() {
  if (this.claimed) {
    throw new Error('Reward already claimed');
  }
  
  if (this.expiresAt < new Date()) {
    throw new Error('Reward has expired');
  }
  
  this.claimed = true;
  this.claimedAt = new Date();
  return await this.save();
};

const SpinReward = mongoose.model('SpinReward', spinRewardSchema);

module.exports = SpinReward;