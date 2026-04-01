// models/Wallet.js - COMPLETE FIXED VERSION
const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
    type: {
        type: String,
        required: true,
        enum: ['deposit', 'withdrawal', 'game_deposit', 'game_withdrawal', 'bonus', 'refund', 'transfer', 'spin_reward']
    },
    amount: {
        type: Number,
        required: true,
        min: 0
    },
    description: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ['pending', 'completed', 'failed', 'cancelled'],
        default: 'pending'
    },
    // ✅ Track if transaction used bonus balance
    isBonus: {
        type: Boolean,
        default: false
    },
    // ✅ For game_withdrawal from bonus deposits - track restricted amount
    bonusRestrictionAmount: {
        type: Number,
        default: 0
    },
    // ✅ Reference to the game_deposit transaction (for tracking bonus)
    relatedDepositId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Transaction'
    },
    // ✅ Store Telegram message ID for withdrawal notifications
    telegramMessageId: {
        type: Number,
        default: null
    },
    txid: {
        type: String,
        sparse: true,
        index: true
    },
    external_id: {
        type: String,
        sparse: true
    },
    referenceId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'GameAccount'
    },
    gameDetails: {
        gameType: String,
        gameLogin: String,
        gameAccountId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'GameAccount'
        }
    },
    paymentMethod: {
        type: String,
        enum: ['credit_card', 'bank_transfer', 'crypto', 'paypal', 'game_balance', 'cashapp', 'chime', 'admin_manual', 'admin_redeem']
    },
    cashappTag: {
        type: String,
        trim: true
    },
    cashappName: {
        type: String,
        trim: true
    },
    chimeTag: {
        type: String,
        trim: true
    },
    chimeFullName: {
        type: String,
        trim: true
    },
    cryptoType: {
        type: String,
        enum: ['BTC', 'ETH', 'USDT', 'LTC', 'BNB', 'TRX', null],
        default: null
    },
    withdrawalAddress: {
        type: String,
        trim: true
    },
    cryptoAmount: {
        type: Number,
        min: 0
    },
    processedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    notes: String,
    fee: {
        type: Number,
        default: 0
    },
    netAmount: {
        type: Number,
        required: true
    },
    balanceBefore: {
        type: Number,
        required: true
    },
    balanceAfter: {
        type: Number,
        required: true
    },
    // ✅ Track bonus balance changes
    bonusBalanceBefore: {
        type: Number,
        default: 0
    },
    bonusBalanceAfter: {
        type: Number,
        default: 0
    },
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    completedAt: {
        type: Date
    }
}, {
    timestamps: true
});

const walletSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true
    },
    balance: {
        type: Number,
        default: 0,
        min: 0
    },
    // ✅ Separate bonus balance
    bonusBalance: {
        type: Number,
        default: 0,
        min: 0
    },
    pendingBalance: {
        type: Number,
        default: 0
    },
    availableBalance: {
        type: Number,
        default: 0
    },
    // ✅ Available bonus balance
    availableBonusBalance: {
        type: Number,
        default: 0
    },
    currency: {
        type: String,
        default: 'USD'
    },
    status: {
        type: String,
        enum: ['active', 'suspended', 'frozen'],
        default: 'active'
    },
    dailyWithdrawalLimit: {
        type: Number,
        default: 1000
    },
    monthlyWithdrawalLimit: {
        type: Number,
        default: 10000
    },
    todayWithdrawn: {
        amount: { type: Number, default: 0 },
        date: { type: Date, default: Date.now }
    },
    monthlyWithdrawn: {
        amount: { type: Number, default: 0 },
        month: { type: Number, default: () => new Date().getMonth() },
        year: { type: Number, default: () => new Date().getFullYear() }
    },
    lastTransactionAt: {
        type: Date
    },
    transactions: [transactionSchema]
}, {
    timestamps: true
});

// Indexes
walletSchema.index({ userId: 1 });
walletSchema.index({ 'transactions.createdAt': -1 });
walletSchema.index({ 'transactions.type': 1 });
walletSchema.index({ 'transactions.status': 1 });
walletSchema.index({ 'transactions.isBonus': 1 });
walletSchema.index({ 'transactions.gameDetails.gameAccountId': 1 });

// Virtual for total available balance
walletSchema.virtual('totalAvailableBalance').get(function() {
    return this.availableBalance + this.availableBonusBalance;
});

// ✅ Method to add bonus
walletSchema.methods.addBonus = function(amount, description = 'Bonus added') {
    const bonusBalanceBefore = this.bonusBalance;
    const bonusBalanceAfter = bonusBalanceBefore + amount;

    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`🎁 ADD BONUS`);
    console.log(`Amount: $${amount}`);
    console.log(`Before: $${bonusBalanceBefore}`);
    console.log(`After: $${bonusBalanceAfter}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    const transaction = {
        type: 'bonus',
        amount,
        description,
        status: 'completed',
        isBonus: true,
        netAmount: amount,
        balanceBefore: this.balance,
        balanceAfter: this.balance,
        bonusBalanceBefore,
        bonusBalanceAfter,
        completedAt: new Date()
    };

    this.transactions.push(transaction);
    this.bonusBalance = bonusBalanceAfter;
    this.updateAvailableBalance();
    this.lastTransactionAt = new Date();

    return this.transactions[this.transactions.length - 1];
};

// ✅ Method to add transaction with proper bonus deduction
walletSchema.methods.addTransaction = function(transactionData) {
    const balanceBefore = this.balance;
    const bonusBalanceBefore = this.bonusBalance;
    
    const netAmount = transactionData.netAmount || (transactionData.amount - (transactionData.fee || 0));
    
    let balanceAfter = balanceBefore;
    let bonusBalanceAfter = bonusBalanceBefore;
    
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`💳 WALLET TRANSACTION`);
    console.log(`Type: ${transactionData.type}`);
    console.log(`Amount: ${transactionData.amount}`);
    console.log(`Is Bonus: ${transactionData.isBonus ? 'YES ✓' : 'NO ✗'}`);
    console.log(`Status: ${transactionData.status || 'pending'}`);
    console.log(`Balance Before: ${balanceBefore}`);
    console.log(`Bonus Balance Before: ${bonusBalanceBefore}`);
    
    // ✅ Calculate balanceAfter (but don't apply yet for pending withdrawals/game_deposits)
    if (['deposit', 'game_withdrawal', 'refund'].includes(transactionData.type)) {
        // These add to REGULAR balance only
        balanceAfter = balanceBefore + netAmount;
        console.log(`➕ Will add ${netAmount} to REGULAR balance`);
    } else if (transactionData.type === 'bonus') {
        // Bonus type adds to BONUS balance
        bonusBalanceAfter = bonusBalanceBefore + netAmount;
        console.log(`➕ Will add ${netAmount} to BONUS balance`);
    } else if (['withdrawal', 'game_deposit'].includes(transactionData.type)) {
        // ✅ Check if using bonus balance for game_deposit
        if (transactionData.type === 'game_deposit' && transactionData.isBonus === true) {
            // Deduct from BONUS balance IMMEDIATELY (no pending lock for bonus)
            bonusBalanceAfter = Math.max(0, bonusBalanceBefore - transactionData.amount);
            console.log(`➖ Will deduct ${transactionData.amount} from BONUS balance`);
        } else {
            // For regular balance - will deduct but only through pending mechanism
            balanceAfter = Math.max(0, balanceBefore - transactionData.amount);
            console.log(`➖ Will lock ${transactionData.amount} in PENDING (balance stays at ${balanceBefore})`);
        }
    }
    
    console.log(`Calculated Balance After: ${balanceAfter}`);
    console.log(`Calculated Bonus Balance After: ${bonusBalanceAfter}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    
    const transaction = {
        ...transactionData,
        netAmount,
        balanceBefore,
        balanceAfter,
        bonusBalanceBefore,
        bonusBalanceAfter,
        status: transactionData.status || 'pending'
    };
    
    this.transactions.push(transaction);
    
    // ✅ Update wallet balances based on status and type
    if (transaction.status === 'completed') {
        // Apply the calculated balances immediately
        this.balance = balanceAfter;
        this.bonusBalance = bonusBalanceAfter;
        this.updateAvailableBalance();
        
        if (!transaction.completedAt) {
            transaction.completedAt = new Date();
        }
        
        console.log(`✅ Wallet balances updated (completed):`);
        console.log(`   Regular Balance: ${this.balance}`);
        console.log(`   Bonus Balance: ${this.bonusBalance}`);
        console.log(`   Available Balance: ${this.availableBalance}`);
        console.log(`   Available Bonus Balance: ${this.availableBonusBalance}`);
    } else if (transaction.status === 'pending') {
        if (['withdrawal', 'game_deposit'].includes(transactionData.type)) {
            if (transactionData.isBonus) {
                // Bonus: deduct immediately, no pending lock
                this.bonusBalance = bonusBalanceAfter;
                console.log(`⏳ Bonus deducted immediately: ${this.bonusBalance}`);
            } else {
                // Regular: lock in pending, balance stays same
                this.pendingBalance += transactionData.amount;
                console.log(`⏳ Locked ${transactionData.amount} as pending`);
                console.log(`   Balance remains: ${this.balance}`);
                console.log(`   Pending: ${this.pendingBalance}`);
            }
            this.updateAvailableBalance();
        } else if (['deposit', 'game_withdrawal', 'refund'].includes(transactionData.type)) {
            // Deposits stay pending - don't update balance yet
            console.log(`⏳ Deposit pending - balance will update when completed`);
        }
    }
    
    this.lastTransactionAt = new Date();
    
    return this.transactions[this.transactions.length - 1];
};

// ✅ Method to get last deposit for a game account
walletSchema.methods.getLastGameDeposit = function(gameAccountId) {
    const deposits = this.transactions
        .filter(t => 
            t.type === 'game_deposit' && 
            t.status === 'completed' &&
            t.gameDetails?.gameAccountId?.toString() === gameAccountId.toString()
        )
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    
    return deposits.length > 0 ? deposits[0] : null;
};

// ✅ FIXED: Method to update transaction status
// ✅ FIXED: Method to update transaction status
walletSchema.methods.updateTransactionStatus = function(transactionId, status, notes) {
    const transaction = this.transactions.id(transactionId);
    if (!transaction) {
        throw new Error('Transaction not found');
    }
    
    const oldStatus = transaction.status;
    
    transaction.status = status;
    if (notes) transaction.notes = notes;
    
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`🔄 UPDATE TRANSACTION STATUS`);
    console.log(`Transaction ID: ${transactionId}`);
    console.log(`Old Status: ${oldStatus}`);
    console.log(`New Status: ${status}`);
    console.log(`Type: ${transaction.type}`);
    console.log(`Amount: $${transaction.amount}`);
    console.log(`Is Bonus: ${transaction.isBonus ? 'YES' : 'NO'}`);
    
    // ✅ Handle balance updates based on status change
    if (oldStatus === 'pending' && status === 'completed') {
        // For deposits/credits - ADD to balance (they were pending, now completed)
        if (['deposit', 'game_withdrawal', 'bonus', 'refund'].includes(transaction.type)) {
            if (transaction.type === 'bonus') {
                this.bonusBalance += transaction.netAmount;
                console.log(`➕ Added ${transaction.netAmount} to bonus balance`);
            } else {
                this.balance += transaction.netAmount;
                console.log(`➕ Added ${transaction.netAmount} to regular balance`);
            }
        }
        
        // ✅ For withdrawals/game_deposits - FINALIZE the deduction (release from pending, balance stays deducted)
        if (['withdrawal', 'game_deposit'].includes(transaction.type)) {
            if (!transaction.isBonus) {
                // Regular balance: was locked in pending, now just release from pending
                // The balance was ALREADY deducted in addTransaction
                this.balance = transaction.balanceAfter; // Apply the calculated balanceAfter
                this.pendingBalance = Math.max(0, this.pendingBalance - transaction.amount);
                console.log(`✅ Finalized deduction: Balance=$${this.balance}, Released from pending=$${transaction.amount}`);
            } else {
                // Bonus was deducted immediately, no pending
                console.log(`✅ Bonus transaction completed (was already deducted)`);
            }
        }
        
        transaction.completedAt = new Date();
    } 
    else if (oldStatus === 'pending' && ['failed', 'cancelled'].includes(status)) {
        // ✅ ROLLBACK: Handle refunds based on transaction type
        if (['withdrawal', 'game_deposit'].includes(transaction.type)) {
            if (transaction.isBonus) {
                // Bonus was deducted directly - refund to bonus balance
                this.bonusBalance += transaction.amount;
                console.log(`↩️  Refunded ${transaction.amount} to bonus balance`);
            } else {
                // Regular balance: restore the balance and release from pending
                this.balance = transaction.balanceBefore; // Restore to original balance
                this.pendingBalance = Math.max(0, this.pendingBalance - transaction.amount);
                console.log(`↩️  Refunded ${transaction.amount} to regular balance (was in pending)`);
            }
        }
        // If it was a deposit/credit that failed, don't add anything (it was never added)
        else if (['deposit', 'game_withdrawal', 'refund', 'bonus'].includes(transaction.type)) {
            console.log(`↩️  Deposit/credit failed - nothing to refund (was never added)`);
        }
    }
    
    transaction.balanceAfter = this.balance;
    transaction.bonusBalanceAfter = this.bonusBalance;
    this.updateAvailableBalance();
    
    console.log(`✅ Updated balances:`);
    console.log(`   Regular: $${this.balance}`);
    console.log(`   Bonus: $${this.bonusBalance}`);
    console.log(`   Pending: $${this.pendingBalance}`);
    console.log(`   Available: $${this.availableBalance}`);
    console.log(`   Available Bonus: $${this.availableBonusBalance}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    
    return transaction;
};

// ✅ Method to update available balances
walletSchema.methods.updateAvailableBalance = function() {
    // Regular balance minus pending
    this.availableBalance = Math.max(0, this.balance - this.pendingBalance);
    
    // Bonus balance is ALWAYS fully available (no pending lock for bonus)
    this.availableBonusBalance = Math.max(0, this.bonusBalance);
};

// Method to check if withdrawal is allowed
walletSchema.methods.canWithdraw = function(amount) {
    const today = new Date();
    const currentMonth = today.getMonth();
    const currentYear = today.getFullYear();
    
    if (this.todayWithdrawn.date.toDateString() !== today.toDateString()) {
        this.todayWithdrawn.amount = 0;
        this.todayWithdrawn.date = today;
    }
    
    if (this.monthlyWithdrawn.month !== currentMonth || 
        this.monthlyWithdrawn.year !== currentYear) {
        this.monthlyWithdrawn.amount = 0;
        this.monthlyWithdrawn.month = currentMonth;
        this.monthlyWithdrawn.year = currentYear;
    }
    
    const canWithdraw = {
        sufficient_balance: this.availableBalance >= amount,
        within_daily_limit: (this.todayWithdrawn.amount + amount) <= this.dailyWithdrawalLimit,
        within_monthly_limit: (this.monthlyWithdrawn.amount + amount) <= this.monthlyWithdrawalLimit,
        wallet_active: this.status === 'active'
    };
    
    canWithdraw.allowed = Object.values(canWithdraw).every(Boolean);
    
    return canWithdraw;
};

// Method to process withdrawal
walletSchema.methods.processWithdrawal = function(amount) {
    this.todayWithdrawn.amount += amount;
    this.monthlyWithdrawn.amount += amount;
    return true;
};

// Method to get transaction summary
walletSchema.methods.getTransactionSummary = function(days = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    
    const recentTransactions = this.transactions.filter(t => 
        t.createdAt >= startDate && t.status === 'completed'
    );
    
    const summary = {
        totalDeposits: 0,
        totalWithdrawals: 0,
        totalGameDeposits: 0,
        totalGameWithdrawals: 0,
        totalBonusAdded: 0,
        transactionCount: recentTransactions.length,
        netFlow: 0
    };
    
    recentTransactions.forEach(t => {
        switch (t.type) {
            case 'deposit':
            case 'refund':
                summary.totalDeposits += t.netAmount;
                summary.netFlow += t.netAmount;
                break;
            case 'bonus':
                summary.totalBonusAdded += t.netAmount;
                break;
            case 'withdrawal':
                summary.totalWithdrawals += t.amount;
                summary.netFlow -= t.amount;
                break;
            case 'game_deposit':
                summary.totalGameDeposits += t.amount;
                summary.netFlow -= t.amount;
                break;
            case 'game_withdrawal':
                summary.totalGameWithdrawals += t.netAmount;
                summary.netFlow += t.netAmount;
                break;
        }
    });
    
    return summary;
};

// Method to get withdrawal details
walletSchema.methods.getWithdrawalDetails = function(transactionId) {
    const transaction = this.transactions.id(transactionId);
    
    if (!transaction || transaction.type !== 'withdrawal') {
        return null;
    }
    
    const details = {
        transactionId: transaction._id,
        amount: transaction.amount,
        netAmount: transaction.netAmount,
        fee: transaction.fee,
        paymentMethod: transaction.paymentMethod,
        status: transaction.status,
        createdAt: transaction.createdAt,
        completedAt: transaction.completedAt
    };
    
    if (transaction.paymentMethod === 'cashapp') {
        details.cashappTag = transaction.cashappTag;
        details.cashappName = transaction.cashappName;
    } else if (transaction.paymentMethod === 'chime') {
        details.chimeTag = transaction.chimeTag;
        details.chimeFullName = transaction.chimeFullName;
    } else if (transaction.paymentMethod === 'crypto') {
        details.cryptoType = transaction.cryptoType;
        details.withdrawalAddress = transaction.withdrawalAddress;
        details.cryptoAmount = transaction.cryptoAmount;
        details.txid = transaction.txid;
    }
    
    return details;
};

// Static method to find or create wallet
walletSchema.statics.findOrCreateWallet = async function(userId) {
    let wallet = await this.findOne({ userId });
    
    if (!wallet) {
        wallet = new this({ userId });
        await wallet.save();
    }
    
    return wallet;
};

// Pre-save middleware
walletSchema.pre('save', function(next) {
    this.updateAvailableBalance();
    next();
});

module.exports = mongoose.model('Wallet', walletSchema);