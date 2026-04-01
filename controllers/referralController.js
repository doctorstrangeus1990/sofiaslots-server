// controllers/referralController.js - FINAL COMPLETE VERSION
const Referral = require('../models/Referral');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const { validationResult } = require('express-validator');
const mongoose = require('mongoose');

// Generate referral code for user
const generateReferralCode = async (req, res) => {
  try {
    const userId = req.user.userId;
    const user = await User.findById(userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const existingTemplate = await Referral.findOne({
      referrerId: userId,
      referredUserId: null
    });

    let referralCode;
    
    if (existingTemplate) {
      referralCode = existingTemplate.referralCode;
      
      const actualReferrals = await Referral.countDocuments({
        referrerId: userId,
        referredUserId: { $ne: null }
      });

      const activeReferrals = await Referral.countDocuments({
        referrerId: userId,
        referredUserId: { $ne: null },
        status: { $in: ['pending', 'active'] }
      });

      const baseUrl = process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;
      
      return res.json({
        success: true,
        message: 'Referral code retrieved successfully',
        data: {
          referralCode,
          referralLink: `${baseUrl}/register?ref=${referralCode}`,
          rewards: {
            referrerReward: '10% of first 5 deposits + 5% lifetime',
            referredReward: 0,
            maxHighRewards: 5,
            lifetimeRate: 5
          },
          totalReferrals: actualReferrals,
          activeReferrals: activeReferrals
        }
      });
    }

    let isUnique = false;
    let attempts = 0;
    const maxAttempts = 10;

    while (!isUnique && attempts < maxAttempts) {
      referralCode = Referral.generateReferralCode(user.username);
      const existing = await Referral.findOne({ 
        referralCode,
        referredUserId: null 
      });
      if (!existing) {
        isUnique = true;
      }
      attempts++;
    }

    if (!isUnique) {
      return res.status(500).json({
        success: false,
        message: 'Unable to generate unique referral code'
      });
    }

    await Referral.create({
      referrerId: userId,
      referredUserId: null,
      referralCode,
      status: 'pending',
      rewards: {
        referrerReward: 0,
        referredReward: 0,
        rewardType: 'percentage'
      },
      conditions: {
        minDeposit: 10,
        minGamesPlayed: 0,
        maxRewardDeposits: 5,
        lifetimeRewardRate: 5
      },
      metadata: {
        depositCount: 0,
        totalReferralEarnings: 0,
        highRewardEarnings: 0,
        lifetimeEarnings: 0
      }
    });

    const baseUrl = process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;
    
    res.json({
      success: true,
      message: 'Referral code generated successfully',
      data: {
        referralCode,
        referralLink: `${baseUrl}/register?ref=${referralCode}`,
        rewards: {
          referrerReward: '10% of first 5 deposits + 5% lifetime',
          referredReward: 0,
          maxHighRewards: 5,
          lifetimeRate: 5
        }
      }
    });

  } catch (error) {
    console.error('Generate referral code error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error occurred'
    });
  }
};

const applyReferralCode = async (req, res) => {
  try {
    const { referralCode, newUserId } = req.body;

    if (!referralCode || !newUserId) {
      return res.status(400).json({
        success: false,
        message: 'Referral code and new user ID are required'
      });
    }

    const referralTemplate = await Referral.findOne({
      referralCode: referralCode.toUpperCase()
    }).populate('referrerId', 'username');

    if (!referralTemplate) {
      return res.status(404).json({
        success: false,
        message: 'Invalid referral code'
      });
    }

    const newUser = await User.findById(newUserId);
    if (!newUser) {
      return res.status(404).json({
        success: false,
        message: 'New user not found'
      });
    }

    if (referralTemplate.referrerId._id.toString() === newUserId) {
      return res.status(400).json({
        success: false,
        message: 'Cannot refer yourself'
      });
    }

    const alreadyReferred = await Referral.findOne({
      referredUserId: newUserId
    });

    if (alreadyReferred) {
      return res.status(400).json({
        success: false,
        message: 'User has already been referred'
      });
    }

    await User.findByIdAndUpdate(newUserId, {
      affiliateId: referralTemplate.referrerId._id
    });

    await Referral.create({
      referrerId: referralTemplate.referrerId._id,
      referredUserId: newUserId,
      referralCode: referralCode.toUpperCase(),
      status: 'pending',
      rewards: {
        referrerReward: 0,
        referredReward: 0,
        rewardType: 'percentage'
      },
      conditions: {
        minDeposit: 10,
        minGamesPlayed: 0,
        maxRewardDeposits: 5,
        lifetimeRewardRate: 5
      },
      metadata: {
        referredUserIP: req.ip,
        referredUserAgent: req.get('User-Agent'),
        referralSource: 'code',
        depositCount: 0,
        totalReferralEarnings: 0,
        highRewardEarnings: 0,
        lifetimeEarnings: 0
      }
    });

    res.json({
      success: true,
      message: 'Referral applied successfully',
      data: {
        referrerUsername: referralTemplate.referrerId.username,
        rewards: {
          referrerReward: '10% of first 5 deposits + 5% lifetime',
          referredReward: 0
        }
      }
    });

  } catch (error) {
    console.error('Apply referral code error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error occurred'
    });
  }
};

// ✅ PROCESS REFERRAL REWARD - Adds to MAIN balance with type: 'bonus', isBonus: true
const processDepositReferral = async (userId, depositAmount) => {
  try {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('💰 PROCESSING REFERRAL REWARD');
    console.log(`   User: ${userId}`);
    console.log(`   Deposit Amount: $${depositAmount}`);
    
    // ✅ Find referral - Accept BOTH 'pending' and 'active' statuses
    const referral = await Referral.findOne({
      referredUserId: userId,
      status: { $in: ['pending', 'active'] }
    }).populate('referrerId', 'username');

    if (!referral) {
      console.log('   ❌ No active referral found');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      return { success: false, message: 'No referral found' };
    }

    console.log(`   ✅ Referral Found: ${referral.referralCode}`);
    console.log(`   Referrer: ${referral.referrerId.username} (${referral.referrerId._id})`);

    // Check minimum deposit amount
    if (depositAmount < (referral.conditions?.minDeposit || 10)) {
      console.log(`   ❌ Deposit below minimum ($${referral.conditions?.minDeposit || 10})`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      return { success: false, message: 'Deposit amount below minimum' };
    }

    const depositCount = referral.metadata?.depositCount || 0;
    const maxHighRewards = referral.conditions?.maxRewardDeposits || 5;
    const lifetimeRate = referral.conditions?.lifetimeRewardRate || 5;

    console.log(`   Current Deposit Count: ${depositCount}`);
    console.log(`   Max High Reward Deposits: ${maxHighRewards}`);

    let rewardAmount = 0;
    let rewardType = '';

    // Determine reward rate
    if (depositCount < maxHighRewards) {
      // First 5 deposits: 10%
      rewardAmount = depositAmount * 0.10;
      rewardType = 'high_reward';
      console.log(`   💎 HIGH REWARD (10%) - Deposit #${depositCount + 1}/${maxHighRewards}`);
    } else {
      // After 5th deposit: 5% lifetime
      rewardAmount = depositAmount * (lifetimeRate / 100);
      rewardType = 'lifetime_reward';
      console.log(`   ♾️  LIFETIME REWARD (${lifetimeRate}%) - Deposit #${depositCount + 1}`);
    }

    console.log(`   Reward Amount: $${rewardAmount.toFixed(2)}`);

    // ✅ Award reward to referrer's MAIN BALANCE
    const referrerWallet = await Wallet.findOrCreateWallet(referral.referrerId._id);
    
    console.log(`   📊 Referrer Wallet Before:`);
    console.log(`      Balance: $${referrerWallet.balance}`);
    console.log(`      Available: $${referrerWallet.availableBalance}`);
    
    // ✅ Add transaction to MAIN balance (type: 'deposit', isBonus: true - like promotional bonus)
    const rewardTransaction = referrerWallet.addTransaction({
      type: 'deposit', // ✅ Use 'deposit' type so it goes to MAIN balance
      amount: rewardAmount,
      description: `Referral bonus - ${referral.referredUserId?.username || 'User'} deposit ${depositCount + 1} (${rewardType === 'high_reward' ? '10%' : lifetimeRate + '%'})`,
      status: 'completed',
      isBonus: true, // ✅ Flag as bonus for tracking
      netAmount: rewardAmount,
      completedAt: new Date(),
      referenceId: referral._id,
      metadata: {
        source: 'referral_program',
        rewardType: rewardType,
        depositNumber: depositCount + 1,
        depositAmount: depositAmount,
        bonusPercentage: rewardType === 'high_reward' ? 10 : lifetimeRate,
        referredUserId: userId,
        referralCode: referral.referralCode
      }
    });

    await referrerWallet.save();

    console.log(`   ✅ Reward added to referrer's MAIN wallet`);
    console.log(`   📊 Referrer Wallet After:`);
    console.log(`      Balance: $${referrerWallet.balance}`);
    console.log(`      Available: $${referrerWallet.availableBalance}`);
    console.log(`      Transaction ID: ${rewardTransaction._id}`);

    // ✅ Update referral metadata
    referral.metadata.depositCount = depositCount + 1;
    referral.metadata.totalReferralEarnings = (referral.metadata.totalReferralEarnings || 0) + rewardAmount;
    
    if (rewardType === 'high_reward') {
      referral.metadata.highRewardEarnings = (referral.metadata.highRewardEarnings || 0) + rewardAmount;
    } else {
      referral.metadata.lifetimeEarnings = (referral.metadata.lifetimeEarnings || 0) + rewardAmount;
    }

    await referral.save();

    console.log(`   📊 Updated Referral Stats:`);
    console.log(`      Total Deposits: ${referral.metadata.depositCount}`);
    console.log(`      Total Earnings: $${referral.metadata.totalReferralEarnings.toFixed(2)}`);
    console.log(`      High Reward Earnings: $${(referral.metadata.highRewardEarnings || 0).toFixed(2)}`);
    console.log(`      Lifetime Earnings: $${(referral.metadata.lifetimeEarnings || 0).toFixed(2)}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    return {
      success: true,
      rewardAmount,
      rewardType,
      depositNumber: depositCount + 1,
      totalEarnings: referral.metadata.totalReferralEarnings,
      transactionId: rewardTransaction._id,
      referrerUsername: referral.referrerId.username
    };

  } catch (error) {
    console.error('❌ Process deposit referral error:', error);
    throw error;
  }
};

const getReferralStats = async (req, res) => {
  try {
    const userId = req.user.userId;

    // ✅ Get actual referrals (exclude templates) - Accept all non-cancelled statuses
    const referrals = await Referral.find({ 
      referrerId: userId,
      referredUserId: { $ne: null },
      status: { $ne: 'cancelled' }
    })
      .populate('referredUserId', 'username profile.firstName profile.lastName account.createdAt')
      .sort({ createdAt: -1 });

    const stats = {
      totalReferrals: referrals.length,
      activeReferrals: 0,
      pendingReferrals: 0,
      totalEarnings: 0,
      highRewardEarnings: 0,
      lifetimeEarnings: 0
    };

    referrals.forEach(ref => {
      if (ref.status === 'pending' || ref.status === 'active') {
        stats.activeReferrals++;
      }
      if (ref.status === 'pending') {
        stats.pendingReferrals++;
      }
      
      if (ref.metadata?.totalReferralEarnings) {
        stats.totalEarnings += ref.metadata.totalReferralEarnings;
      }
      if (ref.metadata?.highRewardEarnings) {
        stats.highRewardEarnings += ref.metadata.highRewardEarnings;
      }
      if (ref.metadata?.lifetimeEarnings) {
        stats.lifetimeEarnings += ref.metadata.lifetimeEarnings;
      }
    });

    // Get deposit history for each referral
    const formattedReferrals = await Promise.all(
      referrals.map(async (ref) => {
        let depositHistory = [];
        
        try {
          const referredWallet = await Wallet.findOne({ userId: ref.referredUserId._id });
          
          if (referredWallet) {
            depositHistory = referredWallet.transactions
              .filter(t => 
                t.type === 'deposit' && 
                t.status === 'completed' &&
                new Date(t.createdAt) >= new Date(ref.createdAt) &&
                !t.isBonus // Only real deposits
              )
              .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
              .map((deposit, index) => {
                const depositNumber = index + 1;
                const maxHighRewards = ref.conditions?.maxRewardDeposits || 5;
                const lifetimeRate = ref.conditions?.lifetimeRewardRate || 5;
                const isHighReward = depositNumber <= maxHighRewards;
                const rewardRate = isHighReward ? 10 : lifetimeRate;
                
                return {
                  depositNumber,
                  amount: deposit.amount,
                  rewardEarned: deposit.amount * (rewardRate / 100),
                  rewardRate,
                  rewardType: isHighReward ? 'high' : 'lifetime',
                  date: deposit.createdAt,
                  transactionId: deposit._id
                };
              });
          }
        } catch (error) {
          console.error(`Error fetching deposits for referral ${ref._id}:`, error);
        }

        return {
          _id: ref._id,
          referralCode: ref.referralCode,
          referredUser: ref.referredUserId ? {
            username: ref.referredUserId.username,
            firstName: ref.referredUserId.profile?.firstName || '',
            lastName: ref.referredUserId.profile?.lastName || '',
            joinedAt: ref.referredUserId.account?.createdAt
          } : null,
          status: ref.status,
          depositCount: ref.metadata?.depositCount || 0,
          maxHighRewards: ref.conditions?.maxRewardDeposits || 5,
          lifetimeRate: ref.conditions?.lifetimeRewardRate || 5,
          earnings: ref.metadata?.totalReferralEarnings || 0,
          highRewardEarnings: ref.metadata?.highRewardEarnings || 0,
          lifetimeEarnings: ref.metadata?.lifetimeEarnings || 0,
          depositHistory: depositHistory,
          createdAt: ref.createdAt,
          completedAt: ref.completedAt
        };
      })
    );

    res.json({
      success: true,
      message: 'Referral statistics retrieved successfully',
      data: {
        stats,
        referrals: formattedReferrals
      }
    });

  } catch (error) {
    console.error('Get referral stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error occurred'
    });
  }
};

const validateReferralCode = async (req, res) => {
  try {
    const { code } = req.params;

    const referral = await Referral.findOne({
      referralCode: code.toUpperCase(),
      status: { $in: ['pending', 'active'] }
    }).populate('referrerId', 'username profile.firstName profile.lastName');

    if (!referral) {
      return res.status(404).json({
        success: false,
        message: 'Invalid referral code'
      });
    }

    res.json({
      success: true,
      message: 'Valid referral code',
      data: {
        referrerInfo: {
          username: referral.referrerId.username,
          name: `${referral.referrerId.profile?.firstName || ''} ${referral.referrerId.profile?.lastName || ''}`.trim()
        },
        rewards: {
          referrerReward: '10% of first 5 deposits + 5% lifetime',
          referredReward: 0,
          maxHighRewards: 5,
          lifetimeRate: 5
        },
        conditions: referral.conditions
      }
    });

  } catch (error) {
    console.error('Validate referral code error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error occurred'
    });
  }
};

const getMyCode = async (req, res) => {
  try {
    const userId = req.user.userId;
    
    let referral = await Referral.findOne({
      referrerId: userId,
      referredUserId: null
    });

    if (!referral) {
      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      let referralCode;
      let isUnique = false;
      let attempts = 0;

      while (!isUnique && attempts < 10) {
        referralCode = Referral.generateReferralCode(user.username);
        const existing = await Referral.findOne({ referralCode });
        if (!existing) {
          isUnique = true;
        }
        attempts++;
      }

      referral = await Referral.create({
        referrerId: userId,
        referredUserId: null,
        referralCode,
        status: 'pending',
        rewards: {
          referrerReward: 0,
          referredReward: 0,
          rewardType: 'percentage'
        },
        conditions: {
          minDeposit: 10,
          minGamesPlayed: 0,
          maxRewardDeposits: 5,
          lifetimeRewardRate: 5
        },
        metadata: {
          depositCount: 0,
          totalReferralEarnings: 0,
          highRewardEarnings: 0,
          lifetimeEarnings: 0
        }
      });
    }

    const baseUrl = process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;

    res.json({
      success: true,
      message: 'Referral code retrieved successfully',
      data: {
        referralCode: referral.referralCode,
        referralLink: `${baseUrl}/register?ref=${referral.referralCode}`,
        rewards: {
          referrerReward: '10% of first 5 deposits + 5% lifetime',
          referredReward: 0,
          maxHighRewards: 5,
          lifetimeRate: 5
        },
        createdAt: referral.createdAt
      }
    });

  } catch (error) {
    console.error('Get my referral code error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error occurred'
    });
  }
};

const getLeaderboard = async (req, res) => {
  try {
    const leaderboard = await Referral.aggregate([
      { $match: { referredUserId: { $ne: null }, status: { $ne: 'cancelled' } } },
      {
        $group: {
          _id: '$referrerId',
          totalReferrals: { $sum: 1 },
          activeReferrals: {
            $sum: { $cond: [{ $in: ['$status', ['pending', 'active']] }, 1, 0] }
          },
          totalEarnings: { $sum: { $ifNull: ['$metadata.totalReferralEarnings', 0] } }
        }
      },
      { $sort: { totalEarnings: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user',
          pipeline: [
            { $project: { username: 1, 'profile.firstName': 1, 'profile.lastName': 1 } }
          ]
        }
      },
      { $unwind: '$user' },
      {
        $project: {
          username: '$user.username',
          name: {
            $trim: {
              input: {
                $concat: [
                  { $ifNull: ['$user.profile.firstName', ''] },
                  ' ',
                  { $ifNull: ['$user.profile.lastName', ''] }
                ]
              }
            }
          },
          totalReferrals: 1,
          activeReferrals: 1,
          totalEarnings: { $round: ['$totalEarnings', 2] }
        }
      }
    ]);

    res.json({
      success: true,
      message: 'Referral leaderboard retrieved successfully',
      data: { leaderboard }
    });

  } catch (error) {
    console.error('Get referral leaderboard error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error occurred'
    });
  }
};

module.exports = {
  generateReferralCode,
  applyReferralCode,
  getReferralStats,
  validateReferralCode,
  getMyCode,
  getLeaderboard,
  processDepositReferral
};