// helpers/depositHelper.js - COMPLETE WITH REFERRAL PROCESSING
const Wallet = require('../models/Wallet');
const Settings = require('../models/Settings');
const axios = require('axios');

// ✅ IMPORT THE REFERRAL PROCESSOR
const { processDepositReferral } = require('../controllers/referralController');

const sendTelegramNotification = async (data) => {
    try {
        const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
        const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

        if (!BOT_TOKEN || !CHAT_ID) {
            console.warn('⚠️  Telegram credentials not configured in .env');
            return;
        }

        const { type, username, email, amount, paymentMethod, transactionId, bonusInfo, referralInfo } = data;

        let message = '';

        if (type === 'deposit_completed') {
            message = `
🎉 <b>DEPOSIT COMPLETED</b>

👤 <b>User:</b> ${username}
💰 <b>Amount:</b> $${amount.toFixed(2)}
💳 <b>Method:</b> ${paymentMethod}
🆔 <b>Transaction ID:</b> ${transactionId}`;

            if (bonusInfo) {
                message += `\n\n🎁 <b>DEPOSIT BONUS:</b>
📊 <b>Type:</b> ${bonusInfo.type === 'first_deposit' ? 'First Deposit Bonus' : 'Promotional Bonus'}
💵 <b>Bonus Amount:</b> $${bonusInfo.amount.toFixed(2)}
📈 <b>Percentage:</b> ${bonusInfo.percentage}%`;
            }

            if (referralInfo) {
                message += `\n\n👥 <b>REFERRAL REWARD:</b>
🎯 <b>Referrer:</b> ${referralInfo.referrerUsername}
💰 <b>Earned:</b> $${referralInfo.rewardAmount.toFixed(2)} (${referralInfo.rewardType === 'high_reward' ? '10%' : '5%'})
📊 <b>Deposit #:</b> ${referralInfo.depositNumber}
💎 <b>Total Earned:</b> $${referralInfo.totalEarnings.toFixed(2)}`;
            }

            message += `\n\n⏰ <b>Time:</b> ${new Date().toLocaleString('en-US', { timeZone: 'UTC' })} UTC`;
        }

        const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
        
        await axios.post(url, {
            chat_id: CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        });

        console.log('✅ Telegram notification sent successfully');

    } catch (error) {
        console.error('❌ Error sending Telegram notification:', error.message);
    }
};

const completeDepositWithBonus = async (walletId, transactionId, options = {}) => {
    console.log('\n🔧 ═══════════════════════════════════════════════════');
    console.log('💰 DEPOSIT COMPLETION WITH BONUS HELPER');
    console.log('🔧 ═══════════════════════════════════════════════════');
    
    try {
        const {
            completedBy = 'System',
            completedByUserId = null,
            adminNotes = null,
            isManual = false,
            metadata = {}
        } = options;

        const wallet = await Wallet.findById(walletId).populate('userId', 'username email');
        if (!wallet) {
            throw new Error('Wallet not found');
        }

        const transaction = wallet.transactions.id(transactionId);
        if (!transaction) {
            throw new Error('Transaction not found');
        }

        console.log('📋 Transaction Details:');
        console.log('   Type:', transaction.type);
        console.log('   Amount:', `$${transaction.amount}`);
        console.log('   Status:', transaction.status);
        console.log('   Payment Method:', transaction.paymentMethod);
        console.log('   User ID:', wallet.userId._id);

        if (transaction.type !== 'deposit') {
            throw new Error('Only deposit transactions can be completed with bonus');
        }

        if (transaction.status !== 'pending') {
            throw new Error(`Transaction is already ${transaction.status}`);
        }

        const depositAmount = transaction.amount;

        console.log('\n💰 Balance State BEFORE:');
        console.log('   Balance:', wallet.balance);
        console.log('   Bonus Balance:', wallet.bonusBalance);
        console.log('   Available:', wallet.availableBalance);
        console.log('   Pending:', wallet.pendingBalance);

        // Mark transaction as completed
        transaction.status = 'completed';
        transaction.completedAt = new Date();
        transaction.description = transaction.description 
            ? `${transaction.description} - Completed by ${completedBy}`
            : `${transaction.paymentMethod || 'Deposit'} - Completed by ${completedBy}`;

        const txMetadata = {
            completedBy,
            completedByUserId,
            completedAt: new Date().toISOString(),
            originalStatus: 'pending',
            paymentMethod: transaction.paymentMethod,
            amount: transaction.amount,
            isManual,
            ...metadata
        };
        
        if (adminNotes) {
            txMetadata.adminNotes = adminNotes;
        }
        
        transaction.notes = JSON.stringify(txMetadata);

        // Add deposit to MAIN balance
        wallet.balance += depositAmount;
        transaction.balanceAfter = wallet.balance;

        console.log('\n🎁 Checking for deposit bonuses...');

        let bonusInfo = null;

        // Check for FIRST DEPOSIT BONUS
        const completedDepositsCount = wallet.transactions.filter(
            t => t._id.toString() !== transactionId.toString() && 
                 t.type === 'deposit' && 
                 t.status === 'completed' &&
                 !t.isBonus
        ).length;

        console.log(`   Previous completed deposits: ${completedDepositsCount}`);

        if (completedDepositsCount === 0) {
            console.log('   ✅ This is the FIRST deposit - checking first deposit bonus...');
            
            const settings = await Settings.getSettings();
            
            if (settings.firstDepositBonus.enabled) {
                if (depositAmount >= settings.firstDepositBonus.minDeposit) {
                    let bonusAmount = (depositAmount * settings.firstDepositBonus.percentage) / 100;
                    
                    if (settings.firstDepositBonus.maxBonus && bonusAmount > settings.firstDepositBonus.maxBonus) {
                        bonusAmount = settings.firstDepositBonus.maxBonus;
                    }
                    
                    console.log(`   🎉 First Deposit Bonus: ${settings.firstDepositBonus.percentage}% = $${bonusAmount}`);
                    
                    wallet.balance += bonusAmount;
                    
                    wallet.transactions.push({
                        type: 'deposit',
                        amount: bonusAmount,
                        description: `First Deposit Bonus (${settings.firstDepositBonus.percentage}% on $${depositAmount})`,
                        status: 'completed',
                        isBonus: true,
                        netAmount: bonusAmount,
                        balanceBefore: wallet.balance - bonusAmount,
                        balanceAfter: wallet.balance,
                        bonusBalanceBefore: wallet.bonusBalance,
                        bonusBalanceAfter: wallet.bonusBalance,
                        completedAt: new Date(),
                        metadata: {
                            source: 'first_deposit_bonus',
                            bonusType: 'first_deposit',
                            depositAmount: depositAmount,
                            bonusPercentage: settings.firstDepositBonus.percentage,
                            appliedAt: new Date().toISOString(),
                            relatedDepositId: transactionId
                        }
                    });
                    
                    bonusInfo = {
                        type: 'first_deposit',
                        amount: bonusAmount,
                        percentage: settings.firstDepositBonus.percentage,
                        description: `${settings.firstDepositBonus.percentage}% First Deposit Bonus`
                    };
                    
                    console.log(`   ✅ Added $${bonusAmount} to MAIN balance`);
                } else {
                    console.log(`   ❌ Deposit below minimum ($${settings.firstDepositBonus.minDeposit})`);
                }
            } else {
                console.log('   ❌ First deposit bonus is disabled');
            }
        } else {
            console.log('   ℹ️  Not first deposit - checking promotional bonus...');
            
            const settings = await Settings.getSettings();
            const activeBonus = settings.getActivePromotionalBonus();
            
            if (activeBonus && depositAmount >= activeBonus.minDeposit) {
                let bonusAmount = (depositAmount * activeBonus.bonusPercentage) / 100;
                
                if (activeBonus.maxBonus && bonusAmount > activeBonus.maxBonus) {
                    bonusAmount = activeBonus.maxBonus;
                }
                
                console.log(`   🎉 Promotional Bonus: ${activeBonus.bonusPercentage}% = $${bonusAmount}`);
                
                wallet.balance += bonusAmount;
                
                wallet.transactions.push({
                    type: 'deposit',
                    amount: bonusAmount,
                    description: `${activeBonus.title} (${activeBonus.bonusPercentage}% on $${depositAmount})`,
                    status: 'completed',
                    isBonus: true,
                    netAmount: bonusAmount,
                    balanceBefore: wallet.balance - bonusAmount,
                    balanceAfter: wallet.balance,
                    bonusBalanceBefore: wallet.bonusBalance,
                    bonusBalanceAfter: wallet.bonusBalance,
                    completedAt: new Date(),
                    metadata: {
                        source: 'promotional_bonus',
                        bonusType: activeBonus.bonusType,
                        campaignId: activeBonus._id,
                        campaignTitle: activeBonus.title,
                        depositAmount: depositAmount,
                        bonusPercentage: activeBonus.bonusPercentage,
                        appliedAt: new Date().toISOString(),
                        relatedDepositId: transactionId
                    }
                });
                
                bonusInfo = {
                    type: 'promotional',
                    amount: bonusAmount,
                    percentage: activeBonus.bonusPercentage,
                    description: activeBonus.title
                };
                
                console.log(`   ✅ Added $${bonusAmount} to MAIN balance`);
            } else {
                console.log('   ❌ No active promotional bonus');
            }
        }

        wallet.updateAvailableBalance();

        // ✅ Save wallet BEFORE processing referral
        await wallet.save();

        console.log('\n💰 Balance State AFTER Bonuses:');
        console.log('   Balance:', wallet.balance);
        console.log('   Bonus Balance:', wallet.bonusBalance);
        console.log('   Available:', wallet.availableBalance);
        console.log('   Pending:', wallet.pendingBalance);

        // ✅ CRITICAL: PROCESS REFERRAL REWARD
        let referralInfo = null;
        try {
            console.log('\n👥 Processing referral rewards...');
            console.log(`   Calling processDepositReferral(${wallet.userId._id}, ${depositAmount})`);
            
            const referralResult = await processDepositReferral(wallet.userId._id, depositAmount);
            
            if (referralResult.success) {
                referralInfo = {
                    referrerUsername: referralResult.referrerUsername || 'User',
                    rewardAmount: referralResult.rewardAmount,
                    rewardType: referralResult.rewardType,
                    depositNumber: referralResult.depositNumber,
                    totalEarnings: referralResult.totalEarnings
                };
                console.log('   ✅ Referral reward processed successfully');
                console.log(`      Referrer: ${referralInfo.referrerUsername}`);
                console.log(`      Amount: $${referralInfo.rewardAmount}`);
                console.log(`      Deposit #: ${referralInfo.depositNumber}`);
            } else {
                console.log('   ℹ️  No referral reward:', referralResult.message);
            }
        } catch (referralError) {
            console.error('   ❌ Error processing referral:', referralError);
            // Don't fail the deposit if referral processing fails
        }

        // Send Telegram notification
        console.log('\n📱 Sending Telegram notification...');
        await sendTelegramNotification({
            type: 'deposit_completed',
            username: wallet.userId.username,
            email: wallet.userId.email,
            amount: depositAmount,
            paymentMethod: transaction.paymentMethod || 'Unknown',
            transactionId: transaction._id.toString(),
            bonusInfo: bonusInfo,
            referralInfo: referralInfo
        });

        console.log('\n✅ Deposit completed successfully');
        console.log('🔧 ═══════════════════════════════════════════════════\n');

        return {
            success: true,
            transaction,
            bonusInfo,
            referralInfo,
            wallet: {
                userId: wallet.userId._id,
                balance: wallet.balance,
                bonusBalance: wallet.bonusBalance,
                availableBalance: wallet.availableBalance,
                availableBonusBalance: wallet.availableBonusBalance,
                pendingBalance: wallet.pendingBalance
            }
        };

    } catch (error) {
        console.error('\n❌ Error in completeDepositWithBonus:', error);
        console.log('🔧 ═══════════════════════════════════════════════════\n');
        throw error;
    }
};

module.exports = {
    completeDepositWithBonus
};