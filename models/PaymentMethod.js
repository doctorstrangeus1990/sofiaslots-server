// models/PaymentMethod.js
const mongoose = require('mongoose');

const paymentMethodSchema = new mongoose.Schema({
    method: {
        type: String,
        enum: ['crypto', 'cashapp', 'chime'],
        required: true,
        unique: true
    },
    isActive: {
        type: Boolean,
        default: true
    },
    // Crypto/Bitcoin payment configuration
    cryptoConfig: {
        gatewayUrl: String,
        apiKey: String,
        callbackUrl: String,
        username: String,
        password: String,
        depositChargePercent: {
            type: Number,
            default: 0,
            min: 0,
            max: 100
        },
        withdrawChargePercent: {
            type: Number,
            default: 0,
            min: 0,
            max: 100
        }
    },
    // Cashapp payment configuration
    cashappConfig: {
        apiUrl: String,              // Base URL: https://bo.wiwiusonepay.com/api/mgr
        authToken: String,            // Current valid token
        username: String,             // Login username (e.g., "test9999")
        password: String,             // Hashed password (e.g., "8f95612c5cd1be9f7871841dc0a7b945")
        mchNo: String,
        currCode: {
            type: String,
            default: 'usd'
        },
        wayCode: {
            type: String,
            default: 'cashapp'
        },
        depositChargePercent: {
            type: Number,
            default: 0,
            min: 0,
            max: 100
        },
        withdrawChargePercent: {
            type: Number,
            default: 0,
            min: 0,
            max: 100
        }
    },
    // Chime payment configuration
    chimeConfig: {
        businessChimeTag: String,
        businessChimeName: String,
        mailTmUsername: String,
        mailTmPassword: String,
        depositChargePercent: {
            type: Number,
            default: 0,
            min: 0,
            max: 100
        },
        withdrawChargePercent: {
            type: Number,
            default: 0,
            min: 0,
            max: 100
        }
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

// Index for efficient queries
paymentMethodSchema.index({ method: 1 });

// Static method to get payment method config
paymentMethodSchema.statics.getConfig = async function(method) {
    const paymentMethod = await this.findOne({ method, isActive: true });
    if (!paymentMethod) {
        throw new Error(`${method} payment method not configured`);
    }
    return paymentMethod[`${method}Config`];
};

// Static method to update cashapp auth token
paymentMethodSchema.statics.updateCashappToken = async function(newToken) {
    const paymentMethod = await this.findOneAndUpdate(
        { method: 'cashapp' },
        { 
            'cashappConfig.authToken': newToken,
            updatedAt: new Date()
        },
        { new: true }
    );
    return paymentMethod;
};

// Static method to calculate charge amount
paymentMethodSchema.statics.calculateCharge = async function(method, amount, transactionType) {
    const config = await this.getConfig(method);
    const chargePercent = transactionType === 'deposit' 
        ? (config.depositChargePercent || 0)
        : (config.withdrawChargePercent || 0);
    
    const chargeAmount = (amount * chargePercent) / 100;
    const finalAmount = transactionType === 'deposit' 
        ? amount - chargeAmount 
        : amount + chargeAmount;
    
    return {
        originalAmount: amount,
        chargePercent,
        chargeAmount: parseFloat(chargeAmount.toFixed(2)),
        finalAmount: parseFloat(finalAmount.toFixed(2))
    };
};

// Static method to save/update payment method config
paymentMethodSchema.statics.saveConfig = async function(method, config) {
    const paymentMethod = await this.findOneAndUpdate(
        { method },
        { 
            [`${method}Config`]: config,
            isActive: true,
            updatedAt: new Date()
        },
        { upsert: true, new: true }
    );
    return paymentMethod;
};

module.exports = mongoose.model('PaymentMethod', paymentMethodSchema);