// controllers/paymentController.js
const axios = require('axios');
const https = require('https');
const PaymentMethod = require('../models/PaymentMethod');
const Settings = require('../models/Settings');
const UserChimeDetails = require('../models/UserChimeDetails');
const Wallet = require('../models/Wallet');
const mailTmService = require('../services/mailTmService');
const cashAppPollingService = require('../services/cashAppPollingService');
const { makeAuthenticatedRequest } = require('../helpers/cashappAuthHelper');
const { completeDepositWithBonus } = require('../helpers/depositHelper');


// ================================
// CRYPTO PAYMENT METHODS
// ================================

// Get list of available cryptocurrencies
const getCryptoList = async (req, res) => {
    try {
        const cryptoConfig = await PaymentMethod.getConfig('crypto');
        
        if (!cryptoConfig || !cryptoConfig.gatewayUrl) {
            return res.status(500).json({
                success: false,
                message: 'Crypto payment gateway not configured'
            });
        }

        const response = await axios.get(`${cryptoConfig.gatewayUrl}/api/v1/crypto`);
        
        res.json({
            success: true,
            message: 'Crypto list retrieved successfully',
            data: response.data
        });

    } catch (error) {
        console.error('Error fetching crypto list:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch cryptocurrency list',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

// Create crypto payment request
const createPaymentRequest = async (req, res) => {
    try {
        const { cryptoType, amount, fiat = 'USD' } = req.body;
        const userId = req.user.userId;

        // Validation
        if (!cryptoType) {
            return res.status(400).json({
                success: false,
                message: 'Cryptocurrency type is required'
            });
        }

        if (!amount || amount <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Valid amount is required (must be greater than 0)'
            });
        }

        if (amount < 5) {
            return res.status(400).json({
                success: false,
                message: 'Minimum deposit amount is $5'
            });
        }

        if (amount > 10000) {
            return res.status(400).json({
                success: false,
                message: 'Maximum deposit amount is $10,000'
            });
        }

        // Get crypto config from database
        const cryptoConfig = await PaymentMethod.getConfig('crypto');

        // Generate unique external ID
        const externalId = parseInt(`${userId.toString().slice(-6)}${Date.now().toString().slice(-6)}`);

        // Create payment request with gateway
        const paymentResponse = await axios.post(
            `${cryptoConfig.gatewayUrl}/api/v1/${cryptoType}/payment_request`,
            {
                external_id: externalId,
                fiat: fiat,
                amount: amount.toString(),
                callback_url: cryptoConfig.callbackUrl
            },
            {
                headers: {
                    'X-Shkeeper-Api-Key': cryptoConfig.apiKey,
                    'Content-Type': 'application/json'
                }
            }
        );

        // Create pending transaction
        const wallet = await Wallet.findOrCreateWallet(userId);
        const transaction = wallet.addTransaction({
            type: 'deposit',
            amount: parseFloat(amount),
            description: `${cryptoType} deposit - Pending payment`,
            paymentMethod: 'crypto',
            status: 'pending',
            external_id: externalId.toString(),
            fee: 0
        });
        
        await wallet.save();

        const gatewayData = paymentResponse.data;
        const expirationTime = new Date();
        expirationTime.setHours(expirationTime.getHours() + 1);

        const formattedResponse = {
            id: gatewayData.id || externalId.toString(),
            external_id: externalId,
            wallet: gatewayData.wallet,
            amount: gatewayData.amount,
            fiat_amount: amount.toString(),
            fiat: fiat,
            status: gatewayData.status || 'pending',
            callback_url: cryptoConfig.callbackUrl,
            created_at: new Date().toISOString(),
            expired_at: expirationTime.toISOString(),
            display_name: gatewayData.display_name,
            exchange_rate: gatewayData.exchange_rate,
            requestedAmount: amount,
            cryptoType: cryptoType,
            qr_code: gatewayData.qr_code || null,
            payment_url: gatewayData.payment_url || null,
            transactionId: transaction._id
        };

        res.json({
            success: true,
            message: 'Payment request created successfully',
            data: formattedResponse
        });

    } catch (error) {
        console.error('Error creating payment request:', error.response?.data || error.message);
        
        if (error.response?.status === 400) {
            return res.status(400).json({
                success: false,
                message: error.response.data?.message || 'Invalid payment request parameters'
            });
        }

        if (error.response?.status === 401) {
            return res.status(500).json({
                success: false,
                message: 'Payment gateway authentication failed'
            });
        }

        res.status(500).json({
            success: false,
            message: 'Failed to create payment request',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

// Handle payment confirmation webhook
// Handle payment confirmation webhook
const confirmPayment = async (req, res) => {
    try {
        const paymentData = req.body;

        const { 
            external_id, 
            crypto, 
            addr, 
            fiat, 
            balance_fiat, 
            balance_crypto, 
            paid, 
            status, 
            transactions,
            fee_percent,
            overpaid_fiat 
        } = paymentData;

        if (!external_id) {
            return res.status(400).json({
                success: false,
                message: 'External ID is required'
            });
        }

        const lastTransaction = transactions && transactions.length > 0 
            ? transactions[transactions.length - 1] 
            : null;
        
        const transactionHash = lastTransaction ? lastTransaction.txid : null;
        
        if (!transactionHash) {
            return res.status(400).json({
                success: false,
                message: 'Transaction hash is required'
            });
        }

        if (status === 'PAID' && paid === true) {
            const depositAmount = parseFloat(balance_fiat);
            const cryptoAmount = lastTransaction ? lastTransaction.amount_crypto : balance_crypto;
            const feeAmount = lastTransaction ? parseFloat(lastTransaction.fee_fiat) : 0;
            
            try {
                const existingWallet = await Wallet.findOne({
                    'transactions.txid': transactionHash,
                    'transactions.status': 'completed'
                });

                if (existingWallet) {
                    return res.status(200).json({
                        success: true,
                        message: 'Transaction already completed with this txid',
                        duplicate: true,
                        txid: transactionHash,
                        existing_transaction: true
                    });
                }

                const walletWithPendingTransaction = await Wallet.findOne({
                    'transactions.external_id': external_id.toString(),
                    'transactions.paymentMethod': 'crypto',
                    'transactions.status': 'pending'
                });

                if (walletWithPendingTransaction) {
                    const pendingTransactions = walletWithPendingTransaction.transactions.filter(t => 
                        t.external_id === external_id.toString() &&
                        t.paymentMethod === 'crypto' && 
                        t.status === 'pending'
                    ).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
                    
                    if (pendingTransactions.length > 0) {
                        const pendingTransaction = pendingTransactions[0];
                        
                        const transactionNotes = {
                            crypto: crypto,
                            address: addr,
                            cryptoAmount: cryptoAmount,
                            transactionHash: transactionHash,
                            feeAmount: feeAmount,
                            overpaid: overpaid_fiat,
                            external_id: external_id,
                            processed_at: new Date().toISOString(),
                            webhook_amount: depositAmount,
                            original_amount: pendingTransaction.amount
                        };
                        
                        // ✅ Use centralized helper for deposit completion with bonus
                        const { completeDepositWithBonus } = require('../helpers/depositHelper');
                        
                        const result = await completeDepositWithBonus(
                            walletWithPendingTransaction._id,
                            pendingTransaction._id,
                            {
                                completedBy: 'Crypto Gateway',
                                isManual: false,
                                metadata: transactionNotes
                            }
                        );
                        
                        // Update crypto-specific fields
                        const updatedWallet = await Wallet.findById(walletWithPendingTransaction._id);
                        const updatedTransaction = updatedWallet.transactions.id(pendingTransaction._id);
                        updatedTransaction.txid = transactionHash;
                        updatedTransaction.description = `${crypto} deposit - ${addr} (${cryptoAmount} ${crypto}) - TX: ${transactionHash}`;
                        await updatedWallet.save();
                        
                        res.status(200).json({
                            success: true,
                            message: 'Payment confirmed and wallet transaction updated',
                            data: {
                                userId: walletWithPendingTransaction.userId,
                                transactionId: pendingTransaction._id,
                                originalAmount: pendingTransaction.amount,
                                webhookAmount: depositAmount,
                                crypto,
                                transactionHash,
                                status: 'completed',
                                external_id: external_id,
                                bonusApplied: result.bonusInfo || null
                            }
                        });
                        
                    } else {
                        throw new Error(`No pending crypto transaction found matching external_id ${external_id}`);
                    }
                } else {
                    res.status(200).json({
                        success: true,
                        message: 'No matching pending transaction found',
                        info: 'This might be a webhook for a transaction not initiated through our system',
                        external_id: external_id,
                        txid: transactionHash,
                        amount: depositAmount
                    });
                }
                
            } catch (error) {
                console.error('Error updating wallet transaction:', error);
                
                res.status(500).json({
                    success: false,
                    message: 'Payment confirmed but failed to update wallet transaction',
                    error: error.message
                });
            }
            
        } else if (status === 'FAILED' || status === 'EXPIRED' || status === 'CANCELLED') {
            try {
                const walletWithPendingTransaction = await Wallet.findOne({
                    'transactions.external_id': external_id.toString(),
                    'transactions.paymentMethod': 'crypto',
                    'transactions.status': 'pending'
                });

                if (walletWithPendingTransaction) {
                    const pendingTransactions = walletWithPendingTransaction.transactions.filter(t => 
                        t.external_id === external_id.toString() &&
                        t.paymentMethod === 'crypto' && 
                        t.status === 'pending'
                    ).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
                    
                    if (pendingTransactions.length > 0) {
                        const pendingTransaction = pendingTransactions[0];
                        
                        walletWithPendingTransaction.updateTransactionStatus(
                            pendingTransaction._id, 
                            'failed', 
                            `Payment ${status.toLowerCase()}: ${external_id}`
                        );
                        
                        pendingTransaction.txid = transactionHash;
                        await walletWithPendingTransaction.save();
                    }
                }
            } catch (error) {
                console.error('Error updating failed transaction:', error);
            }
            
            res.status(200).json({
                success: true,
                message: 'Payment status updated - failed/expired',
                txid: transactionHash,
                external_id: external_id
            });
        } else {
            res.status(200).json({
                success: true,
                message: 'Payment status received',
                status,
                txid: transactionHash,
                external_id: external_id
            });
        }

    } catch (error) {
        console.error('Error processing payment webhook:', error);
        res.status(500).json({
            success: false,
            message: 'Error processing payment confirmation'
        });
    }
};

// Fixed processCryptoWithdrawal function for paymentController.js
// Replace the existing processCryptoWithdrawal function with this version

const processCryptoWithdrawal = async (cryptoAmount, cryptoType, destination, walletTransactionId) => {
    try {
        console.log('🔄 Starting crypto withdrawal processing...');
        console.log('   Crypto Type:', cryptoType);
        console.log('   Amount:', cryptoAmount);
        console.log('   Destination:', destination);
        console.log('   Transaction ID:', walletTransactionId);

        // Get crypto config from database
        const cryptoConfig = await PaymentMethod.getConfig('crypto');

        const authString = `${cryptoConfig.username}:${cryptoConfig.password}`;
        const encodedAuth = Buffer.from(authString).toString('base64');

        let fee;
        let decimalPlaces;
        
        switch (cryptoType.toUpperCase()) {
            case 'BTC':
                fee = "20";
                decimalPlaces = 8;
                break;
            case 'LTC':
                fee = "100";
                decimalPlaces = 8;
                break;
            case 'DOGE':
                fee = "100";
                decimalPlaces = 8;
                break;
            case 'ETH':
                fee = "10";
                decimalPlaces = 18;
                break;
            case 'XMR':
                fee = "2";
                decimalPlaces = 12;
                break;
            case 'ADA':
                fee = "10";
                decimalPlaces = 6;
                break;
            case 'DOT':
                fee = "10";
                decimalPlaces = 10;
                break;
            case 'BCH':
                fee = "10";
                decimalPlaces = 8;
                break;
            default:
                fee = "10";
                decimalPlaces = 8;
                break;
        }

        const formattedAmount = parseFloat(cryptoAmount).toFixed(decimalPlaces);
        const finalAmount = parseFloat(formattedAmount);

        console.log('   Formatted Amount:', formattedAmount);
        console.log('   Final Amount:', finalAmount);
        console.log('   Fee:', fee);
        console.log('   Decimal Places:', decimalPlaces);

        if (finalAmount <= 0) {
            throw new Error(`Invalid crypto amount after formatting: ${finalAmount}`);
        }

        const payoutData = {
            amount: finalAmount,
            destination: destination,
            fee: fee
        };

        console.log('📡 Sending payout request to gateway...');
        console.log('   Gateway URL:', `${cryptoConfig.gatewayUrl}/api/v1/${cryptoType}/payout`);
        console.log('   Payout Data:', JSON.stringify(payoutData, null, 2));

        const payoutResponse = await axios.post(
            `${cryptoConfig.gatewayUrl}/api/v1/${cryptoType}/payout`,
            payoutData,
            {
                headers: {
                    'Authorization': `Basic ${encodedAuth}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );

        console.log('✅ Gateway Response Received');
        console.log('   Status:', payoutResponse.status);
        console.log('   Full Response:', JSON.stringify(payoutResponse.data, null, 2));

        // ✅ Check for errors in response (multiple formats)
        if (payoutResponse.data.error && payoutResponse.data.error !== null) {
            const errorMsg = typeof payoutResponse.data.error === 'object' 
                ? (payoutResponse.data.error.message || JSON.stringify(payoutResponse.data.error))
                : payoutResponse.data.error;
            throw new Error(`Gateway error: ${errorMsg}`);
        }

        // ✅ Check if response indicates error status
        if (payoutResponse.data.status === 'error') {
            throw new Error(`Gateway error: ${payoutResponse.data.message || 'Unknown error'}`);
        }

        // ✅ Check for authentication errors
        if (payoutResponse.data.message && 
            (payoutResponse.data.message.includes('Bad HTTP Basic Auth') || 
             payoutResponse.data.message.includes('credentials') ||
             payoutResponse.data.message.includes('authentication') ||
             payoutResponse.data.message.includes('unauthorized'))) {
            throw new Error(`Gateway authentication failed: ${payoutResponse.data.message}`);
        }

        // ✅ IMPROVED: Extract task_id from various possible response structures
        let task_id = null;
        
        // Try different possible locations for task_id
        if (payoutResponse.data.result) {
            task_id = payoutResponse.data.result;
        } else if (payoutResponse.data.task_id) {
            task_id = payoutResponse.data.task_id;
        } else if (payoutResponse.data.data && payoutResponse.data.data.task_id) {
            task_id = payoutResponse.data.data.task_id;
        } else if (payoutResponse.data.data && payoutResponse.data.data.result) {
            task_id = payoutResponse.data.data.result;
        } else if (payoutResponse.data.txid) {
            task_id = payoutResponse.data.txid;
        } else if (payoutResponse.data.transaction_hash) {
            task_id = payoutResponse.data.transaction_hash;
        }

        console.log('🔍 Extracted task_id:', task_id);

        if (!task_id) {
            console.error('❌ No task ID found in response');
            console.error('   Full response data:', JSON.stringify(payoutResponse.data, null, 2));
            
            // If the response indicates success but no task_id, use a generated ID
            if (payoutResponse.status === 200 && !payoutResponse.data.error) {
                console.warn('⚠️  Gateway returned success but no task_id, generating fallback ID');
                task_id = `MANUAL_${Date.now()}_${cryptoType}_${destination.substring(0, 8)}`;
                console.log('   Generated fallback task_id:', task_id);
            } else {
                throw new Error('No task ID received from payment gateway. Response: ' + JSON.stringify(payoutResponse.data));
            }
        }

        console.log('💾 Updating wallet transaction status...');

        await updateWalletTransactionStatus(walletTransactionId, 'completed', {
            cryptoTxHash: task_id,
            cryptoAddress: destination,
            cryptoAmount: finalAmount,
            originalCryptoAmount: cryptoAmount,
            cryptoType: cryptoType,
            processedAt: new Date().toISOString(),
            gatewayResponse: payoutResponse.data,
            gatewayStatus: payoutResponse.status
        });

        console.log('✅ Crypto withdrawal processed successfully');
        console.log('   Task ID:', task_id);

        return {
            success: true,
            task_id,
            transaction_hash: task_id,
            status: 'completed',
            message: 'Payment has been processed successfully. You will receive it in your wallet shortly.'
        };

    } catch (error) {
        console.error('❌ Error processing crypto withdrawal:', error);
        
        if (error.response) {
            console.error('   Gateway response status:', error.response.status);
            console.error('   Gateway response data:', JSON.stringify(error.response.data, null, 2));
            console.error('   Gateway response headers:', JSON.stringify(error.response.headers, null, 2));
        } else if (error.request) {
            console.error('   No response received from gateway');
            console.error('   Request details:', error.request);
        } else {
            console.error('   Error setting up request:', error.message);
        }
        
        throw error;
    }
};


const updateWalletTransactionStatus = async (transactionId, status, metadata = {}) => {
    try {
        console.log('\n🔄 ====== UPDATE WALLET TRANSACTION STATUS ======');
        
        const wallet = await Wallet.findOne({
            'transactions._id': transactionId
        });

        if (!wallet) {
            console.log('⚠️  Wallet not found for transaction:', transactionId);
            return null;
        }

        const transaction = wallet.transactions.id(transactionId);
        
        if (!transaction) {
            console.log('⚠️  Transaction not found:', transactionId);
            return null;
        }
        
        const oldStatus = transaction.status;
        const transactionAmount = transaction.amount;
        const transactionType = transaction.type;
        
        console.log('📝 Transaction Details:');
        console.log('   Transaction ID:', transactionId);
        console.log('   Old Status:', oldStatus);
        console.log('   New Status:', status);
        console.log('   Type:', transactionType);
        console.log('   Amount:', transactionAmount);
        
        // Only update if status is actually changing
        if (oldStatus === status) {
            console.log('⚠️  Status unchanged, skipping balance updates');
            transaction.notes = JSON.stringify(metadata);
            await wallet.save();
            return transaction;
        }
        
        console.log('\n💰 Balance State BEFORE Update:');
        console.log('   Balance:', wallet.balance);
        console.log('   Bonus Balance:', wallet.bonusBalance);
        console.log('   Available:', wallet.availableBalance);
        console.log('   Pending:', wallet.pendingBalance);
        
        // ✅✅✅ FOR DEPOSIT COMPLETION - USE HELPER
        if (status === 'completed' && transactionType === 'deposit' && oldStatus === 'pending') {
            console.log('✅ Deposit completed - using centralized helper for bonus logic');
            
            try {
                // Use the centralized helper
                const result = await completeDepositWithBonus(wallet._id, transactionId, {
                    completedBy: 'Payment Gateway',
                    isManual: false,
                    metadata: metadata
                });
                
                console.log('✅ Deposit completion with bonus applied successfully');
                if (result.bonusInfo) {
                    console.log(`🎁 Bonus applied: $${result.bonusInfo.amount}`);
                }
                
                return result.transaction;
                
            } catch (helperError) {
                console.error('❌ Error in deposit helper, falling back to basic completion:', helperError);
                // Fallback: just mark as completed without bonus
                transaction.status = 'completed';
                transaction.completedAt = new Date();
                transaction.notes = JSON.stringify(metadata);
                wallet.balance += transactionAmount;
                wallet.updateAvailableBalance();
                await wallet.save();
                return transaction;
            }
        }
        
        // Handle other status changes (non-deposit or non-completion)
        transaction.status = status;
        transaction.notes = JSON.stringify(metadata);
        
        if (status === 'completed') {
            transaction.completedAt = new Date();
            
            // WITHDRAWAL: When completed, remove from pending and balance
            if (transactionType === 'withdrawal') {
                console.log('✅ Withdrawal completed - removing from pending and balance');
                wallet.pendingBalance = Math.max(0, wallet.pendingBalance - transactionAmount);
                wallet.balance = Math.max(0, wallet.balance - transactionAmount);
            }
        }
        
        // Handle failed transactions
        if (status === 'failed') {
            transaction.failedAt = new Date();
            
            if (transactionType === 'withdrawal' && oldStatus === 'pending') {
                console.log('💰 Withdrawal failed - UNLOCKING from pending');
                wallet.pendingBalance = Math.max(0, wallet.pendingBalance - transactionAmount);
            }
        }
        
        // Recalculate available balance
        wallet.updateAvailableBalance();
        
        await wallet.save();
        
        console.log('\n💰 Balance State AFTER Update:');
        console.log('   Balance:', wallet.balance);
        console.log('   Bonus Balance:', wallet.bonusBalance);
        console.log('   Available:', wallet.availableBalance);
        console.log('   Pending:', wallet.pendingBalance);
        console.log('✅ Transaction status updated successfully');
        console.log('🔄 ========================================\n');
        
        return transaction;
    } catch (error) {
        console.error('❌ Error updating wallet transaction:', error);
        throw error;
    }
};


// controllers/paymentController.js

const createCashappPaymentRequest = async (req, res) => {
    try {
        const { amount } = req.body;
        const userId = req.user.userId;

        console.log('💳 Creating CashApp payment request...');
        console.log('   Amount:', amount);
        console.log('   User ID:', userId);

        // Validation
        if (!amount || amount <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Valid amount is required (must be greater than 0)'
            });
        }

        if (amount < 5) {
            return res.status(400).json({
                success: false,
                message: 'Minimum deposit amount is $5'
            });
        }

        if (amount > 10000) {
            return res.status(400).json({
                success: false,
                message: 'Maximum deposit amount is $10,000'
            });
        }

        // Get cashapp config from database
        const cashappConfig = await PaymentMethod.getConfig('cashapp');

        // Validate required config fields
        if (!cashappConfig.apiUrl || !cashappConfig.username || !cashappConfig.password) {
            return res.status(500).json({
                success: false,
                message: 'CashApp payment gateway not properly configured. Please contact support.'
            });
        }

        // Adjust amount (subtract 0.01 for integers)
        let adjustedAmount = amount;
        if (Number.isInteger(amount)) {
            adjustedAmount = amount - 0.01;
        }

        const amountInCents = Math.round(adjustedAmount * 100);

        console.log('   Amount in cents:', amountInCents);

        // Prepare request data
        const requestData = {
            mchNo: cashappConfig.mchNo,
            currCode: cashappConfig.currCode,
            wayCode: cashappConfig.wayCode,
            amount: amountInCents.toString()
        };

        console.log('📡 Making request to /order/handOrder...');

        // Make authenticated request with auto token refresh
        let paymentResponse;
        try {
            paymentResponse = await makeAuthenticatedRequest(
                '/order/handOrder',
                requestData,
                cashappConfig
            );
        } catch (error) {
            console.error('❌ CashApp gateway request failed:', error.message);
            
            if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
                return res.status(504).json({
                    success: false,
                    message: 'Payment gateway request timed out. Please try again.'
                });
            }

            if (error.response) {
                if (error.response.status >= 500) {
                    return res.status(502).json({
                        success: false,
                        message: 'Payment gateway is currently unavailable. Please try again later.'
                    });
                }

                return res.status(500).json({
                    success: false,
                    message: error.response.data?.message || 'Payment gateway error occurred',
                    error: process.env.NODE_ENV === 'development' ? error.response.data : undefined
                });
            } else if (error.request) {
                return res.status(503).json({
                    success: false,
                    message: 'Unable to connect to payment gateway. Please try again.'
                });
            }

            return res.status(500).json({
                success: false,
                message: 'Failed to create payment request',
                error: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }

        // Validate response
        if (paymentResponse.status !== 200) {
            return res.status(500).json({
                success: false,
                message: `Payment gateway error: Received status ${paymentResponse.status}`,
                error: process.env.NODE_ENV === 'development' ? paymentResponse.data : undefined
            });
        }

        if (paymentResponse.data && paymentResponse.data.code !== 200 && paymentResponse.data.code !== '0') {
            return res.status(400).json({
                success: false,
                message: paymentResponse.data.message || 'Payment gateway returned an error',
                error: process.env.NODE_ENV === 'development' ? paymentResponse.data : undefined
            });
        }

        // Parse response data
        let parsedData = null;
        let cashierUrl = null;
        let payOrderNo = null;
        let mchOrderNo = null;
        let expireTimestamp = null;

        if (paymentResponse.data && paymentResponse.data.data && paymentResponse.data.data.data) {
            try {
                parsedData = JSON.parse(paymentResponse.data.data.data);
                cashierUrl = parsedData.cashierUrl;
                payOrderNo = parsedData.payOrderNo;
                mchOrderNo = parsedData.mchOrderNo;
                expireTimestamp = parsedData.expireTimestamp;
            } catch (parseError) {
                console.error('Error parsing gateway data:', parseError);
            }
        }

        if (!cashierUrl) {
            return res.status(500).json({
                success: false,
                message: 'Payment gateway did not return a payment URL. Please try again.',
                error: process.env.NODE_ENV === 'development' ? 'Missing cashierUrl in response' : undefined
            });
        }

        if (!payOrderNo) {
            return res.status(500).json({
                success: false,
                message: 'Payment gateway did not return an order number. Please try again.',
                error: process.env.NODE_ENV === 'development' ? 'Missing payOrderNo in response' : undefined
            });
        }

        console.log('✅ CashApp payment request created successfully');
        console.log('   Pay Order No:', payOrderNo);

        // Create transaction in wallet
        const externalId = `cashapp_${userId}_${Date.now()}`;

        const wallet = await Wallet.findOrCreateWallet(userId);
        const transaction = wallet.addTransaction({
            type: 'deposit',
            amount: parseFloat(amount),
            description: `Cashapp deposit - Pending payment`,
            paymentMethod: 'cashapp',
            status: 'pending',
            external_id: externalId,
            fee: 0
        });
        
        await wallet.save();

        console.log('   Transaction ID:', transaction._id);

        // ✅ AUTO-START POLLING HERE
        const createTime = new Date(transaction.createdAt).toISOString().split('T')[0];
        
        console.log('🔄 Starting automatic polling for payment verification...');
        console.log('   Transaction ID:', transaction._id.toString());
        console.log('   Pay Order No:', payOrderNo);
        console.log('   Create Time:', createTime);
        
        // Start polling in background (non-blocking)
        const cashAppPollingService = require('../services/cashAppPollingService');
        cashAppPollingService.startPolling(
            userId, 
            transaction._id.toString(), 
            payOrderNo, 
            createTime
        ).catch(error => {
            console.error('❌ Error starting CashApp polling:', error);
            // Don't fail the request if polling fails to start
            // The cleanup job will handle timeout after 1 hour
        });
        
        console.log('✅ CashApp polling started successfully (running in background)');

        // Prepare response
        const formattedResponse = {
            success: true,
            external_id: externalId,
            transactionId: transaction._id,
            amount: amount,
            adjustedAmount: adjustedAmount,
            amountInCents: amountInCents,
            paymentMethod: 'cashapp',
            status: 'pending',
            cashierUrl: cashierUrl,
            payOrderNo: payOrderNo,
            mchOrderNo: mchOrderNo,
            expireTimestamp: expireTimestamp,
            gatewayResponse: paymentResponse.data,
            created_at: new Date().toISOString(),
            pollingStatus: 'active', // Indicate polling is active
            pollingInfo: {
                maxAttempts: 120,
                intervalSeconds: 30,
                estimatedCompletionTime: '1 hour'
            }
        };

        res.json({
            success: true,
            message: 'Cashapp payment request created successfully. Payment verification started automatically.',
            data: formattedResponse
        });

    } catch (error) {
        console.error('❌ Error creating cashapp payment request:', error.message);
        
        res.status(500).json({
            success: false,
            message: 'Failed to create cashapp payment request',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

const cashappProxy = async (req, res) => {
    try {
        let { url } = req.query;

        if (!url) {
            return res.status(400).json({
                success: false,
                message: 'URL parameter is required',
            });
        }

        const agent = new https.Agent({ rejectUnauthorized: false });

        const response = await axios.get(url, {
            httpsAgent: agent,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cache-Control': 'no-cache',
                Pragma: 'no-cache',
                Connection: 'keep-alive',
            },
            timeout: 30000,
            maxRedirects: 5,
            validateStatus: (status) => status < 500,
        });

        const contentType = response.headers['content-type'] || 'text/html';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('X-Frame-Options', 'ALLOWALL');

        res.send(response.data);
    } catch (error) {
        console.error('Proxy error:', error.message);

        res.status(500).send(`
            <!DOCTYPE html>
            <html>
                <head>
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <style>
                        body {
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            height: 100vh;
                            margin: 0;
                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                            font-family: Arial, sans-serif;
                        }
                        .error-box {
                            background: white;
                            padding: 30px;
                            border-radius: 12px;
                            max-width: 400px;
                            box-shadow: 0 10px 30px rgba(0,0,0,0.3);
                            text-align: center;
                        }
                        h2 { color: #e53e3e; }
                        p { color: #555; }
                    </style>
                </head>
                <body>
                    <div class="error-box">
                        <h2>⚠️ Payment Page Load Failed</h2>
                        <p>Unable to load payment content. Please open in a desktop browser.</p>
                    </div>
                </body>
            </html>
        `);
    }
};

/**
 * Verify CashApp payment by starting polling
 * This should be called right after createCashappPaymentRequest
 */
const verifyCashappPayment = async (req, res) => {
    try {
        const { transactionId, payOrderNo } = req.body;
        const userId = req.user.userId;

        // Validation
        if (!transactionId) {
            return res.status(400).json({
                success: false,
                message: 'Transaction ID is required'
            });
        }

        if (!payOrderNo) {
            return res.status(400).json({
                success: false,
                message: 'Payment Order Number is required'
            });
        }

        // Find the transaction in wallet
        const wallet = await Wallet.findOne({ userId });
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

        if (transaction.paymentMethod !== 'cashapp') {
            return res.status(400).json({
                success: false,
                message: 'Invalid payment method for this transaction'
            });
        }

        if (transaction.status !== 'pending') {
            return res.status(400).json({
                success: false,
                message: `Transaction is already ${transaction.status}`
            });
        }

        // Check if polling is already active
        if (cashAppPollingService.isPollingActive(userId, transactionId)) {
            return res.json({
                success: true,
                message: 'Payment verification already in progress',
                data: {
                    transactionId: transactionId,
                    status: 'polling'
                }
            });
        }

        // Get creation time for polling (format: YYYY-MM-DD)
        const createTime = new Date(transaction.createdAt).toISOString().split('T')[0];

        // Start polling (non-blocking, runs in background)
        cashAppPollingService.startPolling(userId, transactionId, payOrderNo, createTime)
            .catch(error => {
                console.error('Error in CashApp polling service:', error);
            });

        res.json({
            success: true,
            message: 'Payment verification started successfully',
            data: {
                transactionId: transactionId,
                payOrderNo: payOrderNo,
                status: 'polling',
                estimatedCompletionTime: '1 hour',
                pollInterval: '30 seconds'
            }
        });

    } catch (error) {
        console.error('Error starting CashApp payment verification:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to start payment verification',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

/**
 * Check CashApp payment status manually
 * Allows users to check the current status of their payment
 */
const checkCashappPaymentStatus = async (req, res) => {
    try {
        const { transactionId } = req.params;
        const userId = req.user.userId;

        if (!transactionId) {
            return res.status(400).json({
                success: false,
                message: 'Transaction ID is required'
            });
        }

        // Find the transaction
        const wallet = await Wallet.findOne({ userId });
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

        const isPolling = cashAppPollingService.isPollingActive(userId, transactionId);

        res.json({
            success: true,
            data: {
                transactionId: transactionId,
                amount: transaction.amount,
                status: transaction.status,
                paymentMethod: transaction.paymentMethod,
                createdAt: transaction.createdAt,
                completedAt: transaction.completedAt,
                failedAt: transaction.failedAt,
                isPolling: isPolling,
                description: transaction.description
            }
        });

    } catch (error) {
        console.error('Error checking CashApp payment status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to check payment status',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

// ================================
// CHIME PAYMENT METHODS
// ================================




const matchChimeName = (emailSenderName, dbFullName) => {
    if (!emailSenderName || !dbFullName) return false;

    // Normalize both names (lowercase, trim, remove extra spaces)
    const emailName = emailSenderName.toLowerCase().trim().replace(/\s+/g, ' ');
    const dbName = dbFullName.toLowerCase().trim().replace(/\s+/g, ' ');

    // Exact match (case insensitive)
    if (emailName === dbName) return true;

    // Split names into parts
    const emailParts = emailName.split(' ');
    const dbParts = dbName.split(' ');

    // Need at least first name in both
    if (emailParts.length === 0 || dbParts.length === 0) return false;

    // Extract first name from both
    const emailFirstName = emailParts[0];
    const dbFirstName = dbParts[0];

    // First name must match exactly
    if (emailFirstName !== dbFirstName) return false;

    // If email only has first name (e.g., "Stephanie"), accept it
    if (emailParts.length === 1) return true;

    // If DB only has first name, accept it
    if (dbParts.length === 1) return true;

    // Get last part from email and remove period (e.g., "F." -> "f")
    const emailLastPart = emailParts[emailParts.length - 1].replace('.', '');
    
    // Get last name from database
    const dbLastName = dbParts[dbParts.length - 1];

    // Check if email has initial (single letter) - e.g., "Stephanie F."
    if (emailLastPart.length === 1) {
        // Match first letter of DB last name with email initial
        return emailLastPart === dbLastName.charAt(0);
    }

    // Check if email has full last name - e.g., "Stephanie Foster"
    return emailLastPart === dbLastName;
};



// Setup user's Chime details
const setupChimePayment = async (req, res) => {
    try {
        const { chimeTag, fullName } = req.body;
        const userId = req.user.userId;

        // Validation
        if (!fullName) {
            return res.status(400).json({
                success: false,
                message: 'Full name is required'
            });
        }

        // Validate Chime tag format if provided ($ChimeSign)
        if (chimeTag && !/^\$[a-zA-Z0-9_-]+$/.test(chimeTag)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid Chime tag format. Must start with $ (e.g., $JohnDoe)'
            });
        }

        // Save user's Chime details
        const userChimeDetails = await UserChimeDetails.findOrCreate(userId, {
            chimeTag: chimeTag ? chimeTag.trim() : null,
            fullName: fullName.trim(),
            lastVerified: new Date()
        });

        res.json({
            success: true,
            message: 'Chime payment details saved successfully',
            data: {
                chimeTag: userChimeDetails.chimeTag,
                fullName: userChimeDetails.fullName,
                isActive: userChimeDetails.isActive
            }
        });

    } catch (error) {
        console.error('Error setting up Chime payment:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to setup Chime payment details',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

// Create Chime payment request
// controllers/paymentController.js

const createChimePaymentRequest = async (req, res) => {
    console.log('=== CREATE CHIME PAYMENT REQUEST START ===');
    console.log('Request body:', req.body);
    console.log('req.user object:', req.user); // Add this to see what's available
    
    try {
        const { amount, chimeTag, fullName } = req.body;
        
        // FIX: Use req.user.userId instead of req.user.id
        const userId = req.user.userId; // Changed from req.user.id
        
        console.log('User ID from token:', userId);
        console.log('Extracted values:', { amount, chimeTag, fullName, userId });

        // Validate userId exists
        if (!userId) {
            console.log('❌ No user ID found in token');
            return res.status(401).json({
                success: false,
                message: 'Invalid authentication token'
            });
        }

        // Validate amount
        if (!amount || amount <= 0) {
            console.log('❌ Validation failed: Invalid amount');
            return res.status(400).json({ 
                success: false, 
                message: 'Invalid amount' 
            });
        }
        console.log('✅ Amount validation passed:', amount);

        // Validate Chime details from request
        if (!chimeTag || !fullName) {
            console.log('❌ Validation failed: Missing chimeTag or fullName');
            console.log('chimeTag:', chimeTag, 'fullName:', fullName);
            return res.status(400).json({ 
                success: false, 
                message: 'Chime tag and full name are required' 
            });
        }
        console.log('✅ Chime details validation passed');

        // Validate Chime tag format
        if (!chimeTag.startsWith('$')) {
            console.log('❌ Validation failed: Chime tag does not start with $');
            return res.status(400).json({ 
                success: false, 
                message: 'Chime tag must start with $' 
            });
        }
        console.log('✅ Chime tag format validation passed');

        // Get business Chime configuration from PaymentMethod
        console.log('📥 Fetching business Chime configuration...');
        const PaymentMethod = require('../models/PaymentMethod');
        const chimeConfig = await PaymentMethod.getConfig('chime');
        
        console.log('Business Chime config:', chimeConfig);
        
        if (!chimeConfig || !chimeConfig.businessChimeTag) {
            console.log('❌ Business Chime configuration not found or incomplete');
            return res.status(400).json({ 
                success: false, 
                message: 'Chime payment is not configured. Please contact support.' 
            });
        }
        console.log('✅ Business Chime config loaded:', {
            businessChimeTag: chimeConfig.businessChimeTag,
            businessChimeName: chimeConfig.businessChimeName
        });

        // Save/Update user's Chime details in UserChimeDetails
        console.log('💾 Saving user Chime details...');
        const UserChimeDetails = require('../models/UserChimeDetails');
        const userChimeDetails = await UserChimeDetails.findOrCreate(userId, {
            chimeTag: chimeTag.trim(),
            fullName: fullName.trim(),
            isActive: true
        });

        console.log('✅ User Chime details saved:', {
            id: userChimeDetails._id,
            userId: userChimeDetails.userId,
            chimeTag: userChimeDetails.chimeTag,
            fullName: userChimeDetails.fullName,
            isActive: userChimeDetails.isActive
        });

        // Generate unique external ID
        const external_id = `CHIME_${Date.now()}_${userId}`;
        console.log('🔑 Generated external_id:', external_id);

        // Create transaction in wallet
        console.log('💳 Creating wallet transaction...');
        const Wallet = require('../models/Wallet');
        const wallet = await Wallet.findOrCreateWallet(userId);
        
        console.log('Wallet found/created:', {
            walletId: wallet._id,
            currentBalance: wallet.balance,
            userId: wallet.userId
        });
        
        const transaction = wallet.addTransaction({
            type: 'deposit',
            amount: amount,
            description: `Chime deposit of $${amount} from ${chimeTag}`,
            status: 'pending',
            paymentMethod: 'chime',
            external_id: external_id,
            fee: 0,
            completedAt: null
        });

        console.log('Transaction added to wallet:', {
            transactionId: transaction._id,
            amount: transaction.amount,
            status: transaction.status,
            external_id: transaction.external_id
        });

        await wallet.save();
        console.log('✅ Wallet saved successfully');

        // Set expiration time (30 minutes from now)
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
        console.log('⏰ Payment expires at:', expiresAt.toISOString());

        // Return payment instructions
        const response = {
            success: true,
            external_id: external_id,
            transactionId: transaction._id.toString(),
            amount: amount,
            paymentMethod: 'chime',
            status: 'pending',
            chimeTag: chimeConfig.businessChimeTag,
            recipientName: chimeConfig.businessChimeName,
            instructions: [
                '1. Open your Chime app',
                '2. Go to "Pay Friends"',
                `3. Search for ${chimeConfig.businessChimeTag}`,
                `4. Send exactly $${amount.toFixed(2)}`,
                '5. Wait for automatic verification (usually within minutes)',
                '6. Your balance will be updated automatically'
            ],
            expiresAt: expiresAt.toISOString(),
            created_at: new Date().toISOString(),
            userChimeTag: chimeTag // Return user's chime tag for reference
        };

        console.log('📤 Sending response:', response);
        console.log('=== CREATE CHIME PAYMENT REQUEST SUCCESS ===');

        res.json({
            success: true,
            data: response
        });

    } catch (error) {
        console.error('❌❌❌ ERROR in createChimePaymentRequest:', error);
        console.error('Error name:', error.name);
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
        console.log('=== CREATE CHIME PAYMENT REQUEST FAILED ===');
        
        res.status(500).json({ 
            success: false, 
            message: error.message || 'Failed to create Chime payment request' 
        });
    }
};

// Complete verifyChimePayment function for paymentController.js

const verifyChimePayment = async (req, res) => {
    console.log('═══════════════════════════════════════════════════');
    console.log('🔍 VERIFY CHIME PAYMENT START');
    console.log('═══════════════════════════════════════════════════');
    
    try {
        const { transactionId } = req.body;
        const userId = req.user.userId;

        console.log('📋 Request Details:');
        console.log('   Transaction ID:', transactionId);
        console.log('   User ID:', userId);

        // Validate transaction ID
        if (!transactionId) {
            console.log('❌ Validation failed: No transaction ID provided');
            return res.status(400).json({
                success: false,
                message: 'Transaction ID is required'
            });
        }

        // Find the wallet with pending transaction
        console.log('\n🔍 Searching for pending transaction...');
        const Wallet = require('../models/Wallet');
        const wallet = await Wallet.findOne({
            userId,
            'transactions._id': transactionId,
            'transactions.paymentMethod': 'chime',
            'transactions.status': 'pending'
        });

        if (!wallet) {
            console.log('❌ Pending transaction not found');
            return res.status(404).json({
                success: false,
                message: 'Pending Chime transaction not found'
            });
        }

        const transaction = wallet.transactions.id(transactionId);
        
        if (!transaction) {
            console.log('❌ Transaction not found in wallet');
            return res.status(404).json({
                success: false,
                message: 'Transaction not found'
            });
        }

        console.log('✅ Found pending transaction:');
        console.log('   Transaction ID:', transaction._id);
        console.log('   Amount:', `$${transaction.amount}`);
        console.log('   Status:', transaction.status);
        console.log('   Created:', transaction.createdAt);

        // Check if transaction is expired (30 minutes)
        const transactionDate = new Date(transaction.createdAt);
        const now = new Date();
        const timeDiffMinutes = (now - transactionDate) / 1000 / 60;
        
        console.log('   Age:', `${Math.floor(timeDiffMinutes)} minutes`);

        if (timeDiffMinutes > 30) {
            console.log('❌ Transaction expired (over 30 minutes old)');
            
            wallet.updateTransactionStatus(transactionId, 'failed', 'Payment request expired after 30 minutes');
            await wallet.save();
            
            return res.json({
                success: false,
                message: 'Payment request expired. Please create a new payment request.',
                data: {
                    status: 'failed',
                    reason: 'expired'
                }
            });
        }

        // Get Chime config
        console.log('\n📥 Fetching Chime configuration...');
        const PaymentMethod = require('../models/PaymentMethod');
        const paymentMethod = await PaymentMethod.findOne({
            method: 'chime',
            isActive: true
        });

        if (!paymentMethod || !paymentMethod.chimeConfig) {
            console.log('❌ Chime payment method not configured');
            return res.status(400).json({
                success: false,
                message: 'Chime payment method not configured. Please contact support.'
            });
        }

        const { mailTmUsername, mailTmPassword } = paymentMethod.chimeConfig;
        
        console.log('✅ Chime config loaded');

        // Get user's Chime details
        console.log('\n👤 Fetching user Chime details...');
        const UserChimeDetails = require('../models/UserChimeDetails');
        const userChimeDetails = await UserChimeDetails.findOne({ 
            userId,
            isActive: true 
        });
        
        if (!userChimeDetails) {
            console.log('❌ User Chime details not found');
            return res.status(400).json({
                success: false,
                message: 'User Chime details not found. Please setup your Chime account first.'
            });
        }

        const userFullName = userChimeDetails.fullName;
        
        console.log('✅ User Chime details:');
        console.log('   Full Name:', userFullName);

        // Login to Mail.tm
        console.log('\n📧 Logging into Mail.tm...');
        const mailTmService = require('../services/mailTmService');
        await mailTmService.login(mailTmUsername, mailTmPassword);
        console.log('✅ Mail.tm login successful');

        // Search for payment emails
        console.log('\n🔍 Searching for payment emails...');
        const chimeMessages = await mailTmService.searchChimePayments(transactionDate);

        console.log(`📬 Found ${chimeMessages.length} potential payment email(s)`);

        if (chimeMessages.length === 0) {
            console.log('⏳ No payment emails found yet');
            
            return res.json({
                success: false,
                message: 'Payment not verified yet. Please wait a few minutes after sending the payment.',
                data: {
                    transactionId: transaction._id,
                    amount: transaction.amount,
                    status: 'pending',
                    searchedEmails: 0,
                    waitTime: `${Math.floor(timeDiffMinutes)} minutes`,
                    timeRemaining: `${Math.max(0, 30 - Math.floor(timeDiffMinutes))} minutes`
                }
            });
        }

        // Parse and match payments with IMPROVED NAME MATCHING
        console.log('\n💰 Parsing and matching payments...');
        let matchedPayment = null;
        
        for (let i = 0; i < chimeMessages.length; i++) {
            const message = chimeMessages[i];
            console.log(`\n   📨 Email ${i + 1}/${chimeMessages.length}:`);
            console.log(`      Subject: "${message.subject}"`);
            
            const paymentDetails = await mailTmService.parseChimePayment(message.id);
            
            console.log(`\n   🔍 Matching criteria check:`);
            
            // 1. Amount match (within 1 cent tolerance)
            const amountMatches = paymentDetails.amount && 
                                 Math.abs(paymentDetails.amount - transaction.amount) < 0.01;
            
            console.log(`      💵 Amount:`);
            console.log(`         Email: $${paymentDetails.amount}`);
            console.log(`         Expected: $${transaction.amount}`);
            console.log(`         Match: ${amountMatches ? '✅' : '❌'}`);
            
            // 2. IMPROVED NAME MATCHING - Using helper function
            const nameMatches = matchChimeName(paymentDetails.senderName, userFullName);
            
            console.log(`      👤 Name:`);
            console.log(`         Email sender: "${paymentDetails.senderName}"`);
            console.log(`         Expected: "${userFullName}"`);
            console.log(`         Match: ${nameMatches ? '✅' : '❌'}`);

            // 3. Date match
            const emailDate = new Date(paymentDetails.date);
            const timeDiff = emailDate - transactionDate;
            const dateMatches = timeDiff > 0 && timeDiff <= 30 * 60 * 1000;
            
            console.log(`      📅 Date:`);
            console.log(`         Time difference: ${Math.floor(timeDiff / 1000)} seconds`);
            console.log(`         Match: ${dateMatches ? '✅' : '❌'}`);

            // Check if all criteria match
            if (amountMatches && nameMatches && dateMatches) {
                console.log(`\n      🎉 ALL CRITERIA MATCHED!`);
                matchedPayment = paymentDetails;
                break;
            } else {
                console.log(`\n      ❌ Not a match - continuing search...`);
            }
        }

        if (matchedPayment) {
            console.log('\n✅ PAYMENT VERIFICATION SUCCESSFUL!');
            
            // Payment found - mark as completed
            const metadata = {
                senderName: matchedPayment.senderName,
                amount: matchedPayment.amount,
                expectedSenderName: userFullName,
                chimeTag: matchedPayment.chimeTag,
                emailSubject: matchedPayment.subject,
                verifiedAt: new Date().toISOString(),
                messageId: matchedPayment.messageId,
                verificationMethod: 'manual'
            };

            // ✅ Use centralized helper for deposit completion with bonus
            const { completeDepositWithBonus } = require('../helpers/depositHelper');
            
            const result = await completeDepositWithBonus(
                wallet._id,
                transaction._id,
                {
                    completedBy: 'Chime Verification',
                    isManual: true,
                    metadata: metadata
                }
            );
            
            // Update Chime-specific description
            const updatedWallet = await Wallet.findById(wallet._id);
            const updatedTransaction = updatedWallet.transactions.id(transaction._id);
            updatedTransaction.description = `Chime deposit from ${matchedPayment.senderName} - Verified`;
            await updatedWallet.save();

            console.log('\n💾 Transaction updated:');
            console.log('   Status: completed');
            console.log('   New wallet balance: $' + updatedWallet.balance);
            console.log('   Available balance: $' + updatedWallet.availableBalance);
            if (result.bonusInfo) {
                console.log(`   🎁 Bonus applied: $${result.bonusInfo.amount}`);
            }
            
            console.log('\n═══════════════════════════════════════════════════');
            console.log('✅ VERIFY CHIME PAYMENT SUCCESS');
            console.log('═══════════════════════════════════════════════════\n');

            const successMessage = result.bonusInfo 
                ? `Payment verified successfully with ${result.bonusInfo.description} of $${result.bonusInfo.amount}! Your balance has been updated.`
                : 'Payment verified successfully! Your balance has been updated.';

            res.json({
                success: true,
                message: successMessage,
                data: {
                    transactionId: updatedTransaction._id,
                    amount: updatedTransaction.amount,
                    senderName: matchedPayment.senderName,
                    status: 'completed',
                    completedAt: updatedTransaction.completedAt,
                    newBalance: updatedWallet.balance,
                    availableBalance: updatedWallet.availableBalance,
                    bonusApplied: result.bonusInfo || null
                }
            });

        } else {
            console.log('\n⏳ PAYMENT NOT VERIFIED YET');
            console.log(`   Checked ${chimeMessages.length} email(s)`);
            console.log(`   No matching payment found`);
            
            console.log('\n═══════════════════════════════════════════════════');
            console.log('⏳ VERIFY CHIME PAYMENT PENDING');
            console.log('═══════════════════════════════════════════════════\n');
            
            res.json({
                success: false,
                message: 'Payment not verified yet. Please ensure you sent exactly the correct amount to the correct Chime tag, then wait a few minutes and try again.',
                data: {
                    transactionId: transaction._id,
                    amount: transaction.amount,
                    status: 'pending',
                    searchedEmails: chimeMessages.length,
                    waitTime: `${Math.floor(timeDiffMinutes)} minutes`,
                    timeRemaining: `${Math.max(0, 30 - Math.floor(timeDiffMinutes))} minutes`,
                    expectedAmount: `$${transaction.amount.toFixed(2)}`,
                    expectedSender: userFullName
                }
            });
        }

    } catch (error) {
        console.error('\n❌❌❌ ERROR IN VERIFY CHIME PAYMENT');
        console.error('Error name:', error.name);
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
        console.log('═══════════════════════════════════════════════════');
        console.log('❌ VERIFY CHIME PAYMENT FAILED');
        console.log('═══════════════════════════════════════════════════\n');
        
        res.status(500).json({
            success: false,
            message: 'Failed to verify Chime payment. Please try again or contact support.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

// Complete autoVerifyChimePayments function for paymentController.js (Cron Job)

const autoVerifyChimePayments = async () => {
    console.log('\n🔄 ═══════════════════════════════════════════════════');
    console.log('🔄 AUTO-VERIFY CHIME PAYMENTS CRON JOB START');
    console.log('🔄 Time:', new Date().toISOString());
    console.log('🔄 ═══════════════════════════════════════════════════');
    
    try {
        // Find all wallets with pending Chime transactions
        console.log('\n🔍 Searching for pending Chime transactions...');
        
        const Wallet = require('../models/Wallet');
        const walletsWithPending = await Wallet.find({
            'transactions.paymentMethod': 'chime',
            'transactions.status': 'pending'
        });

        if (walletsWithPending.length === 0) {
            console.log('ℹ️  No pending Chime transactions found');
            console.log('🔄 ═══════════════════════════════════════════════════\n');
            return;
        }

        console.log(`📊 Found ${walletsWithPending.length} wallet(s) with pending Chime transactions`);

        // Get admin's Chime config from database
        console.log('\n📥 Fetching Chime configuration...');
        let chimeConfig;
        try {
            const PaymentMethod = require('../models/PaymentMethod');
            chimeConfig = await PaymentMethod.getConfig('chime');
        } catch (error) {
            console.error('❌ Chime payment method not configured:', error.message);
            console.log('🔄 ═══════════════════════════════════════════════════\n');
            return;
        }

        if (!chimeConfig || !chimeConfig.mailTmUsername || !chimeConfig.mailTmPassword) {
            console.error('❌ Mail.tm credentials not configured for Chime');
            console.log('🔄 ═══════════════════════════════════════════════════\n');
            return;
        }

        console.log('✅ Chime config loaded');

        // Login to Mail.tm once for all verifications
        console.log('\n📧 Logging into Mail.tm...');
        const mailTmService = require('../services/mailTmService');
        await mailTmService.login(chimeConfig.mailTmUsername, chimeConfig.mailTmPassword);
        console.log('✅ Mail.tm login successful');

        let verifiedCount = 0;
        let expiredCount = 0;
        let checkedCount = 0;
        let skippedCount = 0;

        // Process each wallet
        for (const wallet of walletsWithPending) {
            const pendingTransactions = wallet.transactions.filter(t =>
                t.paymentMethod === 'chime' &&
                t.status === 'pending'
            );

            console.log(`\n💼 ─────────────────────────────────────────────────`);
            console.log(`💼 Wallet: ${wallet.userId}`);
            console.log(`💼 Pending transactions: ${pendingTransactions.length}`);
            console.log(`💼 ─────────────────────────────────────────────────`);

            for (const transaction of pendingTransactions) {
                checkedCount++;
                
                try {
                    console.log(`\n  🔍 Transaction ${checkedCount}:`);
                    console.log(`     ID: ${transaction._id}`);
                    console.log(`     Amount: $${transaction.amount}`);
                    console.log(`     Created: ${transaction.createdAt}`);

                    // Check if transaction is expired (30 minutes)
                    const transactionDate = new Date(transaction.createdAt);
                    const now = new Date();
                    const timeDiffMinutes = (now - transactionDate) / 1000 / 60;
                    
                    console.log(`     Age: ${Math.floor(timeDiffMinutes)} minutes`);

                    if (timeDiffMinutes > 30) {
                        console.log('     ⏰ Transaction EXPIRED (over 30 minutes)');
                        
                        wallet.updateTransactionStatus(
                            transaction._id,
                            'failed',
                            'Payment request expired after 30 minutes - Auto-verified'
                        );
                        
                        await wallet.save();
                        expiredCount++;
                        
                        console.log('     ❌ Marked as failed due to expiration');
                        continue;
                    }

                    // Get user's Chime details
                    const UserChimeDetails = require('../models/UserChimeDetails');
                    const userChimeDetails = await UserChimeDetails.findOne({
                        userId: wallet.userId,
                        isActive: true
                    });

                    if (!userChimeDetails) {
                        console.log('     ⚠️  User Chime details not found - skipping');
                        skippedCount++;
                        continue;
                    }

                    const userFullName = userChimeDetails.fullName;
                    
                    console.log(`     👤 User: ${userFullName}`);

                    // Search for payments after transaction creation
                    const chimeMessages = await mailTmService.searchChimePayments(transactionDate);

                    console.log(`     📬 Found ${chimeMessages.length} potential matching email(s)`);

                    if (chimeMessages.length === 0) {
                        console.log('     ⏳ No emails found yet - will retry next cycle');
                        continue;
                    }

                    // Match payment with IMPROVED NAME MATCHING
                    let matched = false;
                    
                    for (let i = 0; i < chimeMessages.length; i++) {
                        const message = chimeMessages[i];
                        console.log(`\n     📨 Checking email ${i + 1}/${chimeMessages.length}:`);
                        console.log(`        Subject: "${message.subject}"`);
                        
                        const paymentDetails = await mailTmService.parseChimePayment(message.id);

                        // 1. Amount match (within 1 cent tolerance)
                        const amountMatches = paymentDetails.amount &&
                                            Math.abs(paymentDetails.amount - transaction.amount) < 0.01;

                        // 2. IMPROVED NAME MATCHING - Using helper function
                        const nameMatches = matchChimeName(paymentDetails.senderName, userFullName);

                        // 3. Date match (after transaction, within 30 minutes)
                        const emailDate = new Date(paymentDetails.date);
                        const timeDiff = emailDate - transactionDate;
                        const dateMatches = timeDiff > 0 && timeDiff <= 30 * 60 * 1000;

                        console.log(`        💵 Amount: ${amountMatches ? '✅' : '❌'} (Email: $${paymentDetails.amount}, Expected: $${transaction.amount})`);
                        console.log(`        👤 Name: ${nameMatches ? '✅' : '❌'} (Email: "${paymentDetails.senderName}", Expected: "${userFullName}")`);
                        console.log(`        📅 Date: ${dateMatches ? '✅' : '❌'} (Time diff: ${Math.floor(timeDiff / 1000)}s)`);

                        if (amountMatches && nameMatches && dateMatches) {
                            console.log('        🎉 MATCH FOUND!');
                            
                            // Mark as completed
                            const metadata = {
                                senderName: paymentDetails.senderName,
                                amount: paymentDetails.amount,
                                expectedSenderName: userFullName,
                                chimeTag: paymentDetails.chimeTag,
                                emailSubject: paymentDetails.subject,
                                verifiedAt: new Date().toISOString(),
                                messageId: paymentDetails.messageId,
                                verificationMethod: 'auto',
                                autoVerified: true
                            };

                            // ✅ Use centralized helper for deposit completion with bonus
                            const { completeDepositWithBonus } = require('../helpers/depositHelper');
                            
                            const result = await completeDepositWithBonus(
                                wallet._id,
                                transaction._id,
                                {
                                    completedBy: 'Chime Auto-Verify',
                                    isManual: false,
                                    metadata: metadata
                                }
                            );
                            
                            // Update Chime-specific description
                            const updatedWallet = await Wallet.findById(wallet._id);
                            const updatedTransaction = updatedWallet.transactions.id(transaction._id);
                            updatedTransaction.description = `Chime deposit from ${paymentDetails.senderName} - Auto-verified`;
                            await updatedWallet.save();
                            
                            verifiedCount++;
                            matched = true;
                            
                            console.log(`     ✅ Payment verified successfully!`);
                            console.log(`     💰 New balance: $${updatedWallet.balance}`);
                            console.log(`     💳 Available balance: $${updatedWallet.availableBalance}`);
                            if (result.bonusInfo) {
                                console.log(`     🎁 Bonus applied: $${result.bonusInfo.amount}`);
                            }
                            
                            break;
                        } else {
                            console.log('        ❌ No match - continuing...');
                        }
                    }

                    if (!matched) {
                        console.log('     ⏳ No matching payment found yet');
                    }

                } catch (error) {
                    console.error(`     ❌ Error verifying transaction ${transaction._id}:`);
                    console.error(`        ${error.message}`);
                }
            }
        }

        // Summary
        console.log('\n📊 ═══════════════════════════════════════════════════');
        console.log('📊 AUTO-VERIFY SUMMARY:');
        console.log(`   ✅ Verified: ${verifiedCount} payment(s)`);
        console.log(`   ⏰ Expired: ${expiredCount} transaction(s)`);
        console.log(`   ⏳ Still pending: ${checkedCount - verifiedCount - expiredCount} transaction(s)`);
        console.log(`   ⚠️  Skipped: ${skippedCount} transaction(s)`);
        console.log(`   📝 Total checked: ${checkedCount} transaction(s)`);
        console.log('📊 ═══════════════════════════════════════════════════');
        console.log('🔄 AUTO-VERIFY CHIME PAYMENTS CRON JOB COMPLETE');
        console.log('🔄 ═══════════════════════════════════════════════════\n');

    } catch (error) {
        console.error('\n❌❌❌ ERROR IN AUTO-VERIFY CRON JOB');
        console.error('Error name:', error.name);
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
        console.log('🔄 ═══════════════════════════════════════════════════');
        console.log('❌ AUTO-VERIFY CHIME PAYMENTS CRON JOB FAILED');
        console.log('🔄 ═══════════════════════════════════════════════════\n');
    }
};


// Get user's payment methods
const getPaymentMethods = async (req, res) => {
    try {
        const userId = req.user.userId;

        // Get user's Chime details
        const userChimeDetails = await UserChimeDetails.findOne({
            userId,
            isActive: true
        }).select('chimeTag fullName lastVerified');

        // Get available payment methods (system-wide) - INCLUDE CONFIG FIELDS
        const paymentMethods = await PaymentMethod.find({
            isActive: true
        }).select('method isActive cryptoConfig cashappConfig chimeConfig');

        const formattedMethods = paymentMethods.map(method => {
            // Get the config for this payment method
            const methodConfig = method[`${method.method}Config`] || {};
            
            const result = {
                method: method.method,
                isActive: method.isActive,
                configured: true,
                // ADD THE CONFIG WITH FEES
                config: {
                    depositChargePercent: methodConfig.depositChargePercent || 0,
                    withdrawChargePercent: methodConfig.withdrawChargePercent || 0
                }
            };

            // Add user-specific data for Chime
            if (method.method === 'chime' && userChimeDetails) {
                result.userDetails = {
                    chimeTag: userChimeDetails.chimeTag,
                    fullName: userChimeDetails.fullName,
                    lastVerified: userChimeDetails.lastVerified
                };
            }

            return result;
        });

        res.json({
            success: true,
            data: formattedMethods
        });

    } catch (error) {
        console.error('Error fetching payment methods:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch payment methods'
        });
    }
};

// Get user's Chime details
const getUserChimeDetails = async (req, res) => {
    try {
        const userId = req.user.userId;

        const userChimeDetails = await UserChimeDetails.findOne({
            userId,
            isActive: true
        });

        if (!userChimeDetails) {
            return res.json({
                success: true,
                data: null,
                message: 'No Chime details found. Please setup your Chime payment method.'
            });
        }

        res.json({
            success: true,
            data: {
                chimeTag: userChimeDetails.chimeTag,
                fullName: userChimeDetails.fullName,
                lastVerified: userChimeDetails.lastVerified,
                isActive: userChimeDetails.isActive
            }
        });

    } catch (error) {
        console.error('Error fetching user Chime details:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch Chime details'
        });
    }
};

// ================================
// ADMIN: Configure Payment Methods
// ================================

// Save crypto config (UPDATED VERSION - allows partial updates)
const saveCryptoConfig = async (req, res) => {
    try {
        const { 
            gatewayUrl, 
            apiKey, 
            callbackUrl, 
            username, 
            password,
            depositChargePercent,
            withdrawChargePercent 
        } = req.body;

        // Get existing config
        let existingConfig = null;
        try {
            const existingMethod = await PaymentMethod.findOne({ method: 'crypto' });
            existingConfig = existingMethod?.cryptoConfig;
        } catch (err) {
            // No existing config, will create new
        }

        // Merge with existing config for fields not provided
        const finalConfig = {
            gatewayUrl: gatewayUrl || existingConfig?.gatewayUrl,
            apiKey: apiKey || existingConfig?.apiKey,
            callbackUrl: callbackUrl || existingConfig?.callbackUrl,
            username: username || existingConfig?.username,
            password: password || existingConfig?.password,
            depositChargePercent: depositChargePercent !== undefined ? depositChargePercent : (existingConfig?.depositChargePercent || 0),
            withdrawChargePercent: withdrawChargePercent !== undefined ? withdrawChargePercent : (existingConfig?.withdrawChargePercent || 0)
        };

        // Validate required fields after merge
        if (!finalConfig.gatewayUrl || !finalConfig.apiKey || !finalConfig.callbackUrl || !finalConfig.username || !finalConfig.password) {
            return res.status(400).json({
                success: false,
                message: 'All crypto configuration fields are required'
            });
        }

        // Validate charge percentages
        if (finalConfig.depositChargePercent < 0 || finalConfig.depositChargePercent > 100) {
            return res.status(400).json({
                success: false,
                message: 'Deposit charge percent must be between 0 and 100'
            });
        }

        if (finalConfig.withdrawChargePercent < 0 || finalConfig.withdrawChargePercent > 100) {
            return res.status(400).json({
                success: false,
                message: 'Withdraw charge percent must be between 0 and 100'
            });
        }

        const paymentMethod = await PaymentMethod.saveConfig('crypto', {
            gatewayUrl: finalConfig.gatewayUrl.trim(),
            apiKey: finalConfig.apiKey.trim(),
            callbackUrl: finalConfig.callbackUrl.trim(),
            username: finalConfig.username.trim(),
            password: finalConfig.password.trim(),
            depositChargePercent: finalConfig.depositChargePercent,
            withdrawChargePercent: finalConfig.withdrawChargePercent
        });

        res.json({
            success: true,
            message: 'Crypto payment configuration saved successfully',
            data: {
                method: paymentMethod.method,
                isActive: paymentMethod.isActive,
                depositChargePercent: paymentMethod.cryptoConfig.depositChargePercent,
                withdrawChargePercent: paymentMethod.cryptoConfig.withdrawChargePercent
            }
        });

    } catch (error) {
        console.error('Error saving crypto config:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to save crypto configuration',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

// Updated saveCashappConfig in paymentController.js

const saveCashappConfig = async (req, res) => {
    try {
        const { 
            apiUrl,           // Base URL: https://bo.wiwiusonepay.com/api/mgr
            authToken,        // Optional initial token
            username,         // Login username (e.g., "test9999")
            password,         // Hashed password (e.g., "8f95612c5cd1be9f7871841dc0a7b945")
            mchNo, 
            currCode, 
            wayCode,
            depositChargePercent,
            withdrawChargePercent 
        } = req.body;
        console.log(req.body)
        // Get existing config
        let existingConfig = null;
        try {
            const existingMethod = await PaymentMethod.findOne({ method: 'cashapp' });
            existingConfig = existingMethod?.cashappConfig;
        } catch (err) {
            // No existing config, will create new
        }

        // Merge with existing config for fields not provided
        const finalConfig = {
            apiUrl: apiUrl || existingConfig?.apiUrl,
            authToken: authToken || existingConfig?.authToken || '',
            username: username || existingConfig?.username,
            password: password || existingConfig?.password,
            mchNo: mchNo || existingConfig?.mchNo,
            currCode: currCode || existingConfig?.currCode || 'usd',
            wayCode: wayCode || existingConfig?.wayCode || 'cashapp',
            depositChargePercent: depositChargePercent !== undefined ? depositChargePercent : (existingConfig?.depositChargePercent || 0),
            withdrawChargePercent: withdrawChargePercent !== undefined ? withdrawChargePercent : (existingConfig?.withdrawChargePercent || 0)
        };

        // Validate required fields after merge
        if (!finalConfig.apiUrl || !finalConfig.username || !finalConfig.password || !finalConfig.mchNo) {
            return res.status(400).json({
                success: false,
                message: 'API URL, Username, Password, and Merchant Number are required'
            });
        }

        // Validate URL format
        try {
            new URL(finalConfig.apiUrl);
        } catch (error) {
            return res.status(400).json({
                success: false,
                message: 'Invalid API URL format'
            });
        }

        // Validate charge percentages
        if (finalConfig.depositChargePercent < 0 || finalConfig.depositChargePercent > 100) {
            return res.status(400).json({
                success: false,
                message: 'Deposit charge percent must be between 0 and 100'
            });
        }

        if (finalConfig.withdrawChargePercent < 0 || finalConfig.withdrawChargePercent > 100) {
            return res.status(400).json({
                success: false,
                message: 'Withdraw charge percent must be between 0 and 100'
            });
        }

        const paymentMethod = await PaymentMethod.saveConfig('cashapp', {
            apiUrl: finalConfig.apiUrl.trim(),
            authToken: finalConfig.authToken.trim(),
            username: finalConfig.username.trim(),
            password: finalConfig.password.trim(),
            mchNo: finalConfig.mchNo.trim(),
            currCode: finalConfig.currCode,
            wayCode: finalConfig.wayCode,
            depositChargePercent: finalConfig.depositChargePercent,
            withdrawChargePercent: finalConfig.withdrawChargePercent
        });

        console.log('✅ CashApp configuration saved successfully');
        console.log('   API URL:', finalConfig.apiUrl);
        console.log('   Username:', finalConfig.username);
        console.log('   Merchant No:', finalConfig.mchNo);

        res.json({
            success: true,
            message: 'Cashapp payment configuration saved successfully',
            data: {
                method: paymentMethod.method,
                isActive: paymentMethod.isActive,
                apiUrl: paymentMethod.cashappConfig.apiUrl,
                username: paymentMethod.cashappConfig.username,
                hasPassword: !!paymentMethod.cashappConfig.password,
                hasAuthToken: !!paymentMethod.cashappConfig.authToken,
                mchNo: paymentMethod.cashappConfig.mchNo,
                depositChargePercent: paymentMethod.cashappConfig.depositChargePercent,
                withdrawChargePercent: paymentMethod.cashappConfig.withdrawChargePercent
            }
        });

    } catch (error) {
        console.error('Error saving cashapp config:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to save cashapp configuration',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

// Save chime config (UPDATED VERSION - allows partial updates)
const saveChimeConfig = async (req, res) => {
    try {
        const { 
            businessChimeTag, 
            businessChimeName, 
            mailTmUsername, 
            mailTmPassword,
            depositChargePercent,
            withdrawChargePercent 
        } = req.body;

        // Get existing config
        let existingConfig = null;
        try {
            const existingMethod = await PaymentMethod.findOne({ method: 'chime' });
            existingConfig = existingMethod?.chimeConfig;
        } catch (err) {
            // No existing config, will create new
        }

        // Merge with existing config for fields not provided
        const finalConfig = {
            businessChimeTag: businessChimeTag || existingConfig?.businessChimeTag,
            businessChimeName: businessChimeName || existingConfig?.businessChimeName,
            mailTmUsername: mailTmUsername || existingConfig?.mailTmUsername,
            mailTmPassword: mailTmPassword || existingConfig?.mailTmPassword,
            depositChargePercent: depositChargePercent !== undefined ? depositChargePercent : (existingConfig?.depositChargePercent || 0),
            withdrawChargePercent: withdrawChargePercent !== undefined ? withdrawChargePercent : (existingConfig?.withdrawChargePercent || 0)
        };

        // Validate required fields after merge
        if (!finalConfig.businessChimeTag || !finalConfig.businessChimeName || !finalConfig.mailTmUsername || !finalConfig.mailTmPassword) {
            return res.status(400).json({
                success: false,
                message: 'All Chime configuration fields are required'
            });
        }

        // Validate business Chime tag format
        if (!/^\$[a-zA-Z0-9_-]+$/.test(finalConfig.businessChimeTag)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid business Chime tag format. Must start with $ (e.g., $BeLucky)'
            });
        }

        // Validate charge percentages
        if (finalConfig.depositChargePercent < 0 || finalConfig.depositChargePercent > 100) {
            return res.status(400).json({
                success: false,
                message: 'Deposit charge percent must be between 0 and 100'
            });
        }

        if (finalConfig.withdrawChargePercent < 0 || finalConfig.withdrawChargePercent > 100) {
            return res.status(400).json({
                success: false,
                message: 'Withdraw charge percent must be between 0 and 100'
            });
        }

        const paymentMethod = await PaymentMethod.saveConfig('chime', {
            businessChimeTag: finalConfig.businessChimeTag.trim(),
            businessChimeName: finalConfig.businessChimeName.trim(),
            mailTmUsername: finalConfig.mailTmUsername.trim(),
            mailTmPassword: finalConfig.mailTmPassword.trim(),
            depositChargePercent: finalConfig.depositChargePercent,
            withdrawChargePercent: finalConfig.withdrawChargePercent
        });

        res.json({
            success: true,
            message: 'Chime payment configuration saved successfully',
            data: {
                method: paymentMethod.method,
                isActive: paymentMethod.isActive,
                depositChargePercent: paymentMethod.chimeConfig.depositChargePercent,
                withdrawChargePercent: paymentMethod.chimeConfig.withdrawChargePercent
            }
        });

    } catch (error) {
        console.error('Error saving chime config:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to save Chime configuration',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

// Get all payment configurations (UPDATED VERSION - includes charges)
const getAllPaymentConfigs = async (req, res) => {
    try {
        const paymentMethods = await PaymentMethod.find({});

        const configs = paymentMethods.map(method => ({
            method: method.method,
            isActive: method.isActive,
            config: method.method === 'crypto' ? {
                gatewayUrl: method.cryptoConfig?.gatewayUrl,
                callbackUrl: method.cryptoConfig?.callbackUrl,
                username: method.cryptoConfig?.username,
                // ✅ RETURN actual values instead of just hasApiKey/hasPassword
                apiKey: method.cryptoConfig?.apiKey || '',
                password: method.cryptoConfig?.password || '',
                depositChargePercent: method.cryptoConfig?.depositChargePercent || 0,
                withdrawChargePercent: method.cryptoConfig?.withdrawChargePercent || 0
            } : method.method === 'cashapp' ? {
                apiUrl: method.cashappConfig?.apiUrl,
                mchNo: method.cashappConfig?.mchNo,
                currCode: method.cashappConfig?.currCode,
                wayCode: method.cashappConfig?.wayCode,
                username: method.cashappConfig?.username,
                // ✅ RETURN actual values
                authToken: method.cashappConfig?.authToken || '',
                password: method.cashappConfig?.password || '',
                depositChargePercent: method.cashappConfig?.depositChargePercent || 0,
                withdrawChargePercent: method.cashappConfig?.withdrawChargePercent || 0
            } : method.method === 'chime' ? {
                businessChimeTag: method.chimeConfig?.businessChimeTag,
                businessChimeName: method.chimeConfig?.businessChimeName,
                mailTmUsername: method.chimeConfig?.mailTmUsername,
                // ✅ RETURN actual value
                mailTmPassword: method.chimeConfig?.mailTmPassword || '',
                depositChargePercent: method.chimeConfig?.depositChargePercent || 0,
                withdrawChargePercent: method.chimeConfig?.withdrawChargePercent || 0
            } : {},
            createdAt: method.createdAt,
            updatedAt: method.updatedAt
        }));

        res.json({
            success: true,
            data: configs
        });

    } catch (error) {
        console.error('Error fetching payment configs:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch payment configurations'
        });
    }
};

// Toggle payment method active status
const togglePaymentMethod = async (req, res) => {
    try {
        const { method } = req.params;
        const { isActive } = req.body;

        if (!['crypto', 'cashapp', 'chime'].includes(method)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid payment method'
            });
        }

        const paymentMethod = await PaymentMethod.findOneAndUpdate(
            { method },
            { isActive, updatedAt: new Date() },
            { new: true }
        );

        if (!paymentMethod) {
            return res.status(404).json({
                success: false,
                message: 'Payment method not found'
            });
        }

        res.json({
            success: true,
            message: `${method} payment method ${isActive ? 'enabled' : 'disabled'} successfully`,
            data: {
                method: paymentMethod.method,
                isActive: paymentMethod.isActive
            }
        });

    } catch (error) {
        console.error('Error toggling payment method:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to toggle payment method'
        });
    }
};


// Export all functions
module.exports = {

    updateWalletTransactionStatus,
    // Crypto
    getCryptoList,
    createPaymentRequest,
    confirmPayment,
    processCryptoWithdrawal,
    
    // Cashapp
    createCashappPaymentRequest,
    cashappProxy,
    verifyCashappPayment,
    checkCashappPaymentStatus,
    
    // Chime
    setupChimePayment,
    createChimePaymentRequest,
    verifyChimePayment,
    autoVerifyChimePayments,
    getUserChimeDetails,
    
    // General
    getPaymentMethods,
    
    // Admin
    saveCryptoConfig,
    saveCashappConfig,
    saveChimeConfig,
    getAllPaymentConfigs,
    togglePaymentMethod,
};