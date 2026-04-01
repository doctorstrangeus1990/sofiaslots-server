// models/OTP.js
const mongoose = require('mongoose');

const otpSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    index: true
  },
  otp: {
    type: String,
    required: true
  },
  purpose: {
    type: String,
    enum: ['registration', 'password_reset', 'email_verification', 'withdrawal'],
    default: 'registration'
  },
  verified: {
    type: Boolean,
    default: false
  },
  attempts: {
    type: Number,
    default: 0
  },
  maxAttempts: {
    type: Number,
    default: 5
  },
  expiresAt: {
    type: Date,
    required: true,
    index: { expires: 0 } // Auto-delete after expiry using TTL index
  },
  metadata: {
    ipAddress: String,
    userAgent: String,
    referralCode: String
  }
}, {
  timestamps: true
});

// Index for faster lookups
otpSchema.index({ email: 1, purpose: 1, verified: 1 });

// Method to check if OTP is expired
otpSchema.methods.isExpired = function() {
  return Date.now() > this.expiresAt;
};

// Method to check if attempts exceeded
otpSchema.methods.hasExceededAttempts = function() {
  return this.attempts >= this.maxAttempts;
};

// Static method to generate 6-digit OTP
otpSchema.statics.generateOTP = function() {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// Static method to clean up old OTPs for an email
otpSchema.statics.cleanupOldOTPs = async function(email, purpose) {
  await this.deleteMany({ 
    email, 
    purpose,
    verified: false 
  });
};

module.exports = mongoose.model('OTP', otpSchema);