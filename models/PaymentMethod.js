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

    // ─── Crypto/Bitcoin payment configuration ─────────────────────────────────
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

    // ─── CashApp payment configuration (OXPay gateway) ────────────────────────
    cashappConfig: {
        mchId:     String,   // OXPay Merchant ID
        secretKey: String,   // OXPay Merchant secret key (used for MD5 signing)
        notifyUrl: String,   // Public webhook URL OXPay will POST results to
        returnUrl: String,   // Optional: front-end redirect after payment
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

    // ─── Chime payment configuration ──────────────────────────────────────────
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

// ─── Static: get active config for a method ───────────────────────────────────
paymentMethodSchema.statics.getConfig = async function (method) {
    const paymentMethod = await this.findOne({ method, isActive: true });
    if (!paymentMethod) {
        throw new Error(`${method} payment method not configured`);
    }
    return paymentMethod[`${method}Config`];
};

// ─── Static: calculate charge amount ──────────────────────────────────────────
paymentMethodSchema.statics.calculateCharge = async function (method, amount, transactionType) {
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
        finalAmount:   parseFloat(finalAmount.toFixed(2))
    };
};

// ─── Static: save / update a method config ────────────────────────────────────
paymentMethodSchema.statics.saveConfig = async function (method, config) {
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