// controllers/walletController.js - UPDATED WITH BONUS LOGIC

const Wallet = require('../models/Wallet');
const GameAccount = require('../models/GameAccount');
const PaymentMethod = require('../models/PaymentMethod');
const axios = require('axios');

// Get user's wallet information
const getWallet = async (req, res) => {
    try {
        const userId = req.user.userId;
        
        const wallet = await Wallet.findOrCreateWallet(userId);
        
        const pendingWithdrawals = wallet.transactions
            .filter(t => t.status === 'pending' && t.type === 'withdrawal')
            .reduce((sum, t) => sum + t.amount, 0);
        
        const pendingDeposits = wallet.transactions
            .filter(t => t.status === 'pending' && t.type === 'deposit')
            .reduce((sum, t) => sum + t.amount, 0);
        
        const recentTransactions = wallet.transactions
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            .slice(0, 10);
        
        const summary = wallet.getTransactionSummary(30);
        
        res.json({
            success: true,
            message: 'Wallet retrieved successfully',
            data: {
                balance: wallet.balance,
                bonusBalance: wallet.bonusBalance, // ✅ NEW
                availableBalance: wallet.availableBalance,
                availableBonusBalance: wallet.availableBonusBalance, // ✅ NEW
                totalAvailableBalance: wallet.availableBalance + wallet.availableBonusBalance, // ✅ NEW
                pendingBalance: wallet.pendingBalance,
                pendingWithdrawals,
                pendingDeposits,
                currency: wallet.currency,
                status: wallet.status,
                limits: {
                    dailyWithdrawalLimit: wallet.dailyWithdrawalLimit,
                    monthlyWithdrawalLimit: wallet.monthlyWithdrawalLimit,
                    todayWithdrawn: wallet.todayWithdrawn.amount,
                    monthlyWithdrawn: wallet.monthlyWithdrawn.amount
                },
                recentTransactions,
                summary
            }
        });
        
    } catch (error) {
        console.error('Error fetching wallet:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching wallet information'
        });
    }
};

// Get wallet balance only
const getWalletBalance = async (req, res) => {
    try {
        const userId = req.user.userId;
        
        const wallet = await Wallet.findOrCreateWallet(userId);
        
        res.json({
            success: true,
            data: {
                balance: wallet.balance,
                bonusBalance: wallet.bonusBalance, // ✅ NEW
                availableBalance: wallet.availableBalance,
                availableBonusBalance: wallet.availableBonusBalance, // ✅ NEW
                totalAvailableBalance: wallet.availableBalance + wallet.availableBonusBalance, // ✅ NEW
                pendingBalance: wallet.pendingBalance,
                currency: wallet.currency
            }
        });
        
    } catch (error) {
        console.error('Error fetching wallet balance:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching wallet balance'
        });
    }
};

// ✅ NEW: Add bonus to wallet
const addBonus = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { amount, description } = req.body;
        
        if (!amount || amount <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Valid amount is required (must be greater than 0)'
            });
        }
        
        const wallet = await Wallet.findOrCreateWallet(userId);
        
        if (wallet.status !== 'active') {
            return res.status(403).json({
                success: false,
                message: 'Wallet is not active'
            });
        }
        
        const transaction = wallet.addBonus(amount, description || 'Bonus added to wallet');
        await wallet.save();
        
        res.json({
            success: true,
            message: 'Bonus added successfully',
            data: {
                transactionId: transaction._id,
                amount,
                bonusBalance: wallet.bonusBalance,
                availableBonusBalance: wallet.availableBonusBalance
            }
        });
        
    } catch (error) {
        console.error('Error adding bonus:', error);
        res.status(500).json({
            success: false,
            message: 'Error adding bonus'
        });
    }
};

// Deposit funds
const depositFunds = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { amount, paymentMethod, description, external_id } = req.body;
        
        if (!amount || amount <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Valid amount is required (must be greater than 0)'
            });
        }
        
        if (amount > 10000) {
            return res.status(400).json({
                success: false,
                message: 'Maximum deposit amount is $10,000'
            });
        }
        
        if (!paymentMethod) {
            return res.status(400).json({
                success: false,
                message: 'Payment method is required'
            });
        }
        
        const wallet = await Wallet.findOrCreateWallet(userId);
        
        if (wallet.status !== 'active') {
            return res.status(403).json({
                success: false,
                message: 'Wallet is not active. Please contact support.'
            });
        }
        
        let depositFeePercent = 0;
        try {
            const paymentMethodConfig = await PaymentMethod.findOne({ 
                method: paymentMethod,
                isActive: true 
            });
            
            if (paymentMethodConfig) {
                const config = paymentMethodConfig[`${paymentMethod}Config`];
                depositFeePercent = config?.depositChargePercent || 0;
            }
        } catch (error) {
            console.error('Error fetching payment method config:', error);
        }
        
        const feeAmount = (amount * depositFeePercent) / 100;
        
        const transactionData = {
            type: 'deposit',
            amount,
            description: description || 'Wallet deposit',
            paymentMethod,
            status: 'pending',
            fee: feeAmount
        };
        
        if (paymentMethod === 'crypto' && external_id) {
            transactionData.external_id = external_id.toString();
        }
        
        const transaction = wallet.addTransaction(transactionData);
        
        await wallet.save();
        
        res.json({
            success: true,
            message: 'Deposit initiated successfully',
            data: {
                transactionId: transaction._id,
                amount,
                fee: feeAmount,
                feePercent: depositFeePercent,
                status: transaction.status,
                external_id: external_id || null,
                newBalance: wallet.balance,
                availableBalance: wallet.availableBalance
            }
        });
        
    } catch (error) {
        console.error('Error processing deposit:', error);
        res.status(500).json({
            success: false,
            message: 'Error processing deposit'
        });
    }
};

// Withdraw funds - UPDATED WITH DEPOSIT PLAY REQUIREMENT CHECK
const sendWithdrawalRequestNotification = async (data) => {
    try {
        const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
        const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

        if (!BOT_TOKEN || !CHAT_ID) {
            console.warn('⚠️  Telegram credentials not configured in .env');
            return null;
        }

        const { username, email, amount, fee, netAmount, paymentMethod, transactionId, details } = data;

        let message = `
🔔 <b>NEW WITHDRAWAL REQUEST</b>

👤 <b>User:</b> ${username}
💰 <b>Amount:</b> $${amount.toFixed(2)}
💸 <b>Fee:</b> $${fee.toFixed(2)}
💵 <b>Net Amount:</b> $${netAmount.toFixed(2)}
💳 <b>Method:</b> ${paymentMethod.toUpperCase()}
🆔 <b>ID:</b> <code>${transactionId}</code>`;

        // Add payment method specific details
        if (paymentMethod === 'cashapp' && details.cashappTag) {
            message += `\n\n💳 <b>CashApp Details:</b>
🏷️ <b>Tag:</b> ${details.cashappTag}`;
            if (details.cashappName) {
                message += `\n👤 <b>Name:</b> ${details.cashappName}`;
            }
        } else if (paymentMethod === 'chime' && details.chimeTag) {
            message += `\n\n💳 <b>Chime Details:</b>
🏷️ <b>Tag:</b> ${details.chimeTag}
👤 <b>Name:</b> ${details.chimeName}`;
        } else if (paymentMethod === 'crypto' && details.cryptoType) {
            message += `\n\n💳 <b>Crypto Details:</b>
🪙 <b>Type:</b> ${details.cryptoType}
📍 <b>Address:</b> <code>${details.cryptoAddress}</code>`;
            if (details.cryptoAmount) {
                message += `\n💰 <b>Amount:</b> ${details.cryptoAmount}`;
            }
        }

        message += `\n\n⏰ <b>Requested:</b> ${new Date().toLocaleString('en-US', { timeZone: 'UTC' })} UTC
⏳ <b>Status:</b> PENDING APPROVAL`;

        const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
        
        const response = await axios.post(url, {
            chat_id: CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        });

        console.log('✅ Telegram withdrawal request notification sent');
        
        // Return message_id so we can update this message later
        return response.data.result.message_id;

    } catch (error) {
        console.error('❌ Error sending Telegram request notification:', error.message);
        return null;
    }
};

// Withdraw funds - UPDATED WITH TELEGRAM NOTIFICATION
const withdrawFunds = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { 
            amount, 
            paymentMethod, 
            description, 
            cryptoType, 
            cryptoAddress, 
            cryptoAmount, 
            cashappTag,
            cashappName,
            chimeTag,
            chimeName
        } = req.body;
        
        if (!amount || amount <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Valid amount is required (must be greater than 0)'
            });
        }
        
        if (!paymentMethod) {
            return res.status(400).json({
                success: false,
                message: 'Payment method is required'
            });
        }

        if (paymentMethod === 'cashapp' && !cashappTag) {
            return res.status(400).json({
                success: false,
                message: 'CashApp tag is required'
            });
        }

        if (paymentMethod === 'chime' && (!chimeTag || !chimeName)) {
            return res.status(400).json({
                success: false,
                message: 'Chime tag and full name are required'
            });
        }

        if (paymentMethod === 'crypto' && (!cryptoType || !cryptoAddress)) {
            return res.status(400).json({
                success: false,
                message: 'Crypto type and address are required'
            });
        }
        
        const wallet = await Wallet.findOrCreateWallet(userId);
        
        // Populate user info for notification
        await wallet.populate('userId', 'username email');
        
        if (wallet.status !== 'active') {
            return res.status(403).json({
                success: false,
                message: 'Wallet is not active'
            });
        }
        
        // ✅ CHECK: Must play deposit before withdrawal
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔍 CHECKING DEPOSIT PLAY REQUIREMENT');
        
        const lastDeposit = wallet.transactions
            .filter(t => 
                t.type === 'deposit' && 
                t.status === 'completed' && 
                t.isBonus === false
            )
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
        
        if (lastDeposit) {
            console.log(`   Last Real Deposit: $${lastDeposit.amount} at ${lastDeposit.createdAt}`);
            console.log(`   Is Bonus: ${lastDeposit.isBonus ? 'YES' : 'NO'}`);
            
            const transferredToGames = wallet.transactions
                .filter(t => 
                    t.type === 'game_deposit' && 
                    t.status === 'completed' &&
                    new Date(t.createdAt) >= new Date(lastDeposit.createdAt)
                )
                .reduce((sum, t) => sum + t.amount, 0);
            
            console.log(`   Amount Played in Games: $${transferredToGames}`);
            console.log(`   Deposit Amount: $${lastDeposit.amount}`);
            
            if (transferredToGames < lastDeposit.amount) {
                const remainingToPlay = lastDeposit.amount - transferredToGames;
                
                console.log(`   ❌ INSUFFICIENT PLAY - Need $${remainingToPlay} more`);
                console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
                
                return res.status(400).json({
                    success: false,
                    message: `You must play your deposit ($${lastDeposit.amount.toFixed(2)}) in games before withdrawing. You've played $${transferredToGames.toFixed(2)} so far. Play $${remainingToPlay.toFixed(2)} more to unlock withdrawals.`,
                    data: {
                        depositAmount: lastDeposit.amount,
                        playedAmount: transferredToGames,
                        remainingToPlay: remainingToPlay,
                        depositDate: lastDeposit.createdAt,
                        requirementMet: false
                    }
                });
            }
            
            console.log(`   ✅ REQUIREMENT MET - Deposit has been played`);
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        } else {
            console.log('   ℹ️  No real deposit found - allowing withdrawal');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        }
        
        // ✅ CHECK: Cannot withdraw bonus balance directly
        if (amount > wallet.availableBalance) {
            return res.status(400).json({
                success: false,
                message: `Insufficient withdrawable balance. You have $${wallet.availableBalance.toFixed(2)} available for withdrawal. Bonus balance ($${wallet.bonusBalance.toFixed(2)}) can only be used for games.`
            });
        }
        
        let withdrawalFeePercent = 0;
        try {
            const paymentMethodConfig = await PaymentMethod.findOne({ 
                method: paymentMethod,
                isActive: true 
            });
            
            if (paymentMethodConfig) {
                const config = paymentMethodConfig[`${paymentMethod}Config`];
                withdrawalFeePercent = config?.withdrawChargePercent || 0;
            }
        } catch (error) {
            console.error('Error fetching payment method config:', error);
        }
        
        const feeAmount = (amount * withdrawalFeePercent) / 100;
        const netAmount = amount - feeAmount;
        
        const canWithdraw = wallet.canWithdraw(amount);
        
        if (!canWithdraw.allowed) {
            let message = 'Withdrawal not allowed: ';
            if (!canWithdraw.sufficient_balance) message += 'Insufficient balance. ';
            if (!canWithdraw.within_daily_limit) message += 'Daily limit exceeded. ';
            if (!canWithdraw.within_monthly_limit) message += 'Monthly limit exceeded. ';
            
            return res.status(400).json({
                success: false,
                message: message.trim()
            });
        }
        
        const transactionData = {
            type: 'withdrawal',
            amount,
            description: description || 'Wallet withdrawal',
            paymentMethod,
            status: 'pending',
            fee: feeAmount,
            netAmount: netAmount
        };

        if (paymentMethod === 'cashapp') {
            transactionData.cashappTag = cashappTag;
            if (cashappName) {
                transactionData.cashappName = cashappName;
            }
        }

        if (paymentMethod === 'chime') {
            transactionData.chimeTag = chimeTag;
            transactionData.chimeFullName = chimeName;
        }

        if (paymentMethod === 'crypto') {
            transactionData.cryptoType = cryptoType;
            transactionData.withdrawalAddress = cryptoAddress;
            if (cryptoAmount) {
                transactionData.cryptoAmount = cryptoAmount;
            }
        }
        
        const transaction = wallet.addTransaction(transactionData);
        wallet.processWithdrawal(amount);
        
        await wallet.save();

        // ✅ SEND TELEGRAM NOTIFICATION AND SAVE MESSAGE ID
        console.log('\n📱 Sending Telegram notification for withdrawal...');
        const telegramMessageId = await sendWithdrawalRequestNotification({
            username: wallet.userId.username,
            email: wallet.userId.email,
            amount: amount,
            fee: feeAmount,
            netAmount: netAmount,
            paymentMethod: paymentMethod,
            transactionId: transaction._id.toString(),
            details: {
                cashappTag,
                cashappName,
                chimeTag,
                chimeName,
                cryptoType,
                cryptoAddress,
                cryptoAmount
            }
        });

        // ✅ STORE MESSAGE ID IN TRANSACTION
        if (telegramMessageId) {
            transaction.telegramMessageId = telegramMessageId;
            await wallet.save();
            console.log(`✅ Telegram message_id ${telegramMessageId} saved to transaction`);
        }

        res.json({
            success: true,
            message: paymentMethod === 'crypto' 
                ? 'Crypto withdrawal requested successfully. Waiting for admin approval.' 
                : 'Withdrawal requested successfully',
            data: {
                transactionId: transaction._id,
                amount,
                fee: feeAmount,
                feePercent: withdrawalFeePercent,
                netAmount: netAmount,
                status: transaction.status,
                paymentMethod,
                ...(paymentMethod === 'cashapp' && { cashappTag }),
                ...(paymentMethod === 'chime' && { chimeTag, chimeName }),
                ...(paymentMethod === 'crypto' && { cryptoType, cryptoAddress, cryptoAmount }),
                newBalance: wallet.balance,
                availableBalance: wallet.availableBalance,
                pendingBalance: wallet.pendingBalance
            }
        });
        
    } catch (error) {
        console.error('Error processing withdrawal:', error);
        res.status(500).json({
            success: false,
            message: 'Error processing withdrawal'
        });
    }
};

// Get transaction history
const getTransactionHistory = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { page = 1, limit = 20, type, status, startDate, endDate } = req.query;
        
        const wallet = await Wallet.findOrCreateWallet(userId);
        
        let transactions = [...wallet.transactions];
        
        if (type) {
            transactions = transactions.filter(t => t.type === type);
        }
        
        if (status) {
            transactions = transactions.filter(t => t.status === status);
        }
        
        if (startDate) {
            transactions = transactions.filter(t => new Date(t.createdAt) >= new Date(startDate));
        }
        
        if (endDate) {
            transactions = transactions.filter(t => new Date(t.createdAt) <= new Date(endDate));
        }
        
        transactions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        
        const startIndex = (page - 1) * limit;
        const endIndex = startIndex + parseInt(limit);
        const paginatedTransactions = transactions.slice(startIndex, endIndex);
        
        const totalTransactions = transactions.length;
        const totalPages = Math.ceil(totalTransactions / limit);
        
        res.json({
            success: true,
            message: 'Transaction history retrieved successfully',
            data: {
                transactions: paginatedTransactions,
                pagination: {
                    currentPage: parseInt(page),
                    totalPages,
                    totalTransactions,
                    hasNextPage: endIndex < totalTransactions,
                    hasPrevPage: page > 1
                }
            }
        });
        
    } catch (error) {
        console.error('Error fetching transaction history:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching transaction history'
        });
    }
};

// Get single transaction
const getTransaction = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { transactionId } = req.params;
        
        const wallet = await Wallet.findOrCreateWallet(userId);
        const transaction = wallet.transactions.id(transactionId);
        
        if (!transaction) {
            return res.status(404).json({
                success: false,
                message: 'Transaction not found'
            });
        }
        
        res.json({
            success: true,
            message: 'Transaction retrieved successfully',
            data: { transaction }
        });
        
    } catch (error) {
        console.error('Error fetching transaction:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching transaction'
        });
    }
};

// Update wallet settings
const updateWalletSettings = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { dailyWithdrawalLimit, monthlyWithdrawalLimit } = req.body;
        
        const wallet = await Wallet.findOrCreateWallet(userId);
        
        if (dailyWithdrawalLimit !== undefined) {
            if (dailyWithdrawalLimit < 0 || dailyWithdrawalLimit > 5000) {
                return res.status(400).json({
                    success: false,
                    message: 'Daily withdrawal limit must be between $0 and $5,000'
                });
            }
            wallet.dailyWithdrawalLimit = dailyWithdrawalLimit;
        }
        
        if (monthlyWithdrawalLimit !== undefined) {
            if (monthlyWithdrawalLimit < 0 || monthlyWithdrawalLimit > 50000) {
                return res.status(400).json({
                    success: false,
                    message: 'Monthly withdrawal limit must be between $0 and $50,000'
                });
            }
            wallet.monthlyWithdrawalLimit = monthlyWithdrawalLimit;
        }
        
        await wallet.save();
        
        res.json({
            success: true,
            message: 'Wallet settings updated successfully',
            data: {
                dailyWithdrawalLimit: wallet.dailyWithdrawalLimit,
                monthlyWithdrawalLimit: wallet.monthlyWithdrawalLimit
            }
        });
        
    } catch (error) {
        console.error('Error updating wallet settings:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating wallet settings'
        });
    }
};

const getRecentWinners = async (req, res) => {
    try {
        const Game = require('../models/Game');
        const Wallet = require('../models/Wallet');
        const GameAccount = require('../models/GameAccount');
        
        // ✅ Use aggregation to get recent winners efficiently
        const recentWinners = await Wallet.aggregate([
            // Only get wallets that have game withdrawals
            {
                $match: {
                    'transactions.type': 'game_withdrawal',
                    'transactions.status': 'completed'
                }
            },
            // Unwind transactions
            { $unwind: '$transactions' },
            // Filter for completed game withdrawals
            {
                $match: {
                    'transactions.type': 'game_withdrawal',
                    'transactions.status': 'completed'
                }
            },
            // Join with users
            {
                $lookup: {
                    from: 'users',
                    localField: 'userId',
                    foreignField: '_id',
                    as: 'user'
                }
            },
            { $unwind: '$user' },
            // Project only needed fields
            {
                $project: {
                    username: '$user.username',
                    email: '$user.email',
                    amount: {
                        $ifNull: ['$transactions.netAmount', '$transactions.amount']
                    },
                    gameAccountId: {
                        $ifNull: [
                            '$transactions.gameDetails.gameAccountId',
                            '$transactions.referenceId'
                        ]
                    },
                    gameType: {
                        $ifNull: [
                            '$transactions.gameDetails.gameType',
                            'Unknown'
                        ]
                    },
                    gameLogin: {
                        $ifNull: [
                            '$transactions.gameDetails.gameLogin',
                            ''
                        ]
                    },
                    createdAt: '$transactions.createdAt',
                    transactionId: '$transactions._id'
                }
            },
            // Sort by most recent
            { $sort: { createdAt: -1 } },
            // Limit to top 10
            { $limit: 10 }
        ]);

        // ✅ Fetch game details for winners (only 10 queries max)
        const winnersWithImages = await Promise.all(
            recentWinners.map(async (winner) => {
                let gameName = winner.gameType;
                let gameImage = null;
                
                try {
                    // Try to get from game account first
                    if (winner.gameAccountId) {
                        const gameAccount = await GameAccount.findById(winner.gameAccountId)
                            .populate({
                                path: 'gameId',
                                select: 'name displayName title image shortcode'
                            })
                            .lean();
                        
                        if (gameAccount && gameAccount.gameId) {
                            const game = gameAccount.gameId;
                            gameName = game.displayName || game.name || game.title || winner.gameType;
                            gameImage = game.image || null;
                        }
                    }
                    
                    // Fallback to finding game by type/name
                    if (!gameImage) {
                        const game = await Game.findOne({
                            $or: [
                                { shortcode: winner.gameType.toUpperCase() },
                                { gameType: winner.gameType.toLowerCase() },
                                { name: { $regex: new RegExp(winner.gameType, 'i') } },
                                { slug: winner.gameType.toLowerCase() }
                            ]
                        })
                        .select('name displayName title image shortcode')
                        .lean();
                        
                        if (game) {
                            gameName = game.displayName || game.name || game.title || winner.gameType;
                            gameImage = game.image || null;
                        }
                    }
                } catch (err) {
                    console.error('Error fetching game details:', err);
                }
                
                return {
                    name: maskUsername(winner.username),
                    amount: winner.amount,
                    game: gameName,
                    gameImage: gameImage,
                    gameLogin: winner.gameLogin,
                    timestamp: winner.createdAt
                };
            })
        );
        
        res.json({
            success: true,
            message: 'Recent winners retrieved successfully',
            data: {
                winners: winnersWithImages
            }
        });
        
    } catch (error) {
        console.error('Error fetching recent winners:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching recent winners',
            data: {
                winners: []
            }
        });
    }
};

// Helper function to mask username
const maskUsername = (username) => {
    if (!username || username.length <= 3) {
        return username ? username + '***' : 'Anonymous***';
    }
    return username.substring(0, 3) + '***';
};

module.exports = {
    getWallet,
    getWalletBalance,
    addBonus, // ✅ NEW
    depositFunds,
    withdrawFunds,
    getTransactionHistory,
    getTransaction,
    updateWalletSettings,
    getRecentWinners
};