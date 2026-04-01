// controllers/settingsController.js
const UserSettings = require('../models/UserSettings');
const User = require('../models/User');

// @desc    Get user settings
// @access  Private
const getSettings = async (req, res) => {
  try {
    const userId = req.user.userId;
    
    const settings = await UserSettings.getOrCreate(userId);
    
    res.status(200).json({
      success: true,
      message: 'Settings retrieved successfully',
      data: {
        settings
      }
    });
  } catch (error) {
    console.error('Error getting settings:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving settings',
      error: error.message
    });
  }
};

// @desc    Update all settings
// @access  Private
const updateSettings = async (req, res) => {
  try {
    const userId = req.user.userId;
    const updates = req.body;
    
    let settings = await UserSettings.getOrCreate(userId);
    
    // Update only the fields that are provided
    const allowedCategories = [
      'notifications',
      'privacy',
      'security',
      'display',
      'game',
      'communication',
      'responsibleGaming'
    ];
    
    allowedCategories.forEach(category => {
      if (updates[category]) {
        Object.assign(settings[category], updates[category]);
      }
    });
    
    await settings.save();
    
    res.status(200).json({
      success: true,
      message: 'Settings updated successfully',
      data: {
        settings
      }
    });
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating settings',
      error: error.message
    });
  }
};

// @desc    Update notification preferences
// @access  Private
const updateNotifications = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { email, push, sms } = req.body;
    
    let settings = await UserSettings.getOrCreate(userId);
    
    if (email) Object.assign(settings.notifications.email, email);
    if (push) Object.assign(settings.notifications.push, push);
    if (sms) Object.assign(settings.notifications.sms, sms);
    
    await settings.save();
    
    res.status(200).json({
      success: true,
      message: 'Notification preferences updated successfully',
      data: {
        notifications: settings.notifications
      }
    });
  } catch (error) {
    console.error('Error updating notifications:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating notification preferences',
      error: error.message
    });
  }
};

// @desc    Update privacy settings
// @access  Private
const updatePrivacy = async (req, res) => {
  try {
    const userId = req.user.userId;
    const privacyData = req.body;
    
    let settings = await UserSettings.getOrCreate(userId);
    
    Object.assign(settings.privacy, privacyData);
    await settings.save();
    
    res.status(200).json({
      success: true,
      message: 'Privacy settings updated successfully',
      data: {
        privacy: settings.privacy
      }
    });
  } catch (error) {
    console.error('Error updating privacy settings:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating privacy settings',
      error: error.message
    });
  }
};

// @desc    Update security settings
// @access  Private
const updateSecurity = async (req, res) => {
  try {
    const userId = req.user.userId;
    const securityData = req.body;
    
    let settings = await UserSettings.getOrCreate(userId);
    
    // Don't allow direct modification of trustedDevices through this endpoint
    const { trustedDevices, ...safeSecurityData } = securityData;
    
    Object.assign(settings.security, safeSecurityData);
    await settings.save();
    
    res.status(200).json({
      success: true,
      message: 'Security settings updated successfully',
      data: {
        security: settings.security
      }
    });
  } catch (error) {
    console.error('Error updating security settings:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating security settings',
      error: error.message
    });
  }
};

// @desc    Update display preferences
// @access  Private
const updateDisplay = async (req, res) => {
  try {
    const userId = req.user.userId;
    const displayData = req.body;
    
    let settings = await UserSettings.getOrCreate(userId);
    
    Object.assign(settings.display, displayData);
    await settings.save();
    
    res.status(200).json({
      success: true,
      message: 'Display preferences updated successfully',
      data: {
        display: settings.display
      }
    });
  } catch (error) {
    console.error('Error updating display preferences:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating display preferences',
      error: error.message
    });
  }
};

// @desc    Update game preferences
// @access  Private
const updateGamePreferences = async (req, res) => {
  try {
    const userId = req.user.userId;
    const gameData = req.body;
    
    let settings = await UserSettings.getOrCreate(userId);
    
    Object.assign(settings.game, gameData);
    await settings.save();
    
    res.status(200).json({
      success: true,
      message: 'Game preferences updated successfully',
      data: {
        game: settings.game
      }
    });
  } catch (error) {
    console.error('Error updating game preferences:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating game preferences',
      error: error.message
    });
  }
};

// @desc    Update communication preferences
// @access  Private
const updateCommunication = async (req, res) => {
  try {
    const userId = req.user.userId;
    const communicationData = req.body;
    
    let settings = await UserSettings.getOrCreate(userId);
    
    Object.assign(settings.communication, communicationData);
    await settings.save();
    
    res.status(200).json({
      success: true,
      message: 'Communication preferences updated successfully',
      data: {
        communication: settings.communication
      }
    });
  } catch (error) {
    console.error('Error updating communication preferences:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating communication preferences',
      error: error.message
    });
  }
};

// @desc    Update responsible gaming settings
// @access  Private
const updateResponsibleGaming = async (req, res) => {
  try {
    const userId = req.user.userId;
    const responsibleGamingData = req.body;
    
    let settings = await UserSettings.getOrCreate(userId);
    
    // Handle nested objects properly
    if (responsibleGamingData.dailyDepositLimit) {
      Object.assign(settings.responsibleGaming.dailyDepositLimit, responsibleGamingData.dailyDepositLimit);
    }
    if (responsibleGamingData.weeklyDepositLimit) {
      Object.assign(settings.responsibleGaming.weeklyDepositLimit, responsibleGamingData.weeklyDepositLimit);
    }
    if (responsibleGamingData.monthlyDepositLimit) {
      Object.assign(settings.responsibleGaming.monthlyDepositLimit, responsibleGamingData.monthlyDepositLimit);
    }
    if (responsibleGamingData.sessionTimeLimit) {
      Object.assign(settings.responsibleGaming.sessionTimeLimit, responsibleGamingData.sessionTimeLimit);
    }
    if (responsibleGamingData.selfExclusion) {
      Object.assign(settings.responsibleGaming.selfExclusion, responsibleGamingData.selfExclusion);
    }
    
    await settings.save();
    
    res.status(200).json({
      success: true,
      message: 'Responsible gaming settings updated successfully',
      data: {
        responsibleGaming: settings.responsibleGaming
      }
    });
  } catch (error) {
    console.error('Error updating responsible gaming settings:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating responsible gaming settings',
      error: error.message
    });
  }
};

// @desc    Reset settings to default
// @access  Private
const resetSettings = async (req, res) => {
  try {
    const userId = req.user.userId;
    
    // Delete existing settings
    await UserSettings.findOneAndDelete({ userId });
    
    // Create new default settings
    const settings = await UserSettings.create({ userId });
    
    res.status(200).json({
      success: true,
      message: 'Settings reset to defaults successfully',
      data: {
        settings
      }
    });
  } catch (error) {
    console.error('Error resetting settings:', error);
    res.status(500).json({
      success: false,
      message: 'Error resetting settings',
      error: error.message
    });
  }
};

// @desc    Add trusted device
// @access  Private
const addTrustedDevice = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { deviceId, deviceName } = req.body;
    
    if (!deviceId || !deviceName) {
      return res.status(400).json({
        success: false,
        message: 'Device ID and name are required'
      });
    }
    
    let settings = await UserSettings.getOrCreate(userId);
    
    // Check if device already exists
    const deviceExists = settings.security.trustedDevices.some(
      device => device.deviceId === deviceId
    );
    
    if (deviceExists) {
      return res.status(400).json({
        success: false,
        message: 'Device already trusted'
      });
    }
    
    settings.security.trustedDevices.push({
      deviceId,
      deviceName,
      lastUsed: new Date()
    });
    
    await settings.save();
    
    res.status(200).json({
      success: true,
      message: 'Device added to trusted devices',
      data: {
        trustedDevices: settings.security.trustedDevices
      }
    });
  } catch (error) {
    console.error('Error adding trusted device:', error);
    res.status(500).json({
      success: false,
      message: 'Error adding trusted device',
      error: error.message
    });
  }
};

// @desc    Remove trusted device
// @access  Private
const removeTrustedDevice = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { deviceId } = req.params;
    
    let settings = await UserSettings.getOrCreate(userId);
    
    settings.security.trustedDevices = settings.security.trustedDevices.filter(
      device => device.deviceId !== deviceId
    );
    
    await settings.save();
    
    res.status(200).json({
      success: true,
      message: 'Device removed from trusted devices',
      data: {
        trustedDevices: settings.security.trustedDevices
      }
    });
  } catch (error) {
    console.error('Error removing trusted device:', error);
    res.status(500).json({
      success: false,
      message: 'Error removing trusted device',
      error: error.message
    });
  }
};

module.exports = {
  getSettings,
  updateSettings,
  updateNotifications,
  updatePrivacy,
  updateSecurity,
  updateDisplay,
  updateGamePreferences,
  updateCommunication,
  updateResponsibleGaming,
  resetSettings,
  addTrustedDevice,
  removeTrustedDevice
};