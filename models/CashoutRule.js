// models/CashoutRule.js
const mongoose = require('mongoose');

const cashoutRuleSchema = new mongoose.Schema({
  // Deposit range that this rule applies to
  depositRange: {
    min: {
      type: Number,
      required: true,
      min: 0
    },
    max: {
      type: Number,
      required: true,
      validate: {
        validator: function(value) {
          return value > this.depositRange.min;
        },
        message: 'Max deposit must be greater than min deposit'
      }
    }
  },
  
  // Cashout limits (actual dollar amounts, not percentages)
  cashoutLimits: {
    min: {
      type: Number,
      required: true,
      min: 0
    },
    max: {
      type: Number,
      required: true,
      validate: {
        validator: function(value) {
          return value >= this.cashoutLimits.min;
        },
        message: 'Max cashout must be greater than or equal to min cashout'
      }
    }
  },
  
  // Rule status
  status: {
    type: String,
    enum: ['active', 'inactive'],
    default: 'active'
  },
  
  // Optional description
  description: {
    type: String,
    trim: true
  },
  
  // Statistics
  stats: {
    timesApplied: {
      type: Number,
      default: 0
    },
    totalCashedOut: {
      type: Number,
      default: 0
    },
    lastApplied: {
      type: Date,
      default: null
    }
  }
}, {
  timestamps: true
});

// Indexes
cashoutRuleSchema.index({ status: 1 });
cashoutRuleSchema.index({ 'depositRange.min': 1, 'depositRange.max': 1 });

// Instance Methods

// Check if rule applies to a specific deposit amount
cashoutRuleSchema.methods.appliesTo = function(depositAmount) {
  return depositAmount >= this.depositRange.min && 
         depositAmount <= this.depositRange.max;
};

// Get cashout limits for display
cashoutRuleSchema.methods.getLimits = function() {
  return {
    deposit: `${this.depositRange.min}-${this.depositRange.max}`,
    cashout: `${this.cashoutLimits.min}-${this.cashoutLimits.max}`,
    minCashout: this.cashoutLimits.min,
    maxCashout: this.cashoutLimits.max
  };
};

// Validate a cashout amount
cashoutRuleSchema.methods.validateCashout = function(cashoutAmount) {
  const isValid = cashoutAmount >= this.cashoutLimits.min && 
                  cashoutAmount <= this.cashoutLimits.max;
  
  return {
    valid: isValid,
    min: this.cashoutLimits.min,
    max: this.cashoutLimits.max,
    reason: !isValid 
      ? cashoutAmount < this.cashoutLimits.min
        ? `Minimum cashout is $${this.cashoutLimits.min}`
        : `Maximum cashout is $${this.cashoutLimits.max}`
      : 'Valid'
  };
};

// Update statistics
cashoutRuleSchema.methods.recordCashout = function(amount) {
  this.stats.timesApplied += 1;
  this.stats.totalCashedOut += amount;
  this.stats.lastApplied = new Date();
  return this.save();
};

// Static Methods

// Find applicable rule for a deposit amount
cashoutRuleSchema.statics.findApplicableRule = async function(depositAmount) {
  return await this.findOne({
    status: 'active',
    'depositRange.min': { $lte: depositAmount },
    'depositRange.max': { $gte: depositAmount }
  });
};

// Get all active rules sorted by deposit range
cashoutRuleSchema.statics.getActiveRules = function() {
  return this.find({ status: 'active' })
    .sort({ 'depositRange.min': 1 });
};

// Create default rules matching your frontend
cashoutRuleSchema.statics.createDefaultRules = async function() {
  const defaultRules = [
    {
      depositRange: { min: 10, max: 20 },
      cashoutLimits: { min: 8, max: 30 },
      description: 'Cashout rules for $10-$20 deposits'
    },
    {
      depositRange: { min: 21, max: 40 },
      cashoutLimits: { min: 17, max: 60 },
      description: 'Cashout rules for $21-$40 deposits'
    },
    {
      depositRange: { min: 41, max: 60 },
      cashoutLimits: { min: 33, max: 90 },
      description: 'Cashout rules for $41-$60 deposits'
    },
    {
      depositRange: { min: 61, max: 100 },
      cashoutLimits: { min: 49, max: 150 },
      description: 'Cashout rules for $61-$100 deposits'
    },
    {
      depositRange: { min: 101, max: 999999 },
      cashoutLimits: { min: 80, max: 200 },
      description: 'Cashout rules for $100+ deposits',
      status: 'active'
    }
  ];
  
  const createdRules = [];
  for (const ruleData of defaultRules) {
    const existing = await this.findOne({ 
      'depositRange.min': ruleData.depositRange.min,
      'depositRange.max': ruleData.depositRange.max
    });
    
    if (!existing) {
      const rule = new this(ruleData);
      await rule.save();
      createdRules.push(rule);
    }
  }
  
  return createdRules;
};

module.exports = mongoose.model('CashoutRule', cashoutRuleSchema);