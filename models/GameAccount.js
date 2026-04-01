// models/GameAccount.js - UPDATED WITH BONUS TRACKING

const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['recharge', 'redeem', 'balance_check'],
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  previousBalance: Number,
  newBalance: Number,
  remark: String,
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'cancelled'],
    default: 'pending'
  },
  // ✅ Track if recharge was from bonus
  isBonus: {
    type: Boolean,
    default: false
  },
  // ✅ For bonus redeems, track the restricted amount
  bonusRestrictionAmount: {
    type: Number,
    default: 0
  },
  // ✅ Link to wallet transaction
  walletTransactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Wallet.transactions'
  },
  // ✅ Store metadata
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  processedAt: Date,
  completedAt: Date,
  createdAt: {
    type: Date,
    default: Date.now
  }
});

const gameAccountSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  gameId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Game',
    required: true
  },
  gameType: {
    type: String,
    required: false
  },
  gameLogin: {
    type: String,
    required: false,
    sparse: true
  },
  gamePassword: {
    type: String,
    required: false
  },
  balance: {
    type: Number,
    default: 0,
    min: 0
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'suspended', 'pending', 'failed'],
    default: 'pending'
  },
  downloadCode: {
    type: String,
    default: null
  },
  lastBalanceCheck: {
    type: Date,
    default: Date.now
  },
  transactions: [transactionSchema],
  metadata: {
    createdVia: {
      type: String,
      enum: ['manual', 'api', 'bulk'],
      default: 'api'
    },
    lastLoginAttempt: Date,
    failedLoginAttempts: {
      type: Number,
      default: 0
    },
    notes: String
  }
}, {
  timestamps: true
});

// Indexes
gameAccountSchema.index({ userId: 1, gameId: 1 });
gameAccountSchema.index({ gameLogin: 1 }, { 
  unique: true, 
  sparse: true
});
gameAccountSchema.index({ status: 1 });
gameAccountSchema.index({ gameId: 1, status: 1 });
gameAccountSchema.index({ 'transactions.type': 1 });
gameAccountSchema.index({ 'transactions.status': 1 });
gameAccountSchema.index({ 'transactions.isBonus': 1 });
gameAccountSchema.index({ 'transactions.createdAt': -1 });

// Virtual for account age
gameAccountSchema.virtual('accountAge').get(function() {
  return Date.now() - this.createdAt;
});

// ✅ PRIMARY METHOD: Get last deposit (used everywhere)
gameAccountSchema.methods.getLastDeposit = function() {
  const rechargeTransactions = this.transactions
    .filter(t => t.type === 'recharge' && t.status === 'completed')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  
  if (rechargeTransactions.length === 0) {
    return null;
  }
  
  const lastRecharge = rechargeTransactions[0];
  
  // ✅ Return complete object with ALL needed details
  return {
    amount: lastRecharge.amount,
    date: lastRecharge.createdAt,
    isBonus: lastRecharge.isBonus || false,
    transactionId: lastRecharge._id,
    walletTransactionId: lastRecharge.walletTransactionId,
    metadata: lastRecharge.metadata || {},
    remark: lastRecharge.remark
  };
};

// Instance methods
gameAccountSchema.methods.addTransaction = function(transactionData) {
  this.transactions.push(transactionData);
  return this.save();
};

gameAccountSchema.methods.updateBalance = function(newBalance, transactionId = null) {
  const previousBalance = this.balance;
  this.balance = newBalance;
  this.lastBalanceCheck = new Date();
    
  if (transactionId) {
    const transaction = this.transactions.id(transactionId);
    if (transaction) {
      transaction.previousBalance = previousBalance;
      transaction.newBalance = newBalance;
      transaction.status = 'completed';
      transaction.processedAt = new Date();
      transaction.completedAt = new Date();
    }
  }
    
  return this.save();
};

// Calculate total recharges
gameAccountSchema.methods.getTotalRecharges = function() {
  return this.transactions
    .filter(t => t.type === 'recharge' && t.status === 'completed')
    .reduce((sum, t) => sum + t.amount, 0);
};

// Calculate total redeems
gameAccountSchema.methods.getTotalRedeems = function() {
  return this.transactions
    .filter(t => t.type === 'redeem' && t.status === 'completed')
    .reduce((sum, t) => sum + t.amount, 0);
};

// ✅ Get all bonus deposits
gameAccountSchema.methods.getBonusDeposits = function() {
  return this.transactions
    .filter(t => t.type === 'recharge' && t.status === 'completed' && t.isBonus === true)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
};

// ✅ Get all regular deposits
gameAccountSchema.methods.getRegularDeposits = function() {
  return this.transactions
    .filter(t => t.type === 'recharge' && t.status === 'completed' && t.isBonus !== true)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
};

// Static methods
gameAccountSchema.statics.findByUser = function(userId, gameId = null) {
  const query = { userId };
  if (gameId) query.gameId = gameId;
  return this.find(query)
    .populate('userId', 'username email')
    .populate('gameId', 'name slug gameType status');
};

gameAccountSchema.statics.findByGameLogin = function(gameLogin) {
  return this.findOne({ gameLogin })
    .populate('userId', 'username email')
    .populate('gameId', 'name slug gameType status');
};

gameAccountSchema.statics.findByGame = function(gameId, status = null) {
  const query = { gameId };
  if (status) query.status = status;
  return this.find(query)
    .populate('userId', 'username email')
    .populate('gameId', 'name slug gameType status');
};

gameAccountSchema.statics.findActiveByGame = function(gameId) {
  return this.find({ gameId, status: 'active' })
    .populate('userId', 'username email')
    .populate('gameId', 'name slug gameType status');
};

// Pre-save middleware
gameAccountSchema.pre('save', async function(next) {
  if (this.isNew || this.isModified('gameId')) {
    try {
      const Game = mongoose.model('Game');
      const game = await Game.findById(this.gameId);
      if (game) {
        this.gameType = game.gameType;
      }
    } catch (error) {
      console.error('Error setting gameType:', error);
    }
  }
  next();
});

module.exports = mongoose.model('GameAccount', gameAccountSchema);