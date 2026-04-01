// controllers/cashoutRuleController.js
const CashoutRule = require('../models/CashoutRule');

// @desc    Get all active cashout rules
// @route   GET /api/cashout-rules
// @access  Public
exports.getAllActiveRules = async (req, res) => {
  try {
    const rules = await CashoutRule.getActiveRules();
    
    // Format for frontend
    const formattedRules = rules.map(rule => ({
      _id: rule._id,
      deposit: `${rule.depositRange.min}-${rule.depositRange.max}`,
      cashout: `${rule.cashoutLimits.min}-${rule.cashoutLimits.max}`,
      depositRange: rule.depositRange,
      cashoutLimits: rule.cashoutLimits,
      description: rule.description
    }));
    
    res.json({
      success: true,
      count: formattedRules.length,
      data: formattedRules
    });
  } catch (error) {
    console.error('Error fetching active cashout rules:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch cashout rules',
      error: error.message
    });
  }
};

// @desc    Get applicable rule for a specific deposit amount
// @route   GET /api/cashout-rules/check/:depositAmount
// @access  Public
exports.getApplicableRule = async (req, res) => {
  try {
    const { depositAmount } = req.params;
    const amount = parseFloat(depositAmount);
    
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid deposit amount'
      });
    }
    
    const rule = await CashoutRule.findApplicableRule(amount);
    
    if (!rule) {
      return res.status(404).json({
        success: false,
        message: 'No cashout rule found for this deposit amount'
      });
    }
    
    res.json({
      success: true,
      data: {
        _id: rule._id,
        depositAmount: amount,
        cashoutLimits: rule.cashoutLimits,
        depositRange: rule.depositRange,
        description: rule.description
      }
    });
  } catch (error) {
    console.error('Error finding applicable rule:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to find applicable rule',
      error: error.message
    });
  }
};

// @desc    Validate a cashout amount
// @route   POST /api/cashout-rules/validate
// @access  Public
exports.validateCashout = async (req, res) => {
  try {
    const { depositAmount, cashoutAmount } = req.body;
    
    if (!depositAmount || !cashoutAmount) {
      return res.status(400).json({
        success: false,
        message: 'Deposit amount and cashout amount are required'
      });
    }
    
    const deposit = parseFloat(depositAmount);
    const cashout = parseFloat(cashoutAmount);
    
    if (isNaN(deposit) || isNaN(cashout) || deposit <= 0 || cashout <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid amounts provided'
      });
    }
    
    const rule = await CashoutRule.findApplicableRule(deposit);
    
    if (!rule) {
      return res.status(404).json({
        success: false,
        message: 'No cashout rule found for this deposit amount',
        valid: false
      });
    }
    
    const validation = rule.validateCashout(cashout);
    
    res.json({
      success: true,
      data: {
        valid: validation.valid,
        depositAmount: deposit,
        cashoutAmount: cashout,
        limits: {
          min: validation.min,
          max: validation.max
        },
        reason: validation.reason
      }
    });
  } catch (error) {
    console.error('Error validating cashout:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to validate cashout',
      error: error.message
    });
  }
};

// @desc    Create a new cashout rule
// @route   POST /api/cashout-rules/admin
// @access  Admin
exports.createRule = async (req, res) => {
  try {
    const { depositRange, cashoutLimits, description } = req.body;
    
    // Validation
    if (!depositRange || !depositRange.min || !depositRange.max) {
      return res.status(400).json({
        success: false,
        message: 'Deposit range with min and max is required'
      });
    }
    
    if (!cashoutLimits || !cashoutLimits.min || !cashoutLimits.max) {
      return res.status(400).json({
        success: false,
        message: 'Cashout limits with min and max are required'
      });
    }
    
    // Check for overlapping rules
    const existingRule = await CashoutRule.findOne({
      status: 'active',
      $or: [
        {
          'depositRange.min': { $lte: depositRange.max },
          'depositRange.max': { $gte: depositRange.min }
        }
      ]
    });
    
    if (existingRule) {
      return res.status(400).json({
        success: false,
        message: 'A rule already exists that overlaps with this deposit range'
      });
    }
    
    const rule = new CashoutRule({
      depositRange,
      cashoutLimits,
      description
    });
    
    await rule.save();
    
    res.status(201).json({
      success: true,
      message: 'Cashout rule created successfully',
      data: rule
    });
  } catch (error) {
    console.error('Error creating cashout rule:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create cashout rule',
      error: error.message
    });
  }
};

// @desc    Get all cashout rules (including inactive)
// @route   GET /api/cashout-rules/admin/all
// @access  Admin
exports.getAllRules = async (req, res) => {
  try {
    const rules = await CashoutRule.find().sort({ 'depositRange.min': 1 });
    
    res.json({
      success: true,
      count: rules.length,
      data: rules
    });
  } catch (error) {
    console.error('Error fetching all rules:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch rules',
      error: error.message
    });
  }
};

// @desc    Get a specific cashout rule
// @route   GET /api/cashout-rules/admin/:id
// @access  Admin
exports.getRuleById = async (req, res) => {
  try {
    const rule = await CashoutRule.findById(req.params.id);
    
    if (!rule) {
      return res.status(404).json({
        success: false,
        message: 'Cashout rule not found'
      });
    }
    
    res.json({
      success: true,
      data: rule
    });
  } catch (error) {
    console.error('Error fetching rule:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch rule',
      error: error.message
    });
  }
};

// @desc    Update a cashout rule
// @route   PUT /api/cashout-rules/admin/:id
// @access  Admin
exports.updateRule = async (req, res) => {
  try {
    const { depositRange, cashoutLimits, description, status } = req.body;
    
    const rule = await CashoutRule.findById(req.params.id);
    
    if (!rule) {
      return res.status(404).json({
        success: false,
        message: 'Cashout rule not found'
      });
    }
    
    // Check for overlapping rules (excluding current rule)
    if (depositRange) {
      const overlapping = await CashoutRule.findOne({
        _id: { $ne: req.params.id },
        status: 'active',
        $or: [
          {
            'depositRange.min': { $lte: depositRange.max },
            'depositRange.max': { $gte: depositRange.min }
          }
        ]
      });
      
      if (overlapping) {
        return res.status(400).json({
          success: false,
          message: 'Update would create overlapping deposit ranges'
        });
      }
    }
    
    // Update fields
    if (depositRange) rule.depositRange = depositRange;
    if (cashoutLimits) rule.cashoutLimits = cashoutLimits;
    if (description !== undefined) rule.description = description;
    if (status) rule.status = status;
    
    await rule.save();
    
    res.json({
      success: true,
      message: 'Cashout rule updated successfully',
      data: rule
    });
  } catch (error) {
    console.error('Error updating rule:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update rule',
      error: error.message
    });
  }
};

// @desc    Delete a cashout rule
// @route   DELETE /api/cashout-rules/admin/:id
// @access  Admin
exports.deleteRule = async (req, res) => {
  try {
    const rule = await CashoutRule.findById(req.params.id);
    
    if (!rule) {
      return res.status(404).json({
        success: false,
        message: 'Cashout rule not found'
      });
    }
    
    await rule.deleteOne();
    
    res.json({
      success: true,
      message: 'Cashout rule deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting rule:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete rule',
      error: error.message
    });
  }
};

// @desc    Create default cashout rules
// @route   POST /api/cashout-rules/admin/initialize
// @access  Admin
exports.createDefaultRules = async (req, res) => {
  try {
    const createdRules = await CashoutRule.createDefaultRules();
    
    if (createdRules.length === 0) {
      return res.json({
        success: true,
        message: 'Default rules already exist',
        data: []
      });
    }
    
    res.status(201).json({
      success: true,
      message: `Created ${createdRules.length} default cashout rules`,
      data: createdRules
    });
  } catch (error) {
    console.error('Error creating default rules:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create default rules',
      error: error.message
    });
  }
};

// @desc    Toggle rule status
// @route   PATCH /api/cashout-rules/admin/:id/status
// @access  Admin
exports.toggleStatus = async (req, res) => {
  try {
    const rule = await CashoutRule.findById(req.params.id);
    
    if (!rule) {
      return res.status(404).json({
        success: false,
        message: 'Cashout rule not found'
      });
    }
    
    rule.status = rule.status === 'active' ? 'inactive' : 'active';
    await rule.save();
    
    res.json({
      success: true,
      message: `Rule status updated to ${rule.status}`,
      data: rule
    });
  } catch (error) {
    console.error('Error toggling rule status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update rule status',
      error: error.message
    });
  }
};