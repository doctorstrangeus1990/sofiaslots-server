// controllers/adminSpinWheelController.js
const SpinReward = require('../models/SpinReward');
const SpinConfiguration = require('../models/SpinConfiguration');
const Wallet = require('../models/Wallet');

// Get all spin rewards with filters (admin)
const getAllSpinRewards = async (req, res) => {
  try {
    const { page = 1, limit = 20, userId, rewardType, status, startDate, endDate } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    // Build filter
    const filter = {};
    if (userId) filter.userId = userId;
    if (rewardType) filter.rewardType = rewardType;
    if (status) filter.claimed = status === 'claimed';
    if (startDate && endDate) {
      filter.spinDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    const spinRewards = await SpinReward.find(filter)
      .populate('userId', 'username email')
      .sort({ spinDate: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    const total = await SpinReward.countDocuments(filter);
    
    res.json({
      success: true,
      message: 'Spin rewards retrieved successfully',
      data: {
        spinRewards,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(total / parseInt(limit)),
          totalRewards: total,
          hasNextPage: skip + parseInt(limit) < total,
          hasPrevPage: page > 1
        },
        filters: { userId, rewardType, status, startDate, endDate }
      }
    });
    
  } catch (error) {
    console.error('Error getting all spin rewards:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving spin rewards'
    });
  }
};

// Get single spin reward (admin)
const getSpinReward = async (req, res) => {
  try {
    const { rewardId } = req.params;
    
    const spinReward = await SpinReward.findById(rewardId)
      .populate('userId', 'username email createdAt');
    
    if (!spinReward) {
      return res.status(404).json({
        success: false,
        message: 'Spin reward not found'
      });
    }
    
    res.json({
      success: true,
      message: 'Spin reward retrieved successfully',
      data: { spinReward }
    });
    
  } catch (error) {
    console.error('Error getting spin reward:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving spin reward'
    });
  }
};

// Update spin reward status (admin)
const updateRewardStatus = async (req, res) => {
  try {
    const { rewardId } = req.params;
    const { claimed, notes } = req.body;
    
    const spinReward = await SpinReward.findById(rewardId);
    
    if (!spinReward) {
      return res.status(404).json({
        success: false,
        message: 'Spin reward not found'
      });
    }
    
    if (claimed !== undefined) {
      spinReward.claimed = claimed;
      if (claimed) {
        spinReward.claimedAt = new Date();
      }
    }
    
    if (notes) {
      spinReward.adminNotes = notes;
    }
    
    await spinReward.save();
    
    res.json({
      success: true,
      message: 'Reward status updated successfully',
      data: { reward: spinReward }
    });
    
  } catch (error) {
    console.error('Error updating reward status:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating reward status'
    });
  }
};

// Soft delete spin reward (admin)
const deleteSpinReward = async (req, res) => {
  try {
    const { rewardId } = req.params;
    const { reason } = req.body;
    
    const spinReward = await SpinReward.findById(rewardId);
    
    if (!spinReward) {
      return res.status(404).json({
        success: false,
        message: 'Spin reward not found'
      });
    }
    
    spinReward.isDeleted = true;
    spinReward.deletedAt = new Date();
    spinReward.deletionReason = reason || 'Deleted by admin';
    
    await spinReward.save();
    
    res.json({
      success: true,
      message: 'Spin reward deleted successfully',
      data: { rewardId }
    });
    
  } catch (error) {
    console.error('Error deleting spin reward:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting spin reward'
    });
  }
};

// Get current spin configuration (admin) - NOW USES DATABASE
const getSpinConfig = async (req, res) => {
  try {
    // Get configuration from database
    const config = await SpinConfiguration.getOrCreateDefault();
    
    // Get configuration stats
    const totalSpins = await SpinReward.countDocuments();
    const todaySpins = await SpinReward.countDocuments({
      spinDate: {
        $gte: new Date(new Date().setHours(0, 0, 0, 0))
      }
    });
    
    const thisWeekSpins = await SpinReward.countDocuments({
      spinDate: {
        $gte: new Date(new Date().setDate(new Date().getDate() - 7))
      }
    });
    
    res.json({
      success: true,
      message: 'Spin configuration retrieved successfully',
      data: {
        segments: config.segments,
        dailySpinLimit: config.dailySpinLimit,
        rewardExpiryHours: config.rewardExpiryHours,
        isSpinWheelActive: config.isSpinWheelActive,
        stats: {
          totalSpins,
          todaySpins,
          thisWeekSpins,
          segmentCount: config.segments.length
        }
      }
    });
    
  } catch (error) {
    console.error('Error getting spin config:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving spin configuration'
    });
  }
};

// Update spin configuration (admin) - NOW SAVES TO DATABASE
const updateSpinConfig = async (req, res) => {
  try {
    const { segments, dailySpinLimit, rewardExpiryHours, isSpinWheelActive } = req.body;
    
    console.log('Received update request:', { segments: segments?.length, dailySpinLimit, rewardExpiryHours, isSpinWheelActive });
    
    if (!segments || !Array.isArray(segments)) {
      return res.status(400).json({
        success: false,
        message: 'Valid segments array is required'
      });
    }
    
    // Validate segments structure
    for (const segment of segments) {
      if (segment.id === undefined || !segment.label || !segment.type || segment.weight === undefined) {
        console.log('Invalid segment:', segment);
        return res.status(400).json({
          success: false,
          message: 'Each segment must have id, label, type, and weight',
          invalidSegment: segment
        });
      }
      
      // Additional validation
      if (!['cash', 'freeplay', 'deposit_bonus', 'vip_xp', 'retry'].includes(segment.type)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid segment type: ' + segment.type
        });
      }
      
      if (segment.weight <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Weight must be greater than 0'
        });
      }
    }
    
    // Get existing configuration
    const config = await SpinConfiguration.getOrCreateDefault();
    
    // Update segments
    await config.updateSegments(segments, req.user?.userId);
    
    // Update global settings if provided
    if (dailySpinLimit !== undefined) {
      config.dailySpinLimit = dailySpinLimit;
    }
    if (rewardExpiryHours !== undefined) {
      config.rewardExpiryHours = rewardExpiryHours;
    }
    if (isSpinWheelActive !== undefined) {
      config.isSpinWheelActive = isSpinWheelActive;
    }
    
    // Save configuration
    await config.save();
    
    res.json({
      success: true,
      message: 'Spin configuration updated successfully',
      data: { 
        segments: config.segments,
        dailySpinLimit: config.dailySpinLimit,
        rewardExpiryHours: config.rewardExpiryHours,
        isSpinWheelActive: config.isSpinWheelActive
      }
    });
    
  } catch (error) {
    console.error('Error updating spin config:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating spin configuration'
    });
  }
};

// Update global spin settings (admin) - NEW ENDPOINT
const updateGlobalSettings = async (req, res) => {
  try {
    const { dailySpinLimit, rewardExpiryHours, isSpinWheelActive } = req.body;
    
    // Get existing configuration
    const config = await SpinConfiguration.getOrCreateDefault();
    
    // Update settings
    if (dailySpinLimit !== undefined) {
      config.dailySpinLimit = dailySpinLimit;
    }
    if (rewardExpiryHours !== undefined) {
      config.rewardExpiryHours = rewardExpiryHours;
    }
    if (isSpinWheelActive !== undefined) {
      config.isSpinWheelActive = isSpinWheelActive;
    }
    
    config.updatedBy = req.user?.userId;
    await config.save();
    
    res.json({
      success: true,
      message: 'Global settings updated successfully',
      data: {
        dailySpinLimit: config.dailySpinLimit,
        rewardExpiryHours: config.rewardExpiryHours,
        isSpinWheelActive: config.isSpinWheelActive
      }
    });
    
  } catch (error) {
    console.error('Error updating global settings:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating global settings'
    });
  }
};

// Get spin analytics (admin)
const getSpinAnalytics = async (req, res) => {
  try {
    const { startDate, endDate, groupBy = 'day' } = req.query;
    
    const matchCondition = {};
    if (startDate && endDate) {
      matchCondition.spinDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    // Basic analytics
    const analytics = await SpinReward.aggregate([
      { $match: matchCondition },
      {
        $group: {
          _id: '$rewardType',
          count: { $sum: 1 },
          totalValue: { 
            $sum: { 
              $cond: [
                { $eq: ['$rewardType', 'cash'] }, 
                { $toDouble: '$rewardValue' }, 
                0 
              ]
            }
          },
          claimed: { $sum: { $cond: ['$claimed', 1, 0] } },
          unclaimed: { $sum: { $cond: [{ $not: '$claimed' }, 1, 0] } }
        }
      }
    ]);
    
    // Total spins
    const totalSpins = await SpinReward.countDocuments(matchCondition);
    
    // Unique users who spun
    const uniqueUsers = await SpinReward.distinct('userId', matchCondition);
    
    // Daily breakdown if requested
    let dailyBreakdown = null;
    if (groupBy === 'day') {
      dailyBreakdown = await SpinReward.aggregate([
        { $match: matchCondition },
        {
          $group: {
            _id: {
              $dateToString: { format: "%Y-%m-%d", date: "$spinDate" }
            },
            spins: { $sum: 1 },
            cashRewards: {
              $sum: {
                $cond: [
                  { $eq: ['$rewardType', 'cash'] },
                  { $toDouble: '$rewardValue' },
                  0
                ]
              }
            }
          }
        },
        { $sort: { '_id': -1 } },
        { $limit: 30 }
      ]);
    }
    
    res.json({
      success: true,
      message: 'Spin analytics retrieved successfully',
      data: {
        analytics,
        totalSpins,
        uniqueUsers: uniqueUsers.length,
        dailyBreakdown,
        dateRange: { startDate, endDate }
      }
    });
    
  } catch (error) {
    console.error('Error getting spin analytics:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving spin analytics'
    });
  }
};

// Get detailed reports (admin)
const getDetailedReports = async (req, res) => {
  try {
    const { startDate, endDate, reportType = 'summary' } = req.query;
    
    const matchCondition = {};
    if (startDate && endDate) {
      matchCondition.spinDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    let reportData = {};
    
    switch (reportType) {
      case 'summary':
        reportData = await SpinReward.aggregate([
          { $match: matchCondition },
          {
            $group: {
              _id: null,
              totalSpins: { $sum: 1 },
              totalCashValue: {
                $sum: {
                  $cond: [
                    { $eq: ['$rewardType', 'cash'] },
                    { $toDouble: '$rewardValue' },
                    0
                  ]
                }
              },
              totalClaimed: { $sum: { $cond: ['$claimed', 1, 0] } },
              avgSpinValue: { $avg: { $toDouble: '$rewardValue' } }
            }
          }
        ]);
        break;
        
      case 'user_activity':
        reportData = await SpinReward.aggregate([
          { $match: matchCondition },
          {
            $group: {
              _id: '$userId',
              spins: { $sum: 1 },
              totalWon: {
                $sum: {
                  $cond: [
                    { $eq: ['$rewardType', 'cash'] },
                    { $toDouble: '$rewardValue' },
                    0
                  ]
                }
              }
            }
          },
          { $sort: { spins: -1 } },
          { $limit: 50 }
        ]);
        break;
        
      default:
        reportData = { message: 'Invalid report type' };
    }
    
    res.json({
      success: true,
      message: 'Detailed report retrieved successfully',
      data: {
        reportType,
        reportData,
        dateRange: { startDate, endDate }
      }
    });
    
  } catch (error) {
    console.error('Error getting detailed reports:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving detailed reports'
    });
  }
};

// Export spin data (admin)
const exportSpinData = async (req, res) => {
  try {
    const { startDate, endDate, format = 'json' } = req.query;
    
    const matchCondition = {};
    if (startDate && endDate) {
      matchCondition.spinDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    const spinData = await SpinReward.find(matchCondition)
      .populate('userId', 'username email')
      .sort({ spinDate: -1 })
      .lean();
    
    if (format === 'csv') {
      // For CSV format, you'd typically use a CSV library here
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=spin_data.csv');
      // Implement CSV conversion logic here
      res.json({
        success: false,
        message: 'CSV export not implemented yet'
      });
    } else {
      res.json({
        success: true,
        message: 'Spin data exported successfully',
        data: {
          exportDate: new Date(),
          totalRecords: spinData.length,
          dateRange: { startDate, endDate },
          spinData
        }
      });
    }
    
  } catch (error) {
    console.error('Error exporting spin data:', error);
    res.status(500).json({
      success: false,
      message: 'Error exporting spin data'
    });
  }
};

// Get users with spin history (admin)
const getUsersWithSpins = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const usersWithSpins = await SpinReward.aggregate([
      {
        $group: {
          _id: '$userId',
          totalSpins: { $sum: 1 },
          totalCashWon: {
            $sum: {
              $cond: [
                { $eq: ['$rewardType', 'cash'] },
                { $toDouble: '$rewardValue' },
                0
              ]
            }
          },
          lastSpin: { $max: '$spinDate' },
          claimedRewards: { $sum: { $cond: ['$claimed', 1, 0] } }
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'userInfo'
        }
      },
      { $unwind: '$userInfo' },
      { $sort: { totalSpins: -1 } },
      { $skip: skip },
      { $limit: parseInt(limit) }
    ]);
    
    const totalUsers = await SpinReward.distinct('userId');
    
    res.json({
      success: true,
      message: 'Users with spins retrieved successfully',
      data: {
        users: usersWithSpins,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(totalUsers.length / parseInt(limit)),
          totalUsers: totalUsers.length,
          hasNextPage: skip + parseInt(limit) < totalUsers.length,
          hasPrevPage: page > 1
        }
      }
    });
    
  } catch (error) {
    console.error('Error getting users with spins:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving users with spins'
    });
  }
};

// Get specific user's spin history (admin)
const getUserSpinHistory = async (req, res) => {
  try {
    const { userId } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const userSpins = await SpinReward.find({ userId })
      .sort({ spinDate: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    const totalSpins = await SpinReward.countDocuments({ userId });
    
    // Get user summary
    const summary = await SpinReward.aggregate([
      { $match: { userId: userId } },
      {
        $group: {
          _id: null,
          totalSpins: { $sum: 1 },
          totalCashWon: {
            $sum: {
              $cond: [
                { $eq: ['$rewardType', 'cash'] },
                { $toDouble: '$rewardValue' },
                0
              ]
            }
          },
          claimedRewards: { $sum: { $cond: ['$claimed', 1, 0] } }
        }
      }
    ]);
    
    res.json({
      success: true,
      message: 'User spin history retrieved successfully',
      data: {
        userSpins,
        summary: summary[0] || { totalSpins: 0, totalCashWon: 0, claimedRewards: 0 },
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(totalSpins / parseInt(limit)),
          totalSpins,
          hasNextPage: skip + parseInt(limit) < totalSpins,
          hasPrevPage: page > 1
        }
      }
    });
    
  } catch (error) {
    console.error('Error getting user spin history:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving user spin history'
    });
  }
};

// Reset user's daily spin (emergency use) (admin)
const resetUserSpin = async (req, res) => {
  try {
    const { userId } = req.params;
    const { reason } = req.body;
    
    if (!reason) {
      return res.status(400).json({
        success: false,
        message: 'Reason for reset is required'
      });
    }
    
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);
    
    // Find today's spin
    const todaysSpin = await SpinReward.findOne({
      userId,
      spinDate: {
        $gte: startOfDay,
        $lte: endOfDay
      }
    });
    
    if (!todaysSpin) {
      return res.status(404).json({
        success: false,
        message: 'No spin found for today for this user'
      });
    }
    
    // Mark as reset (soft delete with reason)
    todaysSpin.isReset = true;
    todaysSpin.resetReason = reason;
    todaysSpin.resetAt = new Date();
    
    await todaysSpin.save();
    
    res.json({
      success: true,
      message: 'User daily spin reset successfully',
      data: {
        userId,
        reason,
        resetAt: new Date()
      }
    });
    
  } catch (error) {
    console.error('Error resetting user spin:', error);
    res.status(500).json({
      success: false,
      message: 'Error resetting user spin'
    });
  }
};

module.exports = {
  getAllSpinRewards,
  getSpinReward,
  updateRewardStatus,
  deleteSpinReward,
  getSpinConfig,
  updateSpinConfig,
  updateGlobalSettings,
  getSpinAnalytics,
  getDetailedReports,
  exportSpinData,
  getUsersWithSpins,
  getUserSpinHistory,
  resetUserSpin
};