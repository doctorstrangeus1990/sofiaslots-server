// models/SpinConfiguration.js
const mongoose = require('mongoose');

const segmentSchema = new mongoose.Schema({
  id: {
    type: Number,
    required: true
  },
  label: {
    type: String,
    required: true
  },
  value: {
    type: mongoose.Schema.Types.Mixed, // Can be number or string
    required: true
  },
  type: {
    type: String,
    enum: ['cash', 'freeplay', 'deposit_bonus', 'vip_xp', 'retry'],
    required: true
  },
  weight: {
    type: Number,
    required: true,
    min: 0.1,
    max: 10
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, { _id: false }); // Don't create _id for subdocuments

const spinConfigurationSchema = new mongoose.Schema({
  name: {
    type: String,
    default: 'default',
    unique: true
  },
  segments: [segmentSchema],
  isActive: {
    type: Boolean,
    default: true
  },
  dailySpinLimit: {
    type: Number,
    default: 1
  },
  rewardExpiryHours: {
    type: Number,
    default: 24
  },
  isSpinWheelActive: {
    type: Boolean,
    default: true
  },
  version: {
    type: String,
    default: '1.0'
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Static method to get or create default configuration
spinConfigurationSchema.statics.getOrCreateDefault = async function() {
  let config = await this.findOne({ name: 'default', isActive: true });
  
  if (!config) {
    // Create default configuration with the segments from SpinReward model
    const defaultSegments = [
      { id: 1, label: '$1', value: 1, type: 'cash', weight: 2.0, isActive: true },
      { id: 2, label: '$10', value: 10, type: 'cash', weight: 0.5, isActive: true },
      { id: 3, label: '$3', value: 3, type: 'cash', weight: 1.5, isActive: true },
      { id: 4, label: 'Retry', value: 'retry', type: 'retry', weight: 1.8, isActive: true },
      { id: 5, label: '$2', value: 2, type: 'cash', weight: 1.8, isActive: true },
      { id: 6, label: '$8', value: 8, type: 'cash', weight: 0.7, isActive: true },
      { id: 7, label: '$1', value: 1, type: 'cash', weight: 2.0, isActive: true },
      { id: 8, label: '$5', value: 5, type: 'cash', weight: 1.2, isActive: true },
      { id: 9, label: '$4', value: 4, type: 'cash', weight: 1.3, isActive: true },
      { id: 10, label: 'Retry', value: 'retry', type: 'retry', weight: 1.8, isActive: true },
      { id: 11, label: '$7', value: 7, type: 'cash', weight: 0.8, isActive: true },
      { id: 12, label: '$6', value: 6, type: 'cash', weight: 1.0, isActive: true }
    ];
    
    config = new this({
      name: 'default',
      segments: defaultSegments,
      isActive: true
    });
    
    await config.save();
  }
  
  return config;
};

// Instance method to update segments
spinConfigurationSchema.methods.updateSegments = async function(newSegments, updatedBy = null) {
  this.segments = newSegments;
  this.updatedBy = updatedBy;
  this.version = new Date().toISOString();
  return await this.save();
};

const SpinConfiguration = mongoose.model('SpinConfiguration', spinConfigurationSchema);

module.exports = SpinConfiguration;