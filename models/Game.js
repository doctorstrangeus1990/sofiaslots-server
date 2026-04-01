// models/Game.js
const mongoose = require('mongoose');

const gameSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  slug: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  shortcode: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true,
    maxlength: 10
  },
  category: {
    type: String,
    required: true,
    enum: ['Space Adventure', 'Ocean Adventure', 'Multi-Game', 'Casino', 'Slots', 'Fish Game']
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'maintenance'],
    default: 'active'
  },
  // Game URLs
  gameUrl: {
    type: String,
    default: null
  },
  downloadUrl: {
    type: String,
    default: null
  },
  // Game image
  image: {
    type: String,
    default: null
  },
  // Agent credentials for game API access
  agentUsername: {
    type: String,
    required: true,
    trim: true
  },
  agentPassword: {
    type: String,
    required: true,
    trim: true
  },
  // Display properties
  rating: {
    type: Number,
    default: 4.5,
    min: 1,
    max: 5
  },
  isNew: {
    type: Boolean,
    default: false
  },
  isFeatured: {
    type: Boolean,
    default: false
  },
  order: {
    type: Number,
    default: 0
  },
  // Display name (optional - defaults to name if not provided)
  displayName: {
    type: String,
    default: null
  },
  // Game type (derived from shortcode)
  gameType: {
    type: String,
    default: function() {
      return this.shortcode ? this.shortcode.toLowerCase() : null;
    }
  },
  // Title alias for name
  title: {
    type: String,
    default: function() {
      return this.name;
    }
  },
  // Statistics (will be updated by system)
  stats: {
    totalAccounts: {
      type: Number,
      default: 0
    },
    activeAccounts: {
      type: Number,
      default: 0
    },
    totalTransactions: {
      type: Number,
      default: 0
    },
    totalVolume: {
      type: Number,
      default: 0
    },
    lastStatsUpdate: {
      type: Date,
      default: Date.now
    }
  }
}, {
  timestamps: true
});

// Indexes
gameSchema.index({ slug: 1 });
gameSchema.index({ shortcode: 1 });
gameSchema.index({ status: 1 });
gameSchema.index({ category: 1 });
gameSchema.index({ order: 1 });

// Virtual for checking if game is available
gameSchema.virtual('isAvailable').get(function() {
  return this.status === 'active';
});

// Virtual for getting controller file name
gameSchema.virtual('controllerFile').get(function() {
  return `${this.shortcode.toLowerCase()}Controller.js`;
});

// Instance methods
gameSchema.methods.updateStats = async function() {
  try {
    const GameAccount = require('./GameAccount');
    
    const stats = await GameAccount.aggregate([
      { $match: { gameId: this._id } },
      {
        $group: {
          _id: null,
          totalAccounts: { $sum: 1 },
          activeAccounts: {
            $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] }
          },
          totalTransactions: { $sum: { $size: '$transactions' } },
          totalVolume: {
            $sum: {
              $reduce: {
                input: '$transactions',
                initialValue: 0,
                in: { $add: ['$$value', '$$this.amount'] }
              }
            }
          }
        }
      }
    ]);

    if (stats.length > 0) {
      this.stats = {
        ...stats[0],
        lastStatsUpdate: new Date()
      };
      await this.save();
    }
  } catch (error) {
    console.error('Error updating game stats:', error);
  }
};

// Method to check if controller is implemented
gameSchema.methods.isImplemented = function() {
  try {
    const path = require('path');
    const fs = require('fs');
    const controllerPath = path.join(__dirname, '..', 'gmcontrollers', `${this.shortcode.toLowerCase()}Controller.js`);
    
    return fs.existsSync(controllerPath);
  } catch (error) {
    console.log('Error in isImplemented():', error.message);
    return false;
  }
};

// Static methods
gameSchema.statics.getAvailableGames = function() {
  return this.find({
    status: { $in: ['active', 'maintenance'] }
  }).sort({ order: 1, name: 1 });
};

gameSchema.statics.getGameBySlug = function(slug) {
  return this.findOne({ slug });
};

gameSchema.statics.getGameByShortcode = function(shortcode) {
  return this.findOne({ shortcode: shortcode.toUpperCase() });
};

gameSchema.statics.getGamesByCategory = function(category) {
  return this.find({
    category,
    status: 'active'
  }).sort({ order: 1 });
};

gameSchema.statics.getFeaturedGames = function() {
  return this.find({
    isFeatured: true,
    status: 'active'
  }).sort({ order: 1 });
};

gameSchema.statics.getNewGames = function() {
  return this.find({
    isNew: true,
    status: 'active'
  }).sort({ createdAt: -1 });
};

// Pre-save middleware
gameSchema.pre('save', function(next) {
  // Auto-generate slug from name if not provided
  if (!this.slug && this.name) {
    this.slug = this.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim('-');
  }
  
  // Auto-generate shortcode from name if not provided
  if (!this.shortcode && this.name) {
    this.shortcode = this.name
      .replace(/[^a-zA-Z\s]/g, '')
      .split(' ')
      .map(word => word.charAt(0))
      .join('')
      .toUpperCase()
      .substring(0, 10);
  }

  // Set gameType based on shortcode
  if (this.shortcode) {
    this.gameType = this.shortcode.toLowerCase();
  }

  // Set title as alias for name
  if (this.name && !this.title) {
    this.title = this.name;
  }

  // Set displayName if not provided
  if (this.name && !this.displayName) {
    this.displayName = this.name;
  }
  
  next();
});

module.exports = mongoose.model('Game', gameSchema);