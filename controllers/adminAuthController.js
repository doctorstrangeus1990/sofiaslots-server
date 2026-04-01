// controllers/adminAuthController.js - UPDATED WITH STAFF ROLE SUPPORT
const User = require('../models/User');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const adminLogin = async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ 
      success: false,
      message: 'Username and password are required' 
    });
  }

  try {
    const lowercaseUsername = username.toLowerCase();
    console.log('Admin/Staff login attempt for username:', lowercaseUsername);
    
    // ✅ Find admin (role 1) OR staff (role 3) users
    const user = await User.findOne({ 
      username: { $regex: new RegExp(`^${lowercaseUsername}$`, 'i') },
      role: { $in: [1, 3] } // Allow admin (1) and staff (3)
    });
    
    if (!user) {
      return res.status(404).json({ 
        success: false,
        message: 'User not found or insufficient privileges' 
      });
    }

    if (!user.account.isActive) {
      return res.status(403).json({
        success: false,
        message: 'Account has been deactivated'
      });
    }

    const passwordCheck = await bcrypt.compare(password, user.password);

    if (!passwordCheck) {
      return res.status(400).json({ 
        success: false,
        message: 'Incorrect password' 
      });
    }

    // ✅ Generate token with role information
    const token = jwt.sign(
      {
        userId: user._id,
        userUsername: user.username,
        userRole: user.role,
        isAdmin: user.role === 1,
        isStaff: user.role === 3
      },
      process.env.JWT_SECRET || 'default_secret',
      { expiresIn: '8h' }
    );

    await User.findByIdAndUpdate(user._id, {
      'account.lastLogin': new Date()
    });

    // ✅ Return role-specific information
    const roleLabel = user.role === 1 ? 'Admin' : 'Staff';
    
    res.status(200).json({
      success: true,
      message: `${roleLabel} login successful`,
      data: {
        admin: {
          _id: user._id,
          username: user.username,
          role: user.role,
          roleLabel: roleLabel,
          profile: user.profile,
          lastLogin: new Date()
        },
        token
      }
    });
  } catch (error) {
    console.error('Admin/Staff login error:', error);
    res.status(500).json({
      success: false,
      message: 'Error logging in',
      error: error.message,
    });
  }
};

const createAdmin = async (req, res) => {
  const { username, password, email, role } = req.body;

  // Only allow super admin to create users
  if (req.user.userRole !== 1) {
    return res.status(403).json({
      success: false,
      message: 'Insufficient privileges to create admin/staff users'
    });
  }

  if (!username || !password) {
    return res.status(400).json({ 
      success: false,
      message: 'Username and password are required' 
    });
  }

  if (username.length < 3 || username.length > 20) {
    return res.status(400).json({ 
      success: false,
      message: 'Username must be between 3 and 20 characters' 
    });
  }

  if (password.length < 8) {
    return res.status(400).json({ 
      success: false,
      message: 'Password must be at least 8 characters' 
    });
  }

  // ✅ Validate role (1 = admin, 3 = staff)
  const userRole = role || 1;
  if (![1, 3].includes(userRole)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid role. Use 1 for Admin or 3 for Staff'
    });
  }

  try {
    const existingUser = await User.findOne({ username: username.toLowerCase() });
    if (existingUser) {
      return res.status(409).json({ 
        success: false,
        message: 'Username already exists' 
      });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const newUser = new User({
      username: username.toLowerCase(),
      password: hashedPassword,
      role: userRole, // ✅ Set role from request
      'profile.email': email || '',
      'account.isActive': true
    });

    const result = await newUser.save();

    const roleLabel = userRole === 1 ? 'Admin' : 'Staff';

    const userResponse = {
      _id: result._id,
      username: result.username,
      role: result.role,
      roleLabel: roleLabel,
      profile: result.profile,
      createdAt: result.createdAt
    };

    res.status(201).json({
      success: true,
      message: `${roleLabel} user created successfully`,
      data: {
        admin: userResponse
      }
    });

  } catch (error) {
    console.error('Error creating admin/staff:', error);
    
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'Username already exists',
      });
    }

    res.status(500).json({
      success: false,
      message: 'Error creating user',
      error: error.message,
    });
  }
};

const getAdminProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('-password');
    
    // ✅ Allow both admin and staff
    if (!user || ![1, 3].includes(user.role)) {
      return res.status(404).json({
        success: false,
        message: 'User not found or insufficient privileges'
      });
    }

    const roleLabel = user.role === 1 ? 'Admin' : 'Staff';

    res.status(200).json({
      success: true,
      message: 'Profile retrieved successfully',
      data: {
        username: user.username,
        role: user.role,
        roleLabel: roleLabel,
        profile: user.profile,
        account: user.account
      }
    });
  } catch (error) {
    console.error('Error getting profile:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving profile',
      error: error.message
    });
  }
};

const changeAdminPassword = async (req, res) => {
  const userId = req.user.userId;
  const { oldPassword, newPassword } = req.body;

  if (!oldPassword || !newPassword) {
    return res.status(400).json({
      success: false,
      message: 'Current password and new password are required'
    });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({
      success: false,
      message: 'New password must be at least 8 characters long'
    });
  }

  try {
    // ✅ Allow both admin and staff to change their password
    const user = await User.findOne({ 
      _id: userId, 
      role: { $in: [1, 3] }
    });
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const isPasswordCorrect = await bcrypt.compare(oldPassword, user.password);
    if (!isPasswordCorrect) {
      return res.status(400).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await User.findByIdAndUpdate(userId, {
      password: hashedPassword
    });

    res.status(200).json({
      success: true,
      message: 'Password updated successfully'
    });

  } catch (error) {
    console.error('Error changing password:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating password',
      error: error.message
    });
  }
};

const updateAdminProfile = async (req, res) => {
  const userId = req.user.userId;
  const { firstName, lastName, email, phone } = req.body;

  try {
    // ✅ Allow both admin and staff to update profile
    const user = await User.findOneAndUpdate(
      { _id: userId, role: { $in: [1, 3] } },
      {
        'profile.firstName': firstName,
        'profile.lastName': lastName,
        'profile.email': email,
        'profile.phone': phone
      },
      { new: true, runValidators: true, select: '-password' }
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      data: {
        admin: user
      }
    });
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating profile',
      error: error.message
    });
  }
};

module.exports = {
  adminLogin,
  createAdmin,
  getAdminProfile,
  changeAdminPassword,
  updateAdminProfile
};