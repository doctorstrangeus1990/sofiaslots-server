// models/UserSettings.js
const mongoose = require('mongoose');

const userSettingsSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  
  // Notification Preferences
  notifications: {
    email: {
      enabled: {
        type: Boolean,
        default: true
      },
      accountUpdates: {
        type: Boolean,
        default: true
      },
      transactionAlerts: {
        type: Boolean,
        default: true
      },
      securityAlerts: {
        type: Boolean,
        default: true
      },
      promotions: {
        type: Boolean,
        default: false
      }
    },
    push: {
      enabled: {
        type: Boolean,
        default: false
      },
      gameUpdates: {
        type: Boolean,
        default: false
      },
      winAlerts: {
        type: Boolean,
        default: false
      }
    },
    sms: {
      enabled: {
        type: Boolean,
        default: false
      },
      securityAlerts: {
        type: Boolean,
        default: false
      }
    }
  },

  // Privacy Settings
  privacy: {
    profileVisibility: {
      type: String,
      enum: ['public', 'friends', 'private'],
      default: 'public'
    },
    showOnlineStatus: {
      type: Boolean,
      default: true
    },
    showGameHistory: {
      type: Boolean,
      default: true
    },
    allowFriendRequests: {
      type: Boolean,
      default: true
    }
  },

  // Security Settings
  security: {
    twoFactorEnabled: {
      type: Boolean,
      default: false
    },
    twoFactorMethod: {
      type: String,
      enum: ['none', 'email', 'sms', 'authenticator'],
      default: 'none'
    },
    loginNotifications: {
      type: Boolean,
      default: true
    },
    sessionTimeout: {
      type: Number,
      default: 24, // hours
      min: 1,
      max: 168 // 7 days
    },
    trustedDevices: [{
      deviceId: String,
      deviceName: String,
      lastUsed: Date,
      addedAt: {
        type: Date,
        default: Date.now
      }
    }]
  },

  // Display Preferences
  display: {
    language: {
      type: String,
      default: 'en'
    },
    timezone: {
      type: String,
      default: 'UTC'
    },
    currency: {
      type: String,
      default: 'USD'
    },
    theme: {
      type: String,
      enum: ['light', 'dark', 'auto'],
      default: 'dark'
    },
    soundEffects: {
      type: Boolean,
      default: true
    },
    animations: {
      type: Boolean,
      default: true
    }
  },

  // Game Preferences
  game: {
    autoPlay: {
      type: Boolean,
      default: false
    },
    quickBet: {
      type: Boolean,
      default: false
    },
    confirmBets: {
      type: Boolean,
      default: true
    },
    defaultBetAmount: {
      type: Number,
      default: 1,
      min: 0
    }
  },

  // Communication Preferences
  communication: {
    marketingEmails: {
      type: Boolean,
      default: false
    },
    newsletterSubscription: {
      type: Boolean,
      default: false
    },
    surveyInvitations: {
      type: Boolean,
      default: false
    },
    productUpdates: {
      type: Boolean,
      default: true
    }
  },

  // Responsible Gaming
  responsibleGaming: {
    dailyDepositLimit: {
      enabled: {
        type: Boolean,
        default: false
      },
      amount: {
        type: Number,
        default: 0
      }
    },
    weeklyDepositLimit: {
      enabled: {
        type: Boolean,
        default: false
      },
      amount: {
        type: Number,
        default: 0
      }
    },
    monthlyDepositLimit: {
      enabled: {
        type: Boolean,
        default: false
      },
      amount: {
        type: Number,
        default: 0
      }
    },
    sessionTimeLimit: {
      enabled: {
        type: Boolean,
        default: false
      },
      minutes: {
        type: Number,
        default: 0
      }
    },
    selfExclusion: {
      enabled: {
        type: Boolean,
        default: false
      },
      until: Date
    }
  }
}, {
  timestamps: true
});

// Index for faster queries
userSettingsSchema.index({ userId: 1 });

// Static method to get or create settings for a user
userSettingsSchema.statics.getOrCreate = async function(userId) {
  let settings = await this.findOne({ userId });
  
  if (!settings) {
    settings = await this.create({ userId });
  }
  
  return settings;
};

// Method to update specific setting category
userSettingsSchema.methods.updateCategory = async function(category, data) {
  if (this[category]) {
    Object.assign(this[category], data);
    await this.save();
  }
  return this;
};

const UserSettings = mongoose.model('UserSettings', userSettingsSchema);

module.exports = UserSettings;