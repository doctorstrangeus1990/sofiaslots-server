// controllers/adminDataController.js
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const Game = require('../models/Game');
const Settings = require('../models/Settings');
const PaymentMethod = require('../models/PaymentMethod');
const GameAccount = require('../models/GameAccount');
const axios = require('axios');
const { completeDepositWithBonus } = require('../helpers/depositHelper');
// ================================
// HELPER FUNCTIONS
// ================================

const getTimeAgo = (date) => {
    const seconds = Math.floor((new Date() - new Date(date)) / 1000);
    
    let interval = seconds / 31536000;
    if (interval > 1) return Math.floor(interval) + ' years ago';
    
    interval = seconds / 2592000;
    if (interval > 1) return Math.floor(interval) + ' months ago';
    
    interval = seconds / 86400;
    if (interval > 1) return Math.floor(interval) + ' days ago';
    
    interval = seconds / 3600;
    if (interval > 1) return Math.floor(interval) + ' hours ago';
    
    interval = seconds / 60;
    if (interval > 1) return Math.floor(interval) + ' minutes ago';
    
    return Math.floor(seconds) + ' seconds ago';
};

// ================================
// ENHANCED DASHBOARD STATS WITH RECENT DATA
// ================================

const getStats = async (req, res) => {
    try {
        // ✅ Use MongoDB aggregation for better performance
        const [userStats, walletStats, gameAccountStats] = await Promise.all([
            // Get total users count
            User.countDocuments(),
            
            // Get wallet statistics using aggregation
            Wallet.aggregate([
                {
                    $project: {
                        balance: 1,
                        transactions: 1
                    }
                },
                {
                    $facet: {
                        balances: [
                            {
                                $group: {
                                    _id: null,
                                    totalBalance: { $sum: '$balance' },
                                    activeWallets: {
                                        $sum: { $cond: [{ $gt: ['$balance', 0] }, 1, 0] }
                                    },
                                    totalWallets: { $sum: 1 }
                                }
                            }
                        ],
                        transactions: [
                            { $unwind: '$transactions' },
                            {
                                $match: {
                                    'transactions.status': 'completed'
                                }
                            },
                            {
                                $group: {
                                    _id: '$transactions.type',
                                    total: {
                                        $sum: {
                                            $cond: [
                                                {
                                                    $and: [
                                                        { $eq: ['$transactions.type', 'deposit'] },
                                                        { $ne: ['$transactions.isBonus', true] }
                                                    ]
                                                },
                                                '$transactions.amount',
                                                {
                                                    $cond: [
                                                        { $eq: ['$transactions.type', 'withdrawal'] },
                                                        '$transactions.amount',
                                                        0
                                                    ]
                                                }
                                            ]
                                        }
                                    },
                                    count: { $sum: 1 }
                                }
                            }
                        ],
                        pending: [
                            { $unwind: '$transactions' },
                            {
                                $match: {
                                    'transactions.type': 'withdrawal',
                                    'transactions.status': 'pending'
                                }
                            },
                            {
                                $count: 'count'
                            }
                        ]
                    }
                }
            ]),
            
            // Get active game accounts count
            GameAccount.countDocuments({ status: 'active' })
        ]);

        // Process wallet stats
        const balanceStats = walletStats[0].balances[0] || {
            totalBalance: 0,
            activeWallets: 0,
            totalWallets: 0
        };

        const transactionStats = walletStats[0].transactions.reduce((acc, curr) => {
            if (curr._id === 'deposit') {
                acc.totalDeposits = curr.total;
                acc.completedTransactions += curr.count;
            } else if (curr._id === 'withdrawal') {
                acc.totalWithdrawals = curr.total;
                acc.completedTransactions += curr.count;
            }
            return acc;
        }, { totalDeposits: 0, totalWithdrawals: 0, completedTransactions: 0 });

        const pendingWithdrawals = walletStats[0].pending[0]?.count || 0;

        // ✅ Get recent users (limited to 5)
        const recentUsers = await User.find()
            .sort({ createdAt: -1 })
            .limit(5)
            .select('username email createdAt')
            .lean();

        // ✅ Get recent transactions (limited to 10)
        const recentTransactionsData = await Wallet.aggregate([
            { $unwind: '$transactions' },
            {
                $lookup: {
                    from: 'users',
                    localField: 'userId',
                    foreignField: '_id',
                    as: 'user'
                }
            },
            { $unwind: '$user' },
            {
                $project: {
                    _id: '$transactions._id',
                    username: '$user.username',
                    userEmail: '$user.email',
                    type: '$transactions.type',
                    amount: '$transactions.amount',
                    netAmount: '$transactions.netAmount',
                    fee: '$transactions.fee',
                    status: '$transactions.status',
                    paymentMethod: '$transactions.paymentMethod',
                    isBonus: '$transactions.isBonus',
                    createdAt: '$transactions.createdAt'
                }
            },
            { $sort: { createdAt: -1 } },
            { $limit: 10 }
        ]);

        const recentTransactions = recentTransactionsData.map(tx => ({
            ...tx,
            timeAgo: getTimeAgo(tx.createdAt)
        }));

        const monthlyGrowth = transactionStats.totalDeposits > 0 
            ? ((transactionStats.totalDeposits - transactionStats.totalWithdrawals) / transactionStats.totalDeposits * 100).toFixed(1) 
            : 0;

        res.json({
            success: true,
            data: {
                totalUsers: userStats,
                activeGames: gameAccountStats,
                totalDeposits: transactionStats.totalDeposits,
                totalWithdrawals: transactionStats.totalWithdrawals,
                pendingTransactions: pendingWithdrawals,
                completedTransactions: transactionStats.completedTransactions,
                revenue: transactionStats.totalDeposits - transactionStats.totalWithdrawals,
                totalRevenue: transactionStats.totalDeposits - transactionStats.totalWithdrawals,
                totalBalance: balanceStats.totalBalance,
                activeWallets: balanceStats.activeWallets,
                monthlyGrowth: parseFloat(monthlyGrowth),
                recentUsers,
                recentTransactions
            }
        });
    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch statistics',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

// ================================
// CHART DATA FOR DEPOSITS & WITHDRAWALS
// ================================

const getChartData = async (req, res) => {
    try {
        const { period = 'week', startDate, endDate } = req.query;

        // Calculate date range
        let start = new Date();
        let end = new Date();
        let groupBy = 'day';

        if (period === 'today') {
            start.setHours(0, 0, 0, 0);
            groupBy = 'hour';
        } else if (period === 'week') {
            start.setDate(start.getDate() - 7);
            groupBy = 'day';
        } else if (period === 'month') {
            start.setDate(start.getDate() - 30);
            groupBy = 'day';
        } else if (period === 'custom' && startDate && endDate) {
            start = new Date(startDate);
            end = new Date(endDate);
            const daysDiff = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
            groupBy = daysDiff > 60 ? 'month' : daysDiff > 7 ? 'week' : 'day';
        }

        // ✅ Use aggregation for better performance
        const chartDataResult = await Wallet.aggregate([
            { $unwind: '$transactions' },
            {
                $match: {
                    'transactions.status': 'completed',
                    'transactions.createdAt': {
                        $gte: start,
                        $lte: end
                    }
                }
            },
            {
                $group: {
                    _id: {
                        date: {
                            $dateToString: {
                                format: groupBy === 'hour' ? '%Y-%m-%d %H:00' :
                                       groupBy === 'day' ? '%Y-%m-%d' :
                                       groupBy === 'month' ? '%Y-%m' : '%Y-%m-%d',
                                date: '$transactions.createdAt'
                            }
                        },
                        type: '$transactions.type'
                    },
                    total: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $eq: ['$transactions.type', 'deposit'] },
                                        { $ne: ['$transactions.isBonus', true] }
                                    ]
                                },
                                '$transactions.amount',
                                {
                                    $cond: [
                                        { $eq: ['$transactions.type', 'withdrawal'] },
                                        '$transactions.amount',
                                        0
                                    ]
                                }
                            ]
                        }
                    }
                }
            },
            {
                $group: {
                    _id: '$_id.date',
                    deposits: {
                        $sum: {
                            $cond: [{ $eq: ['$_id.type', 'deposit'] }, '$total', 0]
                        }
                    },
                    withdrawals: {
                        $sum: {
                            $cond: [{ $eq: ['$_id.type', 'withdrawal'] }, '$total', 0]
                        }
                    }
                }
            },
            { $sort: { _id: 1 } }
        ]);

        // Format chart data
        const chartData = chartDataResult.map(item => ({
            date: item._id,
            deposits: item.deposits,
            withdrawals: item.withdrawals,
            net: item.deposits - item.withdrawals
        }));

        // Calculate summary
        const summary = {
            totalDeposits: chartData.reduce((sum, item) => sum + item.deposits, 0),
            totalWithdrawals: chartData.reduce((sum, item) => sum + item.withdrawals, 0),
            netRevenue: 0,
            averageDeposit: 0,
            averageWithdrawal: 0,
            transactionCount: chartData.length
        };

        summary.netRevenue = summary.totalDeposits - summary.totalWithdrawals;
        summary.averageDeposit = chartData.length > 0 ? summary.totalDeposits / chartData.length : 0;
        summary.averageWithdrawal = chartData.length > 0 ? summary.totalWithdrawals / chartData.length : 0;

        res.json({
            success: true,
            data: {
                chartData,
                summary,
                period,
                groupBy,
                dateRange: {
                    start: start.toISOString(),
                    end: end.toISOString()
                }
            }
        });

    } catch (error) {
        console.error('Error fetching chart data:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch chart data',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

const getTransactions = async (req, res) => {
    try {
        const {
            page = 1,
            limit = 50,
            type,
            status,
            paymentMethod,
            dateRange
        } = req.query;

        const skip = (parseInt(page) - 1) * parseInt(limit);

        // Build match conditions
        const matchConditions = {
            'transactions.0': { $exists: true } // Only wallets with transactions
        };

        // Build date filter
        let transactionMatch = {};
        
        if (type) {
            transactionMatch['transactions.type'] = type;
        }
        
        if (status) {
            transactionMatch['transactions.status'] = status;
        }
        
        if (paymentMethod) {
            transactionMatch['transactions.paymentMethod'] = paymentMethod;
        }

        if (dateRange && dateRange !== 'all') {
            const now = new Date();
            const startDate = new Date();

            switch (dateRange) {
                case 'lastWeek':
                    startDate.setDate(now.getDate() - 7);
                    break;
                case 'lastMonth':
                    startDate.setMonth(now.getMonth() - 1);
                    break;
                case 'lastYear':
                    startDate.setFullYear(now.getFullYear() - 1);
                    break;
            }

            transactionMatch['transactions.createdAt'] = {
                $gte: startDate,
                $lte: now
            };
        }

        // ✅ Use aggregation pipeline for better performance
        const pipeline = [
            { $match: matchConditions },
            { $unwind: '$transactions' },
            ...(Object.keys(transactionMatch).length > 0 ? [{ $match: transactionMatch }] : []),
            {
                $lookup: {
                    from: 'users',
                    localField: 'userId',
                    foreignField: '_id',
                    as: 'user'
                }
            },
            { $unwind: '$user' },
            {
                $project: {
                    _id: '$transactions._id',
                    transactionId: '$transactions._id',
                    user: '$user.username',
                    userEmail: '$user.email',
                    userId: '$user._id',
                    walletId: '$_id',
                    type: '$transactions.type',
                    amount: '$transactions.amount',
                    netAmount: '$transactions.netAmount',
                    fee: '$transactions.fee',
                    status: '$transactions.status',
                    paymentMethod: '$transactions.paymentMethod',
                    description: '$transactions.description',
                    createdAt: '$transactions.createdAt',
                    completedAt: '$transactions.completedAt',
                    failedAt: '$transactions.failedAt',
                    external_id: '$transactions.external_id',
                    txid: '$transactions.txid',
                    withdrawalAddress: '$transactions.withdrawalAddress',
                    cryptoType: '$transactions.cryptoType',
                    cryptoAmount: '$transactions.cryptoAmount',
                    cashappTag: '$transactions.cashappTag',
                    cashappName: '$transactions.cashappName',
                    chimeTag: '$transactions.chimeTag',
                    chimeFullName: '$transactions.chimeFullName',
                    isBonus: '$transactions.isBonus',
                    paymentRef: '$transactions.paymentRef',
                    balanceBefore: '$transactions.balanceBefore',
                    balanceAfter: '$transactions.balanceAfter'
                }
            },
            { $sort: { createdAt: -1 } }
        ];

        // Get total count for pagination
        const countPipeline = [
            ...pipeline,
            { $count: 'total' }
        ];

        const [countResult, transactions] = await Promise.all([
            Wallet.aggregate(countPipeline),
            Wallet.aggregate([
                ...pipeline,
                { $skip: skip },
                { $limit: parseInt(limit) }
            ])
        ]);

        const totalTransactions = countResult[0]?.total || 0;

        // ✅ Calculate stats from aggregation (only for filtered results)
        const statsMatch = { ...transactionMatch };
        delete statsMatch['transactions.createdAt']; // Remove date filter for overall stats

        const statsResult = await Wallet.aggregate([
            { $match: matchConditions },
            { $unwind: '$transactions' },
            ...(Object.keys(statsMatch).length > 0 ? [{ $match: statsMatch }] : []),
            {
                $group: {
                    _id: null,
                    totalDeposits: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $eq: ['$transactions.type', 'deposit'] },
                                        { $eq: ['$transactions.status', 'completed'] },
                                        { $ne: ['$transactions.isBonus', true] }
                                    ]
                                },
                                '$transactions.amount',
                                0
                            ]
                        }
                    },
                    totalWithdrawals: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $eq: ['$transactions.type', 'withdrawal'] },
                                        { $eq: ['$transactions.status', 'completed'] }
                                    ]
                                },
                                '$transactions.amount',
                                0
                            ]
                        }
                    },
                    pendingCount: {
                        $sum: {
                            $cond: [{ $eq: ['$transactions.status', 'pending'] }, 1, 0]
                        }
                    },
                    completedCount: {
                        $sum: {
                            $cond: [{ $eq: ['$transactions.status', 'completed'] }, 1, 0]
                        }
                    },
                    failedCount: {
                        $sum: {
                            $cond: [{ $eq: ['$transactions.status', 'failed'] }, 1, 0]
                        }
                    }
                }
            }
        ]);

        const stats = statsResult[0] || {
            totalDeposits: 0,
            totalWithdrawals: 0,
            pendingCount: 0,
            completedCount: 0,
            failedCount: 0
        };

        // Format transactions with additional data
        const formattedTransactions = transactions.map(tx => {
            // Calculate risk level
            let riskLevel = 'low';
            if (tx.amount > 1000) riskLevel = 'high';
            else if (tx.amount > 500) riskLevel = 'medium';
            if (tx.status === 'failed') riskLevel = 'high';
            if (tx.paymentMethod === 'crypto' && tx.amount > 100) riskLevel = 'medium';

            return {
                ...tx,
                riskLevel,
                timeAgo: getTimeAgo(tx.createdAt),
                direction: ['deposit', 'game_withdrawal', 'bonus', 'refund'].includes(tx.type) ? 'in' : 'out'
            };
        });

        res.json({
            success: true,
            data: {
                transactions: formattedTransactions,
                stats,
                pagination: {
                    currentPage: parseInt(page),
                    totalPages: Math.ceil(totalTransactions / parseInt(limit)),
                    totalTransactions,
                    limit: parseInt(limit)
                }
            }
        });

    } catch (error) {
        console.error('Error fetching transactions:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch transactions',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

// ================================
// WITHDRAWAL MANAGEMENT
// ================================

const updateTelegramToCompleted = async (data) => {
    try {
        const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
        const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

        if (!BOT_TOKEN || !CHAT_ID || !data.messageId) {
            console.warn('⚠️  Cannot update Telegram - missing credentials or message_id');
            return;
        }

        const { username, email, amount, fee, netAmount, paymentMethod, transactionId, messageId, txid, details } = data;

        let message = '';
        
        // CRYPTO: Automatically sent through gateway
        if (paymentMethod === 'crypto') {
            message = `
✅ <b>WITHDRAWAL COMPLETED</b>

👤 <b>User:</b> ${username}
💰 <b>Amount:</b> $${amount.toFixed(2)}
💸 <b>Fee:</b> $${fee.toFixed(2)}
💵 <b>Net:</b> $${netAmount.toFixed(2)}
💳 <b>Method:</b> CRYPTO
🆔 <b>ID:</b> <code>${transactionId}</code>`;

            if (details?.cryptoType) {
                message += `\n\n🪙 <b>Type:</b> ${details.cryptoType}`;
            }
            if (details?.withdrawalAddress) {
                message += `\n📍 <b>Address:</b> <code>${details.withdrawalAddress}</code>`;
            }
            if (txid) {
                message += `\n\n🔗 <b>TX Hash:</b>\n<code>${txid}</code>`;
            }
            
            message += `\n\n✅ <b>Status:</b> COMPLETED & SENT
⏰ ${new Date().toLocaleString('en-US', { timeZone: 'UTC' })} UTC`;
        } 
        // CASHAPP/CHIME: Approved but requires manual payment
        else {
            message = `
✅ <b>WITHDRAWAL APPROVED</b>

👤 <b>User:</b> ${username}
💰 <b>Amount:</b> $${amount.toFixed(2)}
💸 <b>Fee:</b> $${fee.toFixed(2)}
💵 <b>Send Amount:</b> $${netAmount.toFixed(2)}
💳 <b>Method:</b> ${paymentMethod.toUpperCase()}
🆔 <b>ID:</b> <code>${transactionId}</code>`;

            if (paymentMethod === 'cashapp' && details?.cashappTag) {
                message += `\n\n💳 <b>CashApp Payment:</b>
🏷️ <b>Send to:</b> ${details.cashappTag}`;
                if (details.cashappName) {
                    message += `\n👤 <b>Name:</b> ${details.cashappName}`;
                }
            } else if (paymentMethod === 'chime' && details?.chimeTag) {
                message += `\n\n💳 <b>Chime Payment:</b>
🏷️ <b>Send to:</b> ${details.chimeTag}
👤 <b>Name:</b> ${details.chimeName}`;
            }
            
            message += `\n\n✅ <b>Status:</b> APPROVED - Send $${netAmount.toFixed(2)} via ${paymentMethod.toUpperCase()}
⏰ ${new Date().toLocaleString('en-US', { timeZone: 'UTC' })} UTC`;
        }

        const url = `https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`;
        
        await axios.post(url, {
            chat_id: CHAT_ID,
            message_id: messageId,
            text: message,
            parse_mode: 'HTML'
        });

        console.log('✅ Telegram message updated to COMPLETED');

    } catch (error) {
        console.error('❌ Error updating Telegram to completed:', error.message);
    }
};

/**
 * Update Telegram message to show withdrawal rejected
 */
const updateTelegramToRejected = async (data) => {
    try {
        const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
        const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

        if (!BOT_TOKEN || !CHAT_ID || !data.messageId) {
            console.warn('⚠️  Cannot update Telegram - missing credentials or message_id');
            return;
        }

        const { username, email, amount, paymentMethod, transactionId, messageId, reason } = data;

        const message = `
❌ <b>WITHDRAWAL REJECTED</b>

👤 <b>User:</b> ${username}
💰 <b>Amount:</b> $${amount.toFixed(2)}
💳 <b>Method:</b> ${paymentMethod.toUpperCase()}
🆔 <b>ID:</b> <code>${transactionId}</code>

${reason ? `📝 <b>Reason:</b> ${reason}\n\n` : ''}❌ <b>Status:</b> REJECTED - Amount Refunded
⏰ ${new Date().toLocaleString('en-US', { timeZone: 'UTC' })} UTC`;

        const url = `https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`;
        
        await axios.post(url, {
            chat_id: CHAT_ID,
            message_id: messageId,
            text: message,
            parse_mode: 'HTML'
        });

        console.log('✅ Telegram message updated to REJECTED');

    } catch (error) {
        console.error('❌ Error updating Telegram to rejected:', error.message);
    }
};

const approveWithdrawal = async (req, res) => {
    try {
        const { walletId, transactionId } = req.body;

        if (!walletId || !transactionId) {
            return res.status(400).json({
                success: false,
                message: 'Wallet ID and Transaction ID are required'
            });
        }

        const wallet = await Wallet.findById(walletId).populate('userId', 'username email');
        if (!wallet) {
            return res.status(404).json({
                success: false,
                message: 'Wallet not found'
            });
        }

        const transaction = wallet.transactions.id(transactionId);
        if (!transaction) {
            return res.status(404).json({
                success: false,
                message: 'Transaction not found'
            });
        }

        if (transaction.type !== 'withdrawal') {
            return res.status(400).json({
                success: false,
                message: 'Only withdrawal transactions can be approved'
            });
        }

        if (transaction.status !== 'pending') {
            return res.status(400).json({
                success: false,
                message: `Transaction is already ${transaction.status}`
            });
        }

        const paymentMethod = transaction.paymentMethod || 'unknown';

        if (paymentMethod === 'crypto') {
            return await processCryptoWithdrawalAdmin(wallet, transaction, req, res);
        } else if (paymentMethod === 'cashapp' || paymentMethod === 'chime') {
            return await approveManualWithdrawal(wallet, transaction, res);
        } else {
            return res.status(400).json({
                success: false,
                message: `Unknown payment method: ${paymentMethod}`
            });
        }

    } catch (error) {
        console.error('Error approving withdrawal:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to approve withdrawal',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

// Replace processCryptoWithdrawalAdmin in adminDataController.js

const processCryptoWithdrawalAdmin = async (wallet, transaction, req, res) => {
    try {
        // ✅ SAVE MESSAGE ID BEFORE PROCESSING (transaction object might change)
        const telegramMessageId = transaction.telegramMessageId;
        
        // Get crypto config
        const cryptoConfig = await PaymentMethod.getConfig('crypto');
        if (!cryptoConfig || !cryptoConfig.gatewayUrl || !cryptoConfig.username || !cryptoConfig.password) {
            return res.status(500).json({
                success: false,
                message: 'Crypto payment gateway not configured properly'
            });
        }

        const { withdrawalAddress, cryptoType, cryptoAmount, amount } = transaction;

        if (!withdrawalAddress || !cryptoType) {
            return res.status(400).json({
                success: false,
                message: 'Missing withdrawal address or crypto type'
            });
        }

        const { processCryptoWithdrawal } = require('./paymentController');
        const finalCryptoAmount = cryptoAmount || amount;

        console.log('🔄 Processing crypto withdrawal via gateway...');
        console.log('   Crypto Type:', cryptoType);
        console.log('   Amount:', finalCryptoAmount);
        console.log('   Address:', withdrawalAddress);

        // Process the withdrawal through the gateway
        const withdrawalResult = await processCryptoWithdrawal(
            finalCryptoAmount,
            cryptoType,
            withdrawalAddress,
            transaction._id
        );

        console.log('✅ Crypto withdrawal processed successfully');
        console.log('   Task ID:', withdrawalResult.task_id);
        console.log('   TX Hash:', withdrawalResult.transaction_hash);

        // Reload wallet to get updated state
        const updatedWallet = await Wallet.findById(wallet._id).populate('userId', 'username email');
        
        // ✅ UPDATE TELEGRAM MESSAGE TO COMPLETED
        console.log('\n📱 Updating Telegram message to COMPLETED...');
        console.log(`   Using message_id: ${telegramMessageId}`);
        
        await updateTelegramToCompleted({
            username: updatedWallet.userId.username,
            email: updatedWallet.userId.email,
            amount: transaction.amount,
            fee: transaction.fee || 0,
            netAmount: transaction.netAmount || transaction.amount,
            paymentMethod: 'crypto',
            transactionId: transaction._id.toString(),
            messageId: telegramMessageId, // ✅ Use saved message_id from before
            txid: withdrawalResult.transaction_hash || withdrawalResult.task_id,
            details: {
                cryptoType: cryptoType,
                withdrawalAddress: withdrawalAddress,
                cryptoAmount: finalCryptoAmount
            }
        });
        
        res.json({
            success: true,
            message: 'Crypto withdrawal processed successfully',
            data: {
                transactionId: transaction._id,
                txid: withdrawalResult.transaction_hash || withdrawalResult.task_id,
                taskId: withdrawalResult.task_id,
                amount: transaction.amount,
                status: 'completed',
                cryptoType: cryptoType,
                withdrawalAddress: withdrawalAddress,
                newPendingBalance: updatedWallet.pendingBalance,
                newAvailableBalance: updatedWallet.availableBalance
            }
        });

    } catch (error) {
        console.error('❌ Error processing crypto withdrawal:', error);
        console.error('   Error message:', error.message);
        console.error('   Error response:', error.response?.data);

        try {
            const freshWallet = await Wallet.findById(wallet._id);
            const freshTransaction = freshWallet.transactions.id(transaction._id);
            
            if (freshTransaction && freshTransaction.status === 'pending') {
                console.log('🔄 Marking transaction as failed and triggering refund...');
                
                const { updateWalletTransactionStatus } = require('./paymentController');
                await updateWalletTransactionStatus(transaction._id, 'failed', {
                    error: error.message,
                    errorResponse: error.response?.data,
                    failedAt: new Date().toISOString()
                });
                
                console.log('✅ Transaction marked as failed and refund completed');
            } else {
                console.log('⚠️  Transaction already processed, skipping refund');
            }
        } catch (updateError) {
            console.error('❌ Error updating transaction status:', updateError);
        }

        res.status(500).json({
            success: false,
            message: 'Failed to process crypto withdrawal',
            error: process.env.NODE_ENV === 'development' 
                ? error.response?.data || error.message 
                : 'Withdrawal processing failed. Amount has been refunded.'
        });
    }
};

// Replace approveManualWithdrawal in adminDataController.js

const approveManualWithdrawal = async (wallet, transaction, res) => {
    try {
        // ✅ SAVE MESSAGE ID AND DETAILS BEFORE UPDATING (in case objects change)
        const telegramMessageId = transaction.telegramMessageId;
        const transactionAmount = transaction.amount;
        const transactionFee = transaction.fee || 0;
        const transactionNetAmount = transaction.netAmount || transaction.amount;
        const transactionPaymentMethod = transaction.paymentMethod;
        const transactionId = transaction._id.toString();
        const cashappTag = transaction.cashappTag;
        const cashappName = transaction.cashappName;
        const chimeTag = transaction.chimeTag;
        const chimeName = transaction.chimeFullName;
        
        wallet.pendingBalance = Math.max(0, wallet.pendingBalance - transaction.amount);
        wallet.balance = Math.max(0, wallet.balance - transaction.amount);
        wallet.updateAvailableBalance();
        
        transaction.status = 'completed';
        transaction.completedAt = new Date();
        transaction.description = `${transaction.paymentMethod} withdrawal - Completed (Manual payment confirmed)`;

        await wallet.save();
        
        // Reload wallet with user info for notification
        const updatedWallet = await Wallet.findById(wallet._id).populate('userId', 'username email');

        // ✅ UPDATE TELEGRAM MESSAGE TO COMPLETED
        console.log('\n📱 Updating Telegram message to APPROVED...');
        console.log(`   Using message_id: ${telegramMessageId}`);
        
        await updateTelegramToCompleted({
            username: updatedWallet.userId.username,
            email: updatedWallet.userId.email,
            amount: transactionAmount,
            fee: transactionFee,
            netAmount: transactionNetAmount,
            paymentMethod: transactionPaymentMethod,
            transactionId: transactionId,
            messageId: telegramMessageId, // ✅ Use saved message_id from before
            details: {
                cashappTag: cashappTag,
                cashappName: cashappName,
                chimeTag: chimeTag,
                chimeName: chimeName
            }
        });

        res.json({
            success: true,
            message: `${transactionPaymentMethod} withdrawal approved successfully`,
            data: {
                transactionId: transactionId,
                amount: transactionAmount,
                status: 'completed',
                paymentMethod: transactionPaymentMethod,
                newPendingBalance: wallet.pendingBalance,
                newAvailableBalance: wallet.availableBalance
            }
        });

    } catch (error) {
        console.error('Error approving manual withdrawal:', error);
        throw error;
    }
};

// Replace rejectWithdrawal in adminDataController.js

const rejectWithdrawal = async (req, res) => {
    try {
        const { walletId, transactionId, reason } = req.body;

        if (!walletId || !transactionId) {
            return res.status(400).json({
                success: false,
                message: 'Wallet ID and Transaction ID are required'
            });
        }

        const wallet = await Wallet.findById(walletId).populate('userId', 'username email');
        if (!wallet) {
            return res.status(404).json({
                success: false,
                message: 'Wallet not found'
            });
        }

        const transaction = wallet.transactions.id(transactionId);
        if (!transaction) {
            return res.status(404).json({
                success: false,
                message: 'Transaction not found'
            });
        }

        if (transaction.type !== 'withdrawal') {
            return res.status(400).json({
                success: false,
                message: 'Only withdrawal transactions can be rejected'
            });
        }

        if (transaction.status !== 'pending') {
            return res.status(400).json({
                success: false,
                message: `Transaction is already ${transaction.status}`
            });
        }

        // ✅ SAVE MESSAGE ID AND DETAILS BEFORE UPDATING
        const telegramMessageId = transaction.telegramMessageId;
        const transactionAmount = transaction.amount;
        const transactionPaymentMethod = transaction.paymentMethod || 'Unknown';
        const transactionIdString = transaction._id.toString();

        wallet.pendingBalance = Math.max(0, wallet.pendingBalance - transaction.amount);
        wallet.updateAvailableBalance();

        transaction.status = 'failed';
        transaction.failedAt = new Date();
        transaction.description = `Withdrawal rejected by admin${reason ? `: ${reason}` : ''}`;

        await wallet.save();

        // ✅ UPDATE TELEGRAM MESSAGE TO REJECTED
        console.log('\n📱 Updating Telegram message to REJECTED...');
        console.log(`   Using message_id: ${telegramMessageId}`);
        
        await updateTelegramToRejected({
            username: wallet.userId.username,
            email: wallet.userId.email,
            amount: transactionAmount,
            paymentMethod: transactionPaymentMethod,
            transactionId: transactionIdString,
            messageId: telegramMessageId, // ✅ Use saved message_id from before
            reason: reason || 'No reason provided'
        });

        res.json({
            success: true,
            message: 'Withdrawal rejected and amount refunded to user',
            data: {
                transactionId: transactionIdString,
                refundedAmount: transactionAmount,
                newBalance: wallet.balance,
                newPendingBalance: wallet.pendingBalance,
                newAvailableBalance: wallet.availableBalance
            }
        });

    } catch (error) {
        console.error('Error rejecting withdrawal:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to reject withdrawal',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

const getTransactionDetails = async (req, res) => {
    try {
        const { transactionId } = req.params;

        const wallet = await Wallet.findOne({
            'transactions._id': transactionId
        }).populate('userId', 'username email createdAt');

        if (!wallet) {
            return res.status(404).json({
                success: false,
                message: 'Transaction not found'
            });
        }

        const transaction = wallet.transactions.id(transactionId);

        res.json({
            success: true,
            data: {
                transaction: {
                    _id: transaction._id,
                    type: transaction.type,
                    amount: transaction.amount,
                    netAmount: transaction.netAmount,
                    fee: transaction.fee || 0,
                    status: transaction.status,
                    paymentMethod: transaction.paymentMethod,
                    description: transaction.description,
                    createdAt: transaction.createdAt,
                    completedAt: transaction.completedAt,
                    failedAt: transaction.failedAt,
                    external_id: transaction.external_id,
                    txid: transaction.txid,
                    withdrawalAddress: transaction.withdrawalAddress,
                    cryptoType: transaction.cryptoType,
                    chimeTag: transaction.chimeTag,
                    paymentRef: transaction.paymentRef
                },
                user: {
                    _id: wallet.userId._id,
                    username: wallet.userId.username,
                    email: wallet.userId.email,
                    memberSince: wallet.userId.createdAt
                },
                wallet: {
                    _id: wallet._id,
                    currentBalance: wallet.balance,
                    availableBalance: wallet.availableBalance,
                    pendingBalance: wallet.pendingBalance
                }
            }
        });

    } catch (error) {
        console.error('Error fetching transaction details:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch transaction details',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

// ================================
// USERS MANAGEMENT
// =================================

const getUsers = async (req, res) => {
    try {
        const { page = 1, limit = 20, search, status } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        // ✅ Build query with IP search support
        let query = {};
        
        if (search) {
            query.$or = [
                { username: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } },
                { 'profile.email': { $regex: search, $options: 'i' } },
                { 'account.signupIP': { $regex: search, $options: 'i' } },
                { 'account.lastLoginIP': { $regex: search, $options: 'i' } }
            ];
        }
        
        if (status && status !== 'all') {
            if (status === 'active') {
                query['account.isActive'] = true;
            } else if (status === 'suspended') {
                query['account.isActive'] = false;
            }
        }

        // ✅ Use aggregation pipeline to join wallet data efficiently
        const pipeline = [
            { $match: query },
            {
                $lookup: {
                    from: 'wallets',
                    localField: '_id',
                    foreignField: 'userId',
                    as: 'wallet'
                }
            },
            {
                $unwind: {
                    path: '$wallet',
                    preserveNullAndEmptyArrays: true
                }
            },
            {
                $project: {
                    username: 1,
                    email: 1,
                    createdAt: 1,
                    account: 1,
                    profile: 1,
                    'wallet.balance': 1,
                    'wallet.availableBalance': 1,
                    'wallet.pendingBalance': 1
                }
            },
            { $sort: { createdAt: -1 } }
        ];

        // Get total count for pagination
        const countPipeline = [
            { $match: query },
            { $count: 'total' }
        ];

        const [countResult, users] = await Promise.all([
            User.aggregate(countPipeline),
            User.aggregate([
                ...pipeline,
                { $skip: skip },
                { $limit: parseInt(limit) }
            ])
        ]);

        const totalUsers = countResult[0]?.total || 0;

        // Format the response
        const usersWithWallets = users.map(user => ({
            ...user,
            wallet: user.wallet ? {
                balance: user.wallet.balance || 0,
                availableBalance: user.wallet.availableBalance || 0,
                pendingBalance: user.wallet.pendingBalance || 0
            } : {
                balance: 0,
                availableBalance: 0,
                pendingBalance: 0
            }
        }));

        res.json({
            success: true,
            data: {
                users: usersWithWallets,
                pagination: {
                    currentPage: parseInt(page),
                    totalPages: Math.ceil(totalUsers / parseInt(limit)),
                    totalUsers,
                    limit: parseInt(limit)
                }
            }
        });

    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch users',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

// ================================
// GAMES MANAGEMENT
// ================================

// ================================
// GAMES MANAGEMENT
// ================================

const getGames = async (req, res) => {
    try {
        const { 
            page = 1, 
            limit = 100, 
            search, 
            status, 
            category,
            sortBy = 'order',
            sortOrder = 'asc' 
        } = req.query;

        const skip = (parseInt(page) - 1) * parseInt(limit);

        // Build query
        let query = {};
        
        if (search) {
            query.$or = [
                { name: { $regex: search, $options: 'i' } },
                { shortcode: { $regex: search, $options: 'i' } },
                { category: { $regex: search, $options: 'i' } }
            ];
        }
        
        if (status && status !== 'all') {
            query.status = status;
        }

        if (category && category !== 'all') {
            query.category = category;
        }

        // Build sort object
        const sort = {};
        sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

        // Fetch games with all fields including images
        const games = await Game.find(query)
            .select('name slug shortcode category status gameUrl downloadUrl image thumbnail agentUsername rating isNew isFeatured order displayName gameType title stats createdAt updatedAt')
            .sort(sort)
            .skip(skip)
            .limit(parseInt(limit))
            .lean();

        // Get game accounts stats for each game
        const gamesWithStats = await Promise.all(
            games.map(async (game) => {
                const GameAccount = require('../models/GameAccount');
                
                const accountStats = await GameAccount.aggregate([
                    { $match: { gameId: game._id } },
                    {
                        $group: {
                            _id: null,
                            totalAccounts: { $sum: 1 },
                            activeAccounts: {
                                $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] }
                            }
                        }
                    }
                ]);

                // Calculate total transactions and volume from wallets
                const wallets = await Wallet.find({
                    'transactions.gameDetails.gameType': game.gameType
                }).lean();

                let totalTransactions = 0;
                let totalVolume = 0;

                wallets.forEach(wallet => {
                    if (wallet.transactions && Array.isArray(wallet.transactions)) {
                        wallet.transactions.forEach(tx => {
                            if (tx.gameDetails?.gameType === game.gameType && 
                                tx.status === 'completed') {
                                totalTransactions++;
                                totalVolume += tx.amount || 0;
                            }
                        });
                    }
                });

                return {
                    ...game,
                    stats: {
                        totalAccounts: accountStats[0]?.totalAccounts || 0,
                        activeAccounts: accountStats[0]?.activeAccounts || 0,
                        totalTransactions: totalTransactions,
                        totalVolume: totalVolume
                    }
                };
            })
        );

        const totalGames = await Game.countDocuments(query);

        // Calculate overall stats
        const overallStats = {
            totalGames: totalGames,
            activeGames: gamesWithStats.filter(g => g.status === 'active').length,
            totalPlayers: gamesWithStats.reduce((sum, g) => sum + (g.stats?.totalAccounts || 0), 0),
            totalRevenue: gamesWithStats.reduce((sum, g) => sum + (g.stats?.totalVolume || 0), 0)
        };

        res.json({
            success: true,
            data: gamesWithStats,
            stats: overallStats,
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(totalGames / parseInt(limit)),
                totalGames,
                limit: parseInt(limit)
            }
        });

    } catch (error) {
        console.error('Error fetching games:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch games',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

// ================================
// WALLET STATISTICS
// ================================

const getWalletStats = async (req, res) => {
    try {
        const wallets = await Wallet.find({}).lean();

        let totalBalance = 0;
        let totalAvailableBalance = 0;
        let totalPendingBalance = 0;
        let activeWallets = 0;
        let totalDeposits = 0;
        let totalWithdrawals = 0;

        wallets.forEach(wallet => {
            totalBalance += wallet.balance || 0;
            totalAvailableBalance += wallet.availableBalance || 0;
            totalPendingBalance += wallet.pendingBalance || 0;
            
            if (wallet.balance > 0) activeWallets++;

            if (wallet.transactions && Array.isArray(wallet.transactions)) {
                wallet.transactions.forEach(tx => {
                    // ✅ FIXED: Only count REAL deposits (isBonus === false)
                    if (tx.type === 'deposit' && tx.status === 'completed' && tx.isBonus === false) {
                        totalDeposits += tx.amount || 0;
                    } else if (tx.type === 'withdrawal' && tx.status === 'completed') {
                        totalWithdrawals += tx.amount || 0;
                    }
                });
            }
        });

        res.json({
            success: true,
            data: {
                totalBalance,
                totalAvailableBalance,
                totalPendingBalance,
                activeWallets,
                totalWallets: wallets.length,
                totalDeposits, // ✅ Now only REAL deposits
                totalWithdrawals,
                netRevenue: totalDeposits - totalWithdrawals
            }
        });

    } catch (error) {
        console.error('Error fetching wallet stats:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch wallet statistics',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

// ================================
// USER WALLET DEBUG
// ================================

const getUserWallet = async (req, res) => {
    try {
        const { userId } = req.params;

        const wallet = await Wallet.findOne({ userId })
            .populate('userId', 'username email createdAt')
            .lean();

        if (!wallet) {
            return res.status(404).json({
                success: false,
                message: 'Wallet not found for this user'
            });
        }

        res.json({
            success: true,
            data: { wallet }
        });

    } catch (error) {
        console.error('Error fetching user wallet:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch user wallet',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

// ================================
// DEBUG UTILITIES
// ================================

const getDebugUsersWithWallets = async (req, res) => {
    try {
        const users = await User.find({})
            .select('username email createdAt account')
            .limit(10)
            .lean();

        const usersWithWallets = await Promise.all(
            users.map(async (user) => {
                const wallet = await Wallet.findOne({ userId: user._id }).lean();
                return {
                    ...user,
                    wallet: wallet ? {
                        balance: wallet.balance,
                        availableBalance: wallet.availableBalance,
                        pendingBalance: wallet.pendingBalance,
                        transactionCount: wallet.transactions?.length || 0
                    } : null
                };
            })
        );

        res.json({
            success: true,
            data: { users: usersWithWallets }
        });

    } catch (error) {
        console.error('Error fetching debug users with wallets:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch debug data',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

// Add this new function to adminDataController.js

const updateUserStatus = async (req, res) => {
    try {
        const { userId } = req.params;
        const { action } = req.body; // 'activate' or 'suspend'

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: 'User ID is required'
            });
        }

        if (!action || !['activate', 'suspend'].includes(action)) {
            return res.status(400).json({
                success: false,
                message: 'Valid action is required (activate or suspend)'
            });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Update user status
        if (!user.account) {
            user.account = {};
        }
        user.account.isActive = action === 'activate';
        await user.save();

        res.json({
            success: true,
            message: `User ${action === 'activate' ? 'activated' : 'suspended'} successfully`,
            data: {
                userId: user._id,
                username: user.username,
                isActive: user.account.isActive
            }
        });

    } catch (error) {
        console.error('Error updating user status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update user status',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};


/**
 * Add bonus to user's wallet (Admin action)
 * POST /api/admin-data/users/:userId/add-bonus
 */
const addBonusToUser = async (req, res) => {
    console.log('\n🎁 ═══════════════════════════════════════════════════');
    console.log('🎁 ADMIN ADD BONUS TO USER');
    console.log('🎁 ═══════════════════════════════════════════════════');
    
    try {
        const { userId } = req.params;
        const { amount, description } = req.body;
        const adminId = req.user.userId; // From auth middleware

        console.log('📋 Request Details:');
        console.log('   User ID:', userId);
        console.log('   Amount:', amount);
        console.log('   Description:', description);
        console.log('   Admin ID:', adminId);

        // Validation
        if (!amount || amount <= 0) {
            console.log('❌ Invalid amount');
            return res.status(400).json({
                success: false,
                message: 'Valid amount is required (must be greater than 0)'
            });
        }

        if (amount > 100000) {
            console.log('❌ Amount exceeds maximum');
            return res.status(400).json({
                success: false,
                message: 'Maximum bonus amount is $100,000'
            });
        }

        // Find user
        const user = await User.findById(userId).select('username email');
        if (!user) {
            console.log('❌ User not found');
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        console.log('✅ User found:', user.username);

        // Find admin user for logging
        const admin = await User.findById(adminId).select('username');
        const adminUsername = admin?.username || 'Admin';

        // Get or create wallet
        const wallet = await Wallet.findOrCreateWallet(userId);

        console.log('\n💰 Wallet State BEFORE:');
        console.log('   Bonus Balance:', wallet.bonusBalance);

        // Add bonus using wallet method
        const transaction = wallet.addBonus(
            amount,
            description || `Admin bonus added by ${adminUsername}`
        );

        // Save wallet
        await wallet.save();

        console.log('\n💰 Wallet State AFTER:');
        console.log('   Bonus Balance:', wallet.bonusBalance);
        console.log('   Transaction ID:', transaction._id);

        console.log('\n✅ Bonus added successfully');
        console.log('🎁 ═══════════════════════════════════════════════════\n');

        res.json({
            success: true,
            message: `Bonus of $${amount.toFixed(2)} added successfully`,
            data: {
                transactionId: transaction._id,
                amount: amount,
                newBonusBalance: wallet.bonusBalance,
                availableBonusBalance: wallet.availableBonusBalance,
                user: {
                    id: user._id,
                    username: user.username,
                    email: user.email
                }
            }
        });

    } catch (error) {
        console.error('\n❌ Error adding bonus:', error);
        console.log('🎁 ═══════════════════════════════════════════════════\n');
        
        res.status(500).json({
            success: false,
            message: 'Failed to add bonus',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

/**
 * Add deposit to user's wallet (Admin action)
 * POST /api/admin-data/users/:userId/add-deposit
 */
const addDepositToUser = async (req, res) => {
    console.log('\n💰 ═══════════════════════════════════════════════════');
    console.log('💰 ADMIN ADD DEPOSIT TO USER');
    console.log('💰 ═══════════════════════════════════════════════════');
    
    try {
        const { userId } = req.params;
        const { amount, description } = req.body;
        const adminId = req.user.userId; // From auth middleware

        console.log('📋 Request Details:');
        console.log('   User ID:', userId);
        console.log('   Amount:', amount);
        console.log('   Description:', description);
        console.log('   Admin ID:', adminId);

        // Validation
        if (!amount || amount <= 0) {
            console.log('❌ Invalid amount');
            return res.status(400).json({
                success: false,
                message: 'Valid amount is required (must be greater than 0)'
            });
        }

        if (amount > 100000) {
            console.log('❌ Amount exceeds maximum');
            return res.status(400).json({
                success: false,
                message: 'Maximum deposit amount is $100,000'
            });
        }

        // Find user
        const user = await User.findById(userId).select('username email');
        if (!user) {
            console.log('❌ User not found');
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        console.log('✅ User found:', user.username);

        // Find admin user for logging
        const admin = await User.findById(adminId).select('username');
        const adminUsername = admin?.username || 'Admin';

        // Get or create wallet
        const wallet = await Wallet.findOrCreateWallet(userId);

        console.log('\n💰 Wallet State BEFORE:');
        console.log('   Balance:', wallet.balance);
        console.log('   Available Balance:', wallet.availableBalance);

        // Add deposit transaction (completed immediately)
        const transaction = wallet.addTransaction({
            type: 'deposit',
            amount: amount,
            description: description || `Admin deposit added by ${adminUsername}`,
            paymentMethod: 'admin_manual',
            status: 'completed',
            fee: 0,
            completedAt: new Date(),
            metadata: {
                addedBy: adminUsername,
                addedByUserId: adminId,
                isAdminDeposit: true,
                timestamp: new Date().toISOString()
            }
        });

        // Save wallet
        await wallet.save();

        console.log('\n💰 Wallet State AFTER:');
        console.log('   Balance:', wallet.balance);
        console.log('   Available Balance:', wallet.availableBalance);
        console.log('   Transaction ID:', transaction._id);

        console.log('\n✅ Deposit added successfully');
        console.log('💰 ═══════════════════════════════════════════════════\n');

        res.json({
            success: true,
            message: `Deposit of $${amount.toFixed(2)} added successfully`,
            data: {
                transactionId: transaction._id,
                amount: amount,
                newBalance: wallet.balance,
                newAvailableBalance: wallet.availableBalance,
                user: {
                    id: user._id,
                    username: user.username,
                    email: user.email
                }
            }
        });

    } catch (error) {
        console.error('\n❌ Error adding deposit:', error);
        console.log('💰 ═══════════════════════════════════════════════════\n');
        
        res.status(500).json({
            success: false,
            message: 'Failed to add deposit',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

/**
 * Redeem/Deduct from user's wallet (Admin action)
 * POST /api/admin-data/users/:userId/redeem
 */
const redeemFromUser = async (req, res) => {
    console.log('\n💸 ═══════════════════════════════════════════════════');
    console.log('💸 ADMIN REDEEM FROM USER');
    console.log('💸 ═══════════════════════════════════════════════════');
    
    try {
        const { userId } = req.params;
        const { amount, description, balanceType } = req.body; // balanceType: 'regular' or 'bonus'
        const adminId = req.user.userId; // From auth middleware

        console.log('📋 Request Details:');
        console.log('   User ID:', userId);
        console.log('   Amount:', amount);
        console.log('   Balance Type:', balanceType || 'regular');
        console.log('   Description:', description);
        console.log('   Admin ID:', adminId);

        // Validation
        if (!amount || amount <= 0) {
            console.log('❌ Invalid amount');
            return res.status(400).json({
                success: false,
                message: 'Valid amount is required (must be greater than 0)'
            });
        }

        if (amount > 100000) {
            console.log('❌ Amount exceeds maximum');
            return res.status(400).json({
                success: false,
                message: 'Maximum redeem amount is $100,000'
            });
        }

        // Validate balance type
        const type = balanceType || 'regular';
        if (!['regular', 'bonus'].includes(type)) {
            return res.status(400).json({
                success: false,
                message: 'Balance type must be "regular" or "bonus"'
            });
        }

        // Find user
        const user = await User.findById(userId).select('username email');
        if (!user) {
            console.log('❌ User not found');
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        console.log('✅ User found:', user.username);

        // Find admin user for logging
        const admin = await User.findById(adminId).select('username');
        const adminUsername = admin?.username || 'Admin';

        // Get or create wallet
        const wallet = await Wallet.findOrCreateWallet(userId);

        console.log('\n💰 Wallet State BEFORE:');
        console.log('   Regular Balance:', wallet.balance);
        console.log('   Bonus Balance:', wallet.bonusBalance);
        console.log('   Available Balance:', wallet.availableBalance);

        // Check if user has sufficient balance
        if (type === 'regular') {
            if (wallet.availableBalance < amount) {
                console.log('❌ Insufficient regular balance');
                return res.status(400).json({
                    success: false,
                    message: `Insufficient balance. User has $${wallet.availableBalance.toFixed(2)} available, but you're trying to redeem $${amount.toFixed(2)}`
                });
            }
        } else {
            // Bonus balance
            if (wallet.bonusBalance < amount) {
                console.log('❌ Insufficient bonus balance');
                return res.status(400).json({
                    success: false,
                    message: `Insufficient bonus balance. User has $${wallet.bonusBalance.toFixed(2)} bonus balance, but you're trying to redeem $${amount.toFixed(2)}`
                });
            }
        }

        // Create redeem transaction
        const balanceBefore = wallet.balance;
        const bonusBalanceBefore = wallet.bonusBalance;

        let balanceAfter = balanceBefore;
        let bonusBalanceAfter = bonusBalanceBefore;

        if (type === 'regular') {
            balanceAfter = Math.max(0, balanceBefore - amount);
            wallet.balance = balanceAfter;
        } else {
            bonusBalanceAfter = Math.max(0, bonusBalanceBefore - amount);
            wallet.bonusBalance = bonusBalanceAfter;
        }

        const transaction = {
            type: 'withdrawal', // Using withdrawal type for redemption
            amount: amount,
            description: description || `Admin redemption by ${adminUsername} from ${type} balance`,
            status: 'completed',
            paymentMethod: 'admin_redeem',
            fee: 0,
            netAmount: amount,
            balanceBefore: balanceBefore,
            balanceAfter: balanceAfter,
            bonusBalanceBefore: bonusBalanceBefore,
            bonusBalanceAfter: bonusBalanceAfter,
            completedAt: new Date(),
            metadata: {
                redeemedBy: adminUsername,
                redeemedByUserId: adminId,
                isAdminRedeem: true,
                balanceType: type,
                timestamp: new Date().toISOString()
            }
        };

        wallet.transactions.push(transaction);
        wallet.updateAvailableBalance();

        // Save wallet
        await wallet.save();

        const savedTransaction = wallet.transactions[wallet.transactions.length - 1];

        console.log('\n💰 Wallet State AFTER:');
        console.log('   Regular Balance:', wallet.balance);
        console.log('   Bonus Balance:', wallet.bonusBalance);
        console.log('   Available Balance:', wallet.availableBalance);
        console.log('   Transaction ID:', savedTransaction._id);

        console.log('\n✅ Redemption successful');
        console.log('💸 ═══════════════════════════════════════════════════\n');

        res.json({
            success: true,
            message: `Successfully redeemed $${amount.toFixed(2)} from ${type} balance`,
            data: {
                transactionId: savedTransaction._id,
                amount: amount,
                balanceType: type,
                newBalance: wallet.balance,
                newBonusBalance: wallet.bonusBalance,
                newAvailableBalance: wallet.availableBalance,
                user: {
                    id: user._id,
                    username: user.username,
                    email: user.email
                }
            }
        });

    } catch (error) {
        console.error('\n❌ Error redeeming from user:', error);
        console.log('💸 ═══════════════════════════════════════════════════\n');
        
        res.status(500).json({
            success: false,
            message: 'Failed to redeem from user',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};



// Add this to get user details
const getUserDetails = async (req, res) => {
    try {
        const { userId } = req.params;
        const mongoose = require('mongoose');
        const User = require('../models/User');
        const Wallet = require('../models/Wallet');
        const GameAccount = require('../models/GameAccount');

        // ✅ Validate ObjectId
        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid user ID'
            });
        }

        // ✅ Use aggregation to fetch user with wallet and stats in one query
        const userResult = await User.aggregate([
            { $match: { _id: new mongoose.Types.ObjectId(userId) } },
            {
                $lookup: {
                    from: 'wallets',
                    localField: '_id',
                    foreignField: 'userId',
                    as: 'wallet'
                }
            },
            {
                $unwind: {
                    path: '$wallet',
                    preserveNullAndEmptyArrays: true
                }
            },
            {
                $project: {
                    username: 1,
                    email: 1,
                    createdAt: 1,
                    account: 1,
                    profile: 1,
                    'wallet._id': 1,
                    'wallet.balance': 1,
                    'wallet.bonusBalance': 1,
                    'wallet.availableBalance': 1,
                    'wallet.availableBonusBalance': 1,
                    'wallet.pendingBalance': 1,
                    'wallet.transactions': 1
                }
            }
        ]);

        if (!userResult || userResult.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        const user = userResult[0];

        // ✅ Calculate stats from wallet transactions (only if wallet exists)
        let stats = {
            totalDeposits: 0,
            totalWithdrawals: 0,
            completedDeposits: 0,
            completedWithdrawals: 0,
            pendingTransactions: 0,
            netAmount: 0,
            gameAccountsCount: 0
        };

        if (user.wallet && user.wallet.transactions) {
            user.wallet.transactions.forEach(tx => {
                if (tx.type === 'deposit') {
                    if (tx.status === 'completed' && !tx.isBonus) {
                        stats.totalDeposits += tx.amount || 0;
                        stats.completedDeposits++;
                    }
                } else if (tx.type === 'withdrawal') {
                    if (tx.status === 'completed') {
                        stats.totalWithdrawals += tx.amount || 0;
                        stats.completedWithdrawals++;
                    } else if (tx.status === 'pending') {
                        stats.pendingTransactions++;
                    }
                }
            });
            stats.netAmount = stats.totalDeposits - stats.totalWithdrawals;
        }

        // ✅ Get game accounts count (separate query, but only count)
        stats.gameAccountsCount = await GameAccount.countDocuments({ 
            userId: new mongoose.Types.ObjectId(userId) 
        });

        // ✅ Get game accounts (only if needed, limited to 10)
        const gameAccounts = await GameAccount.find({ 
            userId: new mongoose.Types.ObjectId(userId) 
        })
            .populate('gameId', 'name slug')
            .limit(10)
            .lean();

        // Format response
        const userResponse = {
            _id: user._id,
            username: user.username,
            email: user.email,
            createdAt: user.createdAt,
            account: user.account,
            profile: user.profile,
            wallet: user.wallet ? {
                balance: user.wallet.balance || 0,
                bonusBalance: user.wallet.bonusBalance || 0,
                availableBalance: user.wallet.availableBalance || 0,
                availableBonusBalance: user.wallet.availableBonusBalance || 0,
                pendingBalance: user.wallet.pendingBalance || 0
            } : {
                balance: 0,
                bonusBalance: 0,
                availableBalance: 0,
                availableBonusBalance: 0,
                pendingBalance: 0
            }
        };

        res.json({
            success: true,
            data: {
                user: userResponse,
                stats,
                gameAccounts
            }
        });

    } catch (error) {
        console.error('Error fetching user details:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch user details',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};


const manualCompleteDeposit = async (req, res) => {
    try {
        const { walletId, transactionId, notes } = req.body;

        // Validation
        if (!walletId || !transactionId) {
            return res.status(400).json({
                success: false,
                message: 'Wallet ID and Transaction ID are required'
            });
        }

        // ✅ Use centralized helper
        const result = await completeDepositWithBonus(walletId, transactionId, {
            completedBy: req.user.username || 'Admin',
            completedByUserId: req.user.userId,
            adminNotes: notes,
            isManual: true
        });

        const responseData = {
            transactionId: transactionId,
            userId: result.wallet.userId,
            amount: result.transaction.amount,
            previousStatus: 'pending',
            newStatus: 'completed',
            paymentMethod: result.transaction.paymentMethod,
            completedBy: req.user.username || 'Admin',
            completedAt: result.transaction.completedAt,
            wallet: result.wallet
        };

        // Add bonus info if applicable
        if (result.bonusInfo) {
            responseData.bonusApplied = result.bonusInfo;
        }

        const message = result.bonusInfo 
            ? `Deposit of $${result.transaction.amount.toFixed(2)} manually completed with ${result.bonusInfo.description} of $${result.bonusInfo.amount.toFixed(2)}!`
            : `Deposit of $${result.transaction.amount.toFixed(2)} manually completed successfully`;

        res.json({
            success: true,
            message,
            data: responseData
        });

    } catch (error) {
        console.error('Error in manualCompleteDeposit:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to manually complete deposit',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};



const getSettings = async (req, res) => {
  try {
    const settings = await Settings.getSettings();
    
    res.json({
      success: true,
      data: settings
    });
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch settings',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

const updateSignupBonus = async (req, res) => {
  try {
    const { amount, enabled } = req.body;
    
    if (amount === undefined || amount < 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid amount is required (must be >= 0)'
      });
    }
    
    const settings = await Settings.getSettings();
    await settings.updateSignupBonus(amount, enabled !== false);
    
    res.json({
      success: true,
      message: 'Signup bonus updated successfully',
      data: {
        signupBonus: settings.signupBonus
      }
    });
  } catch (error) {
    console.error('Error updating signup bonus:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update signup bonus',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

const updateFirstDepositBonus = async (req, res) => {
  try {
    const { percentage, minDeposit, maxBonus, enabled } = req.body;
    
    if (percentage === undefined || percentage < 0 || percentage > 500) {
      return res.status(400).json({
        success: false,
        message: 'Valid percentage is required (0-500%)'
      });
    }
    
    if (minDeposit === undefined || minDeposit < 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid minimum deposit is required'
      });
    }
    
    const settings = await Settings.getSettings();
    await settings.updateFirstDepositBonus(
      percentage, 
      minDeposit, 
      maxBonus || null, 
      enabled !== false
    );
    
    res.json({
      success: true,
      message: 'First deposit bonus updated successfully',
      data: {
        firstDepositBonus: settings.firstDepositBonus
      }
    });
  } catch (error) {
    console.error('Error updating first deposit bonus:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update first deposit bonus',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

const createPromotionalBonus = async (req, res) => {
  try {
    const {
      title,
      description,
      bonusPercentage,
      bonusType,
      startDate,
      endDate,
      minDeposit,
      maxBonus,
      termsAndConditions,
      isVisible
    } = req.body;
    
    if (!title || !bonusPercentage || !startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'Title, bonus percentage, start date, and end date are required'
      });
    }
    
    if (bonusPercentage < 0 || bonusPercentage > 500) {
      return res.status(400).json({
        success: false,
        message: 'Bonus percentage must be between 0 and 500%'
      });
    }
    
    if (new Date(startDate) >= new Date(endDate)) {
      return res.status(400).json({
        success: false,
        message: 'End date must be after start date'
      });
    }
    
    const settings = await Settings.getSettings();
    
    const bonusData = {
      title,
      description: description || '',
      bonusPercentage,
      bonusType: bonusType || 'deposit',
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      minDeposit: minDeposit || 0,
      maxBonus: maxBonus || null,
      termsAndConditions: termsAndConditions || '',
      isVisible: isVisible !== false
    };
    
    await settings.addPromotionalBonus(bonusData);
    
    res.json({
      success: true,
      message: 'Promotional bonus created successfully',
      data: {
        bonus: settings.promotionalBonuses[settings.promotionalBonuses.length - 1]
      }
    });
  } catch (error) {
    console.error('Error creating promotional bonus:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create promotional bonus',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

const updatePromotionalBonus = async (req, res) => {
  try {
    const { bonusId } = req.params;
    const updateData = req.body;
    
    if (!bonusId) {
      return res.status(400).json({
        success: false,
        message: 'Bonus ID is required'
      });
    }
    
    if (updateData.startDate && updateData.endDate) {
      if (new Date(updateData.startDate) >= new Date(updateData.endDate)) {
        return res.status(400).json({
          success: false,
          message: 'End date must be after start date'
        });
      }
    }
    
    const settings = await Settings.getSettings();
    await settings.updatePromotionalBonus(bonusId, updateData);
    
    const updatedBonus = settings.promotionalBonuses.id(bonusId);
    
    res.json({
      success: true,
      message: 'Promotional bonus updated successfully',
      data: {
        bonus: updatedBonus
      }
    });
  } catch (error) {
    console.error('Error updating promotional bonus:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to update promotional bonus',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

const deletePromotionalBonus = async (req, res) => {
  try {
    const { bonusId } = req.params;
    
    if (!bonusId) {
      return res.status(400).json({
        success: false,
        message: 'Bonus ID is required'
      });
    }
    
    const settings = await Settings.getSettings();
    await settings.deletePromotionalBonus(bonusId);
    
    res.json({
      success: true,
      message: 'Promotional bonus deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting promotional bonus:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete promotional bonus',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};


const getActivePromotionalBonus = async (req, res) => {
  try {
    const settings = await Settings.getSettings();
    const activeBonus = settings.getActivePromotionalBonus();
    
    res.json({
      success: true,
      data: {
        activeBonus: activeBonus || null,
        signupBonus: settings.signupBonus,  // ✅ Add signup bonus
        firstDepositBonus: settings.firstDepositBonus
      }
    });
  } catch (error) {
    console.error('Error fetching active promotional bonus:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch active promotional bonus',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

const updateGeneralSettings = async (req, res) => {
  try {
    const { siteName, siteDescription, maintenanceMode, registrationEnabled, emailVerificationRequired } = req.body;
    
    const settings = await Settings.getSettings();
    
    if (siteName !== undefined) settings.general.siteName = siteName;
    if (siteDescription !== undefined) settings.general.siteDescription = siteDescription;
    if (maintenanceMode !== undefined) settings.general.maintenanceMode = maintenanceMode;
    if (registrationEnabled !== undefined) settings.general.registrationEnabled = registrationEnabled;
    if (emailVerificationRequired !== undefined) settings.general.emailVerificationRequired = emailVerificationRequired;
    
    await settings.save();
    
    res.json({
      success: true,
      message: 'General settings updated successfully',
      data: {
        general: settings.general
      }
    });
  } catch (error) {
    console.error('Error updating general settings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update general settings',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Add these functions to adminDataController.js

// ================================
// ANNOUNCEMENT MANAGEMENT
// ================================

const createAnnouncement = async (req, res) => {
  try {
    const {
      title,
      description,
      icon,
      iconColor,
      tag,
      isActive
    } = req.body;
    
    // Validation
    if (!title || !description) {
      return res.status(400).json({
        success: false,
        message: 'Title and description are required'
      });
    }

    if (title.length > 100) {
      return res.status(400).json({
        success: false,
        message: 'Title must be less than 100 characters'
      });
    }

    if (description.length > 250) {
      return res.status(400).json({
        success: false,
        message: 'Description must be less than 250 characters'
      });
    }
    
    const settings = await Settings.getSettings();
    
    const announcementData = {
      title: title.trim(),
      description: description.trim(),
      icon: icon || 'card',
      iconColor: iconColor || 'purple',
      tag: tag || { label: '', color: 'yellow' },
      isActive: isActive !== false
    };
    
    await settings.addAnnouncement(announcementData);
    
    res.json({
      success: true,
      message: 'Announcement created successfully',
      data: {
        announcement: settings.announcements[settings.announcements.length - 1]
      }
    });
  } catch (error) {
    console.error('Error creating announcement:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create announcement',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

const updateAnnouncement = async (req, res) => {
  try {
    const { announcementId } = req.params;
    const updateData = req.body;
    
    if (!announcementId) {
      return res.status(400).json({
        success: false,
        message: 'Announcement ID is required'
      });
    }

    // Validation
    if (updateData.title && updateData.title.length > 100) {
      return res.status(400).json({
        success: false,
        message: 'Title must be less than 100 characters'
      });
    }

    if (updateData.description && updateData.description.length > 250) {
      return res.status(400).json({
        success: false,
        message: 'Description must be less than 250 characters'
      });
    }
    
    const settings = await Settings.getSettings();
    
    // Trim strings if present
    if (updateData.title) updateData.title = updateData.title.trim();
    if (updateData.description) updateData.description = updateData.description.trim();
    if (updateData.tag?.label) updateData.tag.label = updateData.tag.label.trim();
    
    await settings.updateAnnouncement(announcementId, updateData);
    
    const updatedAnnouncement = settings.announcements.id(announcementId);
    
    res.json({
      success: true,
      message: 'Announcement updated successfully',
      data: {
        announcement: updatedAnnouncement
      }
    });
  } catch (error) {
    console.error('Error updating announcement:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to update announcement',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

const deleteAnnouncement = async (req, res) => {
  try {
    const { announcementId } = req.params;
    
    if (!announcementId) {
      return res.status(400).json({
        success: false,
        message: 'Announcement ID is required'
      });
    }
    
    const settings = await Settings.getSettings();
    await settings.deleteAnnouncement(announcementId);
    
    res.json({
      success: true,
      message: 'Announcement deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting announcement:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete announcement',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

const getActiveAnnouncements = async (req, res) => {
  try {
    const settings = await Settings.getSettings();
    const activeAnnouncements = settings.getActiveAnnouncements();
    
    res.json({
      success: true,
      data: {
        announcements: activeAnnouncements
      }
    });
  } catch (error) {
    console.error('Error fetching active announcements:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch active announcements',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};


// Don't forget to export these new functions
module.exports = {
    getStats,
    getChartData,
    getTransactions,
    approveWithdrawal,
    rejectWithdrawal,
    getTransactionDetails,
    updateUserStatus, // ✅ Add this
    getUserDetails,   // ✅ Add this
    addBonusToUser,
    addDepositToUser,
    redeemFromUser,
    manualCompleteDeposit,

    // Existing exports
    getUsers,
    getGames,
    getWalletStats,
    getUserWallet,
    getDebugUsersWithWallets,

    getSettings,
  updateSignupBonus,
  updateFirstDepositBonus,
  createPromotionalBonus,
  updatePromotionalBonus,
  deletePromotionalBonus,
  getActivePromotionalBonus,
  updateGeneralSettings,
    createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  getActiveAnnouncements
};

