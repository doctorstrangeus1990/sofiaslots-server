// jobs/cashappPaymentCleanup.js
const cron = require('node-cron');
const Wallet = require('../models/Wallet');

/**
 * Cron job to mark CashApp payments as failed after 1 hour
 * Runs every 5 minutes to check for timed-out payments
 */
class CashAppPaymentCleanup {
    constructor() {
        this.isRunning = false;
    }

    /**
     * Start the cron job
     */
    start() {
        // Run every 5 minutes
        cron.schedule('*/5 * * * *', async () => {
            if (this.isRunning) {
                console.log('CashApp payment cleanup already running, skipping...');
                return;
            }

            try {
                this.isRunning = true;
                await this.cleanupTimedOutPayments();
            } catch (error) {
                console.error('Error in CashApp payment cleanup cron:', error);
            } finally {
                this.isRunning = false;
            }
        });

        console.log('CashApp payment cleanup cron job started (runs every 5 minutes)');
    }

    /**
     * Find and mark timed-out CashApp payments as failed
     */
    async cleanupTimedOutPayments() {
        try {
            console.log('Starting CashApp payment cleanup...');

            // Calculate 1 hour ago timestamp
            const oneHourAgo = new Date();
            oneHourAgo.setHours(oneHourAgo.getHours() - 1);

            // Find all wallets with pending CashApp transactions older than 1 hour
            const wallets = await Wallet.find({
                'transactions': {
                    $elemMatch: {
                        paymentMethod: 'cashapp',
                        status: 'pending',
                        createdAt: { $lt: oneHourAgo }
                    }
                }
            });

            let totalProcessed = 0;
            let totalFailed = 0;

            for (const wallet of wallets) {
                const timedOutTransactions = wallet.transactions.filter(tx => 
                    tx.paymentMethod === 'cashapp' &&
                    tx.status === 'pending' &&
                    new Date(tx.createdAt) < oneHourAgo
                );

                for (const transaction of timedOutTransactions) {
                    try {
                        totalProcessed++;

                        // Mark transaction as failed
                        transaction.status = 'failed';
                        transaction.failedAt = new Date();
                        transaction.description = `Cashapp deposit - Payment timeout after 1 hour (auto-failed by cron)`;

                        console.log(`Marking CashApp transaction as failed: userId=${wallet.userId}, transactionId=${transaction._id}, amount=${transaction.amount}`);
                        totalFailed++;

                    } catch (txError) {
                        console.error(`Error processing transaction ${transaction._id}:`, txError);
                    }
                }

                // Save wallet if any transactions were updated
                if (timedOutTransactions.length > 0) {
                    wallet.updatedAt = new Date();
                    await wallet.save();
                }
            }

            console.log(`CashApp payment cleanup completed: Processed ${totalProcessed} transactions, Failed ${totalFailed} transactions`);

            return {
                processed: totalProcessed,
                failed: totalFailed
            };

        } catch (error) {
            console.error('Error in cleanupTimedOutPayments:', error);
            throw error;
        }
    }

    /**
     * Manually trigger cleanup (useful for testing)
     */
    async runManually() {
        if (this.isRunning) {
            console.log('Cleanup is already running');
            return { success: false, message: 'Cleanup already in progress' };
        }

        try {
            this.isRunning = true;
            const result = await this.cleanupTimedOutPayments();
            return { success: true, result };
        } catch (error) {
            console.error('Error running manual cleanup:', error);
            return { success: false, error: error.message };
        } finally {
            this.isRunning = false;
        }
    }
}

// Export singleton instance
module.exports = new CashAppPaymentCleanup();