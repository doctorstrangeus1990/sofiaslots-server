// services/cashAppPollingService.js
const axios = require('axios');
const Wallet = require('../models/Wallet');
const PaymentMethod = require('../models/PaymentMethod');
const { makeAuthenticatedRequest } = require('../helpers/cashappAuthHelper');

class CashAppPollingService {
    constructor() {
        this.maxPollingAttempts = 120; // 120 attempts = 1 hour with 30s intervals
        this.pollingIntervalSeconds = 30; // 30 seconds between polls
        this.activePolls = new Map(); // Track active polling sessions
    }

    /**
     * Start polling for CashApp payment verification
     * @param {string} userId - The user ID
     * @param {string} transactionId - The transaction ID from wallet
     * @param {string} payOrderNo - The order number from payment gateway (S2025101503254EC8073)
     * @param {string} createTime - The creation time of the order (format: YYYY-MM-DD)
     * @returns {Promise<void>}
     */
    async startPolling(userId, transactionId, payOrderNo, createTime) {
        const pollKey = `${userId}_${transactionId}`;
        
        // Prevent duplicate polling for same transaction
        if (this.activePolls.has(pollKey)) {
            console.log(`Polling already active for transaction: ${transactionId}`);
            return;
        }

        this.activePolls.set(pollKey, true);
        console.log(`🔄 Starting CashApp polling for user: ${userId}, transaction: ${transactionId}, orderNo: ${payOrderNo}`);

        try {
            await this.pollPayment(userId, transactionId, payOrderNo, createTime);
        } finally {
            this.activePolls.delete(pollKey);
        }
    }

    /**
     * Main polling loop
     */
    async pollPayment(userId, transactionId, payOrderNo, createTime) {
        let attempts = 0;

        while (attempts < this.maxPollingAttempts) {
            attempts++;
            console.log(`🔍 Polling attempt ${attempts}/${this.maxPollingAttempts} for transaction: ${transactionId}`);

            try {
                // Check payment status via API
                const status = await this.checkPaymentStatus(payOrderNo, createTime);

                if (status === 'SUCCESS') {
                    // Payment successful
                    await this.handleSuccessfulPayment(userId, transactionId, payOrderNo);
                    console.log(`✅ CashApp payment verified successfully: transaction=${transactionId}, orderNo=${payOrderNo}`);
                    break;
                    
                } else if (status === 'FAILED') {
                    // Payment failed
                    await this.handleFailedPayment(userId, transactionId, payOrderNo);
                    console.warn(`❌ CashApp payment failed: transaction=${transactionId}, orderNo=${payOrderNo}`);
                    break;
                    
                } else if (status === 'PENDING') {
                    // Still pending, continue polling
                    console.log(`⏳ CashApp payment still pending: transaction=${transactionId}`);
                }

                // Wait before next polling attempt
                await this.sleep(this.pollingIntervalSeconds * 1000);

            } catch (pollError) {
                console.error(`❌ Error during polling attempt ${attempts} for transaction: ${transactionId}`, pollError);
                
                // Continue polling even if one attempt fails, unless it's the last attempt
                if (attempts < this.maxPollingAttempts) {
                    await this.sleep(this.pollingIntervalSeconds * 1000);
                }
            }
        }

        // If max attempts reached and still not verified, mark as timeout/failed
        if (attempts >= this.maxPollingAttempts) {
            await this.handleTimeoutPayment(userId, transactionId, payOrderNo);
            console.warn(`⏰ CashApp payment polling timeout for transaction: ${transactionId}`);
        }
    }

    /**
     * Check payment status via API with auto token refresh
     * @param {string} orderNo - The order number
     * @param {string} createTime - Creation time (YYYY-MM-DD)
     * @returns {Promise<string>} - Returns 'SUCCESS', 'FAILED', or 'PENDING'
     */
    async checkPaymentStatus(orderNo, createTime) {
        try {
            const cashappConfig = await PaymentMethod.getConfig('cashapp');
            
            if (!cashappConfig || !cashappConfig.apiUrl) {
                throw new Error('CashApp configuration not found');
            }

            const queryData = {
                pageNumber: 1,
                pageSize: 10,
                sortColumn: "",
                sortOrder: "",
                sobId: "",
                treeCode: "",
                treeType: "",
                userId: "",
                dateType: "1",
                orderNo: orderNo, // Search by specific order number
                orderNos: "",
                orderNosType: "1",
                orderNosSample: "",
                isExclude: "0",
                mchNo: "",
                mchOrderNo: "",
                channelNo: "",
                unionChannel: "",
                channelOrderNo: "",
                orderType: "1",
                wayCode: "",
                currCode: "",
                channel: "",
                state: "",
                notifyState: "",
                settleState: "",
                freezeState: "",
                earnestState: "",
                refundState: "",
                repairState: "",
                minAmount: "",
                maxAmount: "",
                flowNo: "",
                errMsg: "",
                clientIp: "",
                clientId: "",
                deviceId: "",
                isDispute: "0",
                isRefund: "0",
                createTimeStart: createTime,
                createTimeEnd: createTime,
                isFormal: "",
                isHand: "0",
                isDaylight: "0",
                listType: "2",
                gemaNo: "",
                gemaTag: "",
                gemaMark: "",
                disputeState: ""
            };

            // Use authenticated request with auto token refresh
            const response = await makeAuthenticatedRequest(
                '/order/queryPage',
                queryData,
                cashappConfig
            );

            if (response.status === 200 && response.data && response.data.code === 200) {
                const records = response.data.data?.records || [];
                
                console.log(`   📊 Found ${records.length} order(s) for date ${createTime}`);
                
                // Find the specific order
                const order = records.find(r => r.orderNo === orderNo);
                
                if (order) {
                    const state = order.state;
                    const stateText = order.stateText;
                    const successTime = order.successTime;
                    
                    console.log(`   📝 Order found: ${orderNo}`);
                    console.log(`      State: ${state} (${stateText})`);
                    console.log(`      Amount: ${order.amount}`);
                    console.log(`      Success Time: ${successTime || 'N/A'}`);
                    
                    // state: "1" = 交易中 (Pending)
                    // state: "2" = 成功 (Success)
                    // state: "3" = 失败 (Failed)
                    
                    if (state === '2' || stateText === '成功' || successTime) {
                        console.log(`   ✅ Payment is SUCCESSFUL`);
                        return 'SUCCESS';
                    } else if (state === '3' || stateText === '失败') {
                        console.log(`   ❌ Payment is FAILED`);
                        return 'FAILED';
                    } else if (state === '1' || stateText === '交易中') {
                        console.log(`   ⏳ Payment is PENDING`);
                        return 'PENDING';
                    }
                } else {
                    console.log(`   ⚠️  Order ${orderNo} not found in response yet`);
                }
                
                // Order not found in response yet
                return 'PENDING';
            }

            // If response is not successful, assume still pending
            console.log(`   ⚠️  API response not successful, assuming PENDING`);
            return 'PENDING';

        } catch (error) {
            console.error('❌ Error checking CashApp payment status:', error.message);
            // On error, return PENDING to continue polling
            return 'PENDING';
        }
    }

    /**
     * Handle successful payment
     */
    /**
 * Handle successful payment
 */
async handleSuccessfulPayment(userId, transactionId, orderNo) {
    try {
        const wallet = await Wallet.findOne({ userId });
        if (!wallet) {
            throw new Error(`Wallet not found for user: ${userId}`);
        }

        const transaction = wallet.transactions.id(transactionId);
        if (!transaction) {
            throw new Error(`Transaction not found: ${transactionId}`);
        }

        // Check if already completed
        if (transaction.status === 'completed') {
            console.log(`Transaction already completed: ${transactionId}`);
            return;
        }

        console.log(`✅ CashApp payment verified - completing deposit with bonus check...`);

        // ✅ Use centralized helper for deposit completion with bonus
        const { completeDepositWithBonus } = require('../helpers/depositHelper');
        
        const result = await completeDepositWithBonus(
            wallet._id,
            transactionId,
            {
                completedBy: 'CashApp Polling',
                isManual: false,
                metadata: {
                    orderNo: orderNo,
                    verifiedBy: 'cashapp_polling',
                    verifiedAt: new Date().toISOString()
                }
            }
        );

        console.log(`✅ CashApp payment completed successfully:`);
        console.log(`   User ID: ${userId}`);
        console.log(`   Transaction ID: ${transactionId}`);
        console.log(`   Amount: $${result.transaction.amount}`);
        console.log(`   New Balance: $${result.wallet.balance}`);
        if (result.bonusInfo) {
            console.log(`   🎁 Bonus Applied: $${result.bonusInfo.amount} (${result.bonusInfo.description})`);
        }

    } catch (error) {
        console.error('❌ Error handling successful CashApp payment:', error);
        throw error;
    }
}

    /**
     * Handle failed payment
     */
    async handleFailedPayment(userId, transactionId, orderNo) {
        try {
            const wallet = await Wallet.findOne({ userId });
            if (!wallet) {
                throw new Error(`Wallet not found for user: ${userId}`);
            }

            const transaction = wallet.transactions.id(transactionId);
            if (!transaction) {
                throw new Error(`Transaction not found: ${transactionId}`);
            }

            // Check if already failed
            if (transaction.status === 'failed') {
                console.log(`Transaction already failed: ${transactionId}`);
                return;
            }

            // Update transaction status
            transaction.status = 'failed';
            transaction.failedAt = new Date();
            transaction.description = `Cashapp deposit - Payment failed`;
            transaction.notes = JSON.stringify({
                orderNo: orderNo,
                failedBy: 'cashapp_polling',
                failedAt: new Date().toISOString()
            });

            wallet.updatedAt = new Date();
            await wallet.save();

            console.log(`❌ CashApp payment marked as failed: userId=${userId}, transactionId=${transactionId}`);

        } catch (error) {
            console.error('❌ Error handling failed CashApp payment:', error);
            throw error;
        }
    }

    /**
     * Handle timeout payment (after 1 hour)
     */
    async handleTimeoutPayment(userId, transactionId, orderNo) {
        try {
            const wallet = await Wallet.findOne({ userId });
            if (!wallet) {
                throw new Error(`Wallet not found for user: ${userId}`);
            }

            const transaction = wallet.transactions.id(transactionId);
            if (!transaction) {
                throw new Error(`Transaction not found: ${transactionId}`);
            }

            // Check if already completed or failed
            if (transaction.status !== 'pending') {
                console.log(`Transaction already processed: ${transactionId}, status: ${transaction.status}`);
                return;
            }

            // Update transaction status to failed due to timeout
            transaction.status = 'failed';
            transaction.failedAt = new Date();
            transaction.description = `Cashapp deposit - Payment timeout after 1 hour`;
            transaction.notes = JSON.stringify({
                orderNo: orderNo,
                failedBy: 'cashapp_polling_timeout',
                failedAt: new Date().toISOString(),
                reason: 'Payment verification timeout after 1 hour'
            });

            wallet.updatedAt = new Date();
            await wallet.save();

            console.log(`⏰ CashApp payment marked as failed due to timeout: userId=${userId}, transactionId=${transactionId}`);

        } catch (error) {
            console.error('❌ Error handling timeout CashApp payment:', error);
            throw error;
        }
    }

    /**
     * Sleep helper function
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Check if polling is active for a transaction
     */
    isPollingActive(userId, transactionId) {
        const pollKey = `${userId}_${transactionId}`;
        return this.activePolls.has(pollKey);
    }

    /**
     * Get active polling count
     */
    getActivePollingCount() {
        return this.activePolls.size;
    }
}

// Export singleton instance
module.exports = new CashAppPollingService();