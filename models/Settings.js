// models/Settings.js
const mongoose = require('mongoose');

const promotionalBonusSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  bonusPercentage: {
    type: Number,
    required: true,
    min: 0,
    max: 500
  },
  bonusType: {
    type: String,
    enum: ['deposit', 'cashback', 'reload', 'special'],
    default: 'deposit'
  },
  duration: {
    type: String,
    enum: ['24h', '48h', '72h', '7d', '14d', '30d'],
    default: '24h'
  },
  startDate: {
    type: Date,
    required: true
  },
  endDate: {
    type: Date,
    required: true
  },
  status: {
    type: String,
    enum: ['active', 'expired', 'scheduled'],
    default: 'scheduled'
  },
  minDeposit: {
    type: Number,
    default: 0
  },
  maxBonus: {
    type: Number,
    default: null
  },
  isVisible: {
    type: Boolean,
    default: true
  }
}, { 
  timestamps: true 
});

// ✅ SIMPLIFIED: Announcement Schema (removed priority, dates, targetUsers, clickAction)
const announcementSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100
  },
  description: {
    type: String,
    required: true,
    trim: true,
    maxlength: 250
  },
  icon: {
    type: String,
    enum: ['info', 'gift', 'card', 'money', 'lightning', 'star', 'bell', 'trophy'],
    default: 'card'
  },
  iconColor: {
    type: String,
    enum: ['purple', 'green', 'blue', 'yellow', 'red', 'orange'],
    default: 'purple'
  },
  tag: {
    label: {
      type: String,
      trim: true,
      maxlength: 15,
      default: ''
    },
    color: {
      type: String,
      enum: ['yellow', 'green', 'blue', 'red', 'purple', 'orange'],
      default: 'yellow'
    }
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, { 
  timestamps: true 
});

const settingsSchema = new mongoose.Schema({
  _id: {
    type: String,
    default: 'app_settings'
  },
  
  signupBonus: {
    enabled: {
      type: Boolean,
      default: true
    },
    amount: {
      type: Number,
      default: 3,
      min: 0
    },
    description: {
      type: String,
      default: 'Welcome signup bonus'
    }
  },
  
  firstDepositBonus: {
    enabled: {
      type: Boolean,
      default: true
    },
    percentage: {
      type: Number,
      default: 150,
      min: 0,
      max: 500
    },
    minDeposit: {
      type: Number,
      default: 10
    },
    maxBonus: {
      type: Number,
      default: 500
    },
    description: {
      type: String,
      default: 'First deposit bonus'
    }
  },
  
  promotionalBonuses: [promotionalBonusSchema],
  
  announcements: [announcementSchema],
  
  general: {
    siteName: {
      type: String,
      default: 'Belucky Gaming Platform'
    },
    siteDescription: {
      type: String,
      default: 'Premier online casino and gaming platform'
    },
    maintenanceMode: {
      type: Boolean,
      default: false
    },
    registrationEnabled: {
      type: Boolean,
      default: true
    },
    emailVerificationRequired: {
      type: Boolean,
      default: true
    }
  }
}, {
  timestamps: true
});

// Static method to get or create settings
settingsSchema.statics.getSettings = async function() {
  let settings = await this.findById('app_settings');
  
  if (!settings) {
    settings = await this.create({ _id: 'app_settings' });
  }
  
  return settings;
};

// Signup Bonus Methods
settingsSchema.methods.updateSignupBonus = function(amount, enabled = true) {
  this.signupBonus.amount = amount;
  this.signupBonus.enabled = enabled;
  return this.save();
};

// First Deposit Bonus Methods
settingsSchema.methods.updateFirstDepositBonus = function(percentage, minDeposit, maxBonus, enabled = true) {
  this.firstDepositBonus.percentage = percentage;
  this.firstDepositBonus.minDeposit = minDeposit;
  this.firstDepositBonus.maxBonus = maxBonus;
  this.firstDepositBonus.enabled = enabled;
  return this.save();
};

// Promotional Bonus Methods
settingsSchema.methods.addPromotionalBonus = function(bonusData) {
  const bonus = {
    ...bonusData,
    status: this.calculateBonusStatus(bonusData.startDate, bonusData.endDate)
  };
  
  this.promotionalBonuses.push(bonus);
  return this.save();
};

settingsSchema.methods.updatePromotionalBonus = function(bonusId, updateData) {
  const bonus = this.promotionalBonuses.id(bonusId);
  if (!bonus) {
    throw new Error('Promotional bonus not found');
  }
  
  Object.assign(bonus, updateData);
  bonus.status = this.calculateBonusStatus(bonus.startDate, bonus.endDate);
  
  return this.save();
};

settingsSchema.methods.deletePromotionalBonus = function(bonusId) {
  this.promotionalBonuses.pull(bonusId);
  return this.save();
};

settingsSchema.methods.getActivePromotionalBonus = function() {
  const now = new Date();
  
  return this.promotionalBonuses.find(bonus => 
    bonus.status === 'active' &&
    bonus.isVisible &&
    bonus.startDate <= now &&
    bonus.endDate >= now
  );
};

// ✅ SIMPLIFIED: Announcement Methods (no complex filtering, just active status)
settingsSchema.methods.addAnnouncement = function(announcementData) {
  this.announcements.push(announcementData);
  return this.save();
};

settingsSchema.methods.updateAnnouncement = function(announcementId, updateData) {
  const announcement = this.announcements.id(announcementId);
  if (!announcement) {
    throw new Error('Announcement not found');
  }
  
  Object.assign(announcement, updateData);
  return this.save();
};

settingsSchema.methods.deleteAnnouncement = function(announcementId) {
  this.announcements.pull(announcementId);
  return this.save();
};

settingsSchema.methods.getActiveAnnouncements = function() {
  // ✅ Simple filter: just return active announcements, ordered by creation date (newest first)
  return this.announcements
    .filter(announcement => announcement.isActive)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
};

// Bonus Status Calculator
settingsSchema.methods.calculateBonusStatus = function(startDate, endDate) {
  const now = new Date();
  
  if (now < new Date(startDate)) {
    return 'scheduled';
  } else if (now > new Date(endDate)) {
    return 'expired';
  } else {
    return 'active';
  }
};

settingsSchema.methods.updateAllBonusStatuses = function() {
  this.promotionalBonuses.forEach(bonus => {
    bonus.status = this.calculateBonusStatus(bonus.startDate, bonus.endDate);
  });
  
  return this.save();
};

// Pre-save hook to update bonus statuses
settingsSchema.pre('save', function(next) {
  if (this.promotionalBonuses && this.promotionalBonuses.length > 0) {
    this.promotionalBonuses.forEach(bonus => {
      bonus.status = this.calculateBonusStatus(bonus.startDate, bonus.endDate);
    });
  }
  next();
});

const Settings = mongoose.model('Settings', settingsSchema);

module.exports = Settings;