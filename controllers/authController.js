// controllers/authController.js
const User = require('../models/User');
const OTP = require('../models/OTP');
const Referral = require('../models/Referral');
const Wallet = require('../models/Wallet');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const emailService = require('../services/emailService');
const Settings = require('../models/Settings');

// ========================================
// GET CLIENT IP - SIMPLE & RELIABLE
// ========================================
const getClientIP = (req) => {
  // request-ip middleware adds clientIp to req
  let ip = req.clientIp || req.ip || 'unknown';
  
  // Clean up IPv6 localhost
  if (ip === '::1' || ip === '::ffff:127.0.0.1') {
    ip = '127.0.0.1';
  }
  
  // Remove IPv6 prefix if present
  if (ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }
  
  return ip;
};

// ========================================
// SEND OTP FOR EMAIL VERIFICATION
// ========================================
const sendOTP = async (req, res) => {
  const { email, purpose = 'registration', referralCode } = req.body;

  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({
      success: false,
      message: 'Valid email is required'
    });
  }

  const lowercaseEmail = email.toLowerCase().trim();
  const clientIP = getClientIP(req); // ✅ USES REQUEST-IP

  try {
    if (purpose === 'registration') {
      const existingUser = await User.findOne({ 'profile.email': lowercaseEmail });
      if (existingUser) {
        return res.status(409).json({
          success: false,
          message: 'Email already registered. Please login instead.'
        });
      }
    }

    const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
    const recentOTPs = await OTP.countDocuments({
      email: lowercaseEmail,
      purpose,
      createdAt: { $gte: oneMinuteAgo }
    });

    const maxRequestsPerMinute = parseInt(process.env.OTP_RATE_LIMIT_MAX_REQUESTS) || 3;
    if (recentOTPs >= maxRequestsPerMinute) {
      return res.status(429).json({
        success: false,
        message: 'Too many OTP requests. Please wait a minute and try again.'
      });
    }

    await OTP.cleanupOldOTPs(lowercaseEmail, purpose);

    const otpCode = OTP.generateOTP();
    const expiryMinutes = parseInt(process.env.OTP_EXPIRY_MINUTES) || 10;
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);

    const newOTP = await OTP.create({
      email: lowercaseEmail,
      otp: otpCode,
      purpose,
      expiresAt,
      metadata: {
        ipAddress: clientIP, // ✅ SAVES IP
        userAgent: req.get('User-Agent'),
        referralCode: referralCode || null
      }
    });

    try {
      await emailService.sendOTP(lowercaseEmail, otpCode, purpose);
    } catch (emailError) {
      console.error('Error sending OTP email:', emailError);
      await OTP.findByIdAndDelete(newOTP._id);
      
      return res.status(500).json({
        success: false,
        message: 'Failed to send verification email. Please check your email address and try again.'
      });
    }

    res.status(200).json({
      success: true,
      message: `Verification code sent to ${lowercaseEmail}`,
      data: {
        email: lowercaseEmail,
        expiresIn: expiryMinutes,
        purpose
      }
    });

  } catch (error) {
    console.error('Error sending OTP:', error);
    res.status(500).json({
      success: false,
      message: 'Error sending verification code',
      error: error.message
    });
  }
};

// ========================================
// VERIFY OTP
// ========================================
const verifyOTP = async (req, res) => {
  const { email, otp, purpose = 'registration' } = req.body;

  if (!email || !otp) {
    return res.status(400).json({
      success: false,
      message: 'Email and OTP are required'
    });
  }

  const lowercaseEmail = email.toLowerCase().trim();

  try {
    const otpRecord = await OTP.findOne({
      email: lowercaseEmail,
      purpose,
      verified: false
    }).sort({ createdAt: -1 });

    if (!otpRecord) {
      return res.status(404).json({
        success: false,
        message: 'No verification code found. Please request a new one.'
      });
    }

    if (otpRecord.isExpired()) {
      return res.status(400).json({
        success: false,
        message: 'Verification code has expired. Please request a new one.'
      });
    }

    if (otpRecord.hasExceededAttempts()) {
      return res.status(400).json({
        success: false,
        message: 'Maximum verification attempts exceeded. Please request a new code.'
      });
    }

    otpRecord.attempts += 1;
    await otpRecord.save();

    if (otpRecord.otp !== otp) {
      const remainingAttempts = otpRecord.maxAttempts - otpRecord.attempts;
      return res.status(400).json({
        success: false,
        message: `Invalid verification code. ${remainingAttempts} attempt(s) remaining.`
      });
    }

    otpRecord.verified = true;
    await otpRecord.save();

    res.status(200).json({
      success: true,
      message: 'Email verified successfully!',
      data: {
        email: lowercaseEmail,
        verified: true,
        referralCode: otpRecord.metadata?.referralCode || null
      }
    });

  } catch (error) {
    console.error('Error verifying OTP:', error);
    res.status(500).json({
      success: false,
      message: 'Error verifying code',
      error: error.message
    });
  }
};


const resetPassword = async (req, res) => {
  const { email, otp, newPassword } = req.body;

  if (!email || !otp || !newPassword) {
    return res.status(400).json({
      success: false,
      message: 'Email, OTP code, and new password are required'
    });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({
      success: false,
      message: 'New password must be at least 6 characters long'
    });
  }

  const lowercaseEmail = email.toLowerCase().trim();

  try {
    // 1. Find the most recent verified OTP for password_reset
    const otpRecord = await OTP.findOne({
      email: lowercaseEmail,
      purpose: 'password_reset',
      verified: true
    }).sort({ createdAt: -1 });

    if (!otpRecord) {
      return res.status(400).json({
        success: false,
        message: 'No verified reset code found. Please request a new one.'
      });
    }

    // 2. Make sure the verified OTP isn't too old (15-minute window after verification)
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
    if (otpRecord.updatedAt < fifteenMinutesAgo) {
      return res.status(400).json({
        success: false,
        message: 'Reset session has expired. Please start over.'
      });
    }

    // 3. Find the user
    const user = await User.findOne({ 'profile.email': lowercaseEmail });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'No account found with this email address.'
      });
    }

    console.log(`🔑 Resetting password for user: ${user.username} (${user._id})`);

    // 4. Hash and save the new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await User.findByIdAndUpdate(user._id, { $set: { password: hashedPassword } }, { new: true });

    console.log(`✅ Password updated in DB for: ${user.username}`);

    // 5. Clean up — delete all password_reset OTPs for this email
    await OTP.deleteMany({ email: lowercaseEmail, purpose: 'password_reset' });

    res.status(200).json({
      success: true,
      message: 'Password reset successfully. You can now log in with your new password.'
    });

  } catch (error) {
    console.error('Error resetting password:', error);
    res.status(500).json({
      success: false,
      message: 'Error resetting password',
      error: error.message
    });
  }
};

// ========================================
// REGISTER WITH IP TRACKING
// ========================================
// controllers/authController.js - COMPLETE REGISTER FUNCTION
// Replace your entire register function with this

// ========================================
// REGISTER WITH IP DUPLICATE DETECTION
// ========================================
// ========================================
// REGISTER WITH IP DUPLICATE DETECTION
// ========================================
// ========================================
// REGISTER WITH IP DUPLICATE DETECTION
// ========================================
const register = async (req, res) => {
  const role = 2;
  const { username, password, affiliateUsername } = req.body;

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

  if (password.length < 6) {
    return res.status(400).json({
      success: false,
      message: 'Password must be at least 6 characters'
    });
  }

  const clientIP = getClientIP(req);

  console.log(`📍 Registration from IP: ${clientIP}, User-Agent: ${req.get('User-Agent')}`);

  try {
    // ========================================
    // ✅ CHECK FOR MULTIPLE ACCOUNTS FROM SAME IP
    // ========================================
    const isLocalhost = clientIP === '127.0.0.1' || clientIP === 'localhost' || clientIP === '::1';

    let existingAccountsFromIP = 0;

    if (!isLocalhost) {
      existingAccountsFromIP = await User.countDocuments({
        'account.signupIP': clientIP
      });

      if (existingAccountsFromIP >= 2) {
        console.log(`⚠️  Multiple account attempt blocked - IP: ${clientIP} has ${existingAccountsFromIP} accounts`);
        return res.status(403).json({
          success: false,
          message: 'You have multiple accounts from the same device. Please contact support if you believe this is an error.'
        });
      }

      console.log(`✅ IP check passed - ${existingAccountsFromIP} existing account(s) from IP: ${clientIP}`);
    } else {
      console.log(`ℹ️  Localhost detected - skipping IP duplicate check`);
    }

    // ========================================
    // USERNAME UNIQUENESS
    // ========================================
    const existingUsername = await User.findOne({ username: username.toLowerCase() });
    if (existingUsername) {
      return res.status(409).json({
        success: false,
        message: 'Username already exists'
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = new User({
      username: username.toLowerCase(),
      password: hashedPassword,
      role,
      profile: {
        emailVerified: false
      },
      account: {
        signupIP: clientIP,
        lastLoginIP: clientIP,
        lastLogin: new Date(),
        loginHistory: [{
          ip: clientIP,
          userAgent: req.get('User-Agent'),
          timestamp: new Date()
        }]
      }
    });

    const newUser = await user.save();

    console.log(`✅ User registered: ${username} from IP: ${clientIP} (Total accounts from this IP: ${existingAccountsFromIP + 1})`);

    // ⚠️ Mailtrap removed — no email collected at signup.
    // (Original line: await emailService.addToMailtrapContactList(lowercaseEmail, username);)

    // ========================================
    // AWARD SIGNUP BONUS
    // ========================================
    let signupBonusAmount = 0;
    try {
      const settings = await Settings.getSettings();
      if (settings.signupBonus.enabled) {
        signupBonusAmount = settings.signupBonus.amount;

        await Wallet.create({
          userId: newUser._id,
          balance: signupBonusAmount,
          currency: settings.currency || 'USD'
        });
      } else {
        await Wallet.create({
          userId: newUser._id,
          balance: 0,
          currency: settings.currency || 'USD'
        });
      }
    } catch (bonusError) {
      console.error('Error awarding signup bonus / creating wallet:', bonusError);
    }

    // ========================================
    // HANDLE REFERRAL
    // ========================================
    if (affiliateUsername) {
      try {
        const affiliate = await User.findOne({ username: affiliateUsername.toLowerCase() });
        if (affiliate) {
          await Referral.create({
            referrer: affiliate._id,
            referred: newUser._id,
            referredUsername: newUser.username,
            createdAt: new Date()
          });
          console.log(`✅ Referral recorded: ${affiliateUsername} → ${username}`);
        } else {
          console.log(`ℹ️  Referral code "${affiliateUsername}" did not match any user`);
        }
      } catch (refError) {
        console.error('Error recording referral:', refError);
      }
    }

    // ========================================
    // ISSUE JWT
    // ========================================
    const token = jwt.sign(
      { id: newUser._id, username: newUser.username, role: newUser.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRY || '7d' }
    );

    return res.status(201).json({
      success: true,
      message: 'Account created successfully',
      data: {
        token,
        user: {
          id: newUser._id,
          username: newUser.username,
          role: newUser.role,
          balance: signupBonusAmount
        }
      }
    });

  } catch (error) {
    console.error('Error registering user:', error);
    return res.status(500).json({
      success: false,
      message: 'Error registering user',
      error: error.message
    });
  }
};
// ========================================
// LOGIN WITH IP TRACKING
// ========================================
const login = async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ 
      success: false,
      message: 'Username and password are required' 
    });
  }

  const clientIP = getClientIP(req); // ✅ GETS REAL IP

  console.log(`📍 Login attempt: ${username} from IP: ${clientIP}`);

  try {
    const lowercaseUsername = username.toLowerCase();
    const user = await User.findOne({ 
      username: { $regex: new RegExp(`^${lowercaseUsername}$`, 'i') } 
    });
    
    if (!user) {
      return res.status(404).json({ 
        success: false,
        message: 'Username not found' 
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

    const token = jwt.sign(
      {
        userId: user._id,
        userUsername: user.username,
        userRole: user.role
      },
      process.env.JWT_SECRET || 'default_secret',
      { expiresIn: '24h' }
    );

    // ✅ UPDATE LOGIN IP AND HISTORY
    user.account.lastLogin = new Date();
    user.account.lastLoginIP = clientIP;
    user.addLoginHistory(clientIP, req.get('User-Agent'));
    await user.save();

    console.log(`✅ Login successful: ${username} from IP: ${clientIP}`);

    res.status(200).json({
      success: true,
      message: 'Login Successful',
      data: {
        user: {
          _id: user._id,
          username: user.username,
          role: user.role,
          wallet: user.wallet,
          profile: {
            firstName: user.profile?.firstName || null,
            lastName: user.profile?.lastName || null,
            email: user.profile?.email || null,
            emailVerified: user.profile?.emailVerified || false,
            phone: user.profile?.phone || null,
            avatar: user.profile?.avatar || null
          },
          createdAt: user.createdAt,
          account: user.account
        },
        token
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Error logging in',
      error: error.message,
    });
  }
};

// ========================================
// GET CURRENT USER
// ========================================
const getCurrentUser = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('-password').lean();
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'User data retrieved successfully',
      data: {
        user: {
          _id: user._id,
          username: user.username,
          role: user.role,
          profile: {
            firstName: user.profile?.firstName || null,
            lastName: user.profile?.lastName || null,
            email: user.profile?.email || null,
            emailVerified: user.profile?.emailVerified || false,
            phone: user.profile?.phone || null,
            avatar: user.profile?.avatar || null
          },
          wallet: user.wallet,
          account: user.account,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
          affiliateId: user.affiliateId,
          pin: user.pin
        }
      }
    });
  } catch (error) {
    console.error('Error getting current user:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving user data',
      error: error.message
    });
  }
};

// Keep your existing changePassword, changePin, updateProfile functions...

const changePassword = async (req, res) => {
  const userId = req.user.userId;
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword) {
    return res.status(400).json({
      success: false,
      message: 'Current password is required'
    });
  }

  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({
      success: false,
      message: 'New password must be at least 6 characters long'
    });
  }

  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const isPasswordCorrect = await bcrypt.compare(currentPassword, user.password);
    if (!isPasswordCorrect) {
      return res.status(400).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await User.findByIdAndUpdate(userId, {
      password: hashedPassword
    });

    res.status(200).json({
      success: true,
      message: 'Password changed successfully'
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

const changePin = async (req, res) => {
  const userId = req.user.userId;
  const { pin, oldPin } = req.body;

  if (!pin || pin.length !== 4) {
    return res.status(400).json({
      success: false,
      message: 'Withdrawal PIN must be exactly 4 digits'
    });
  }

  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (user.pin && user.pin !== oldPin) {
      return res.status(402).json({
        success: false,
        message: 'Old pin is not correct'
      });
    }

    await User.findByIdAndUpdate(userId, {
      pin: pin
    });
    
    res.status(200).json({
      success: true,
      message: 'Withdrawal PIN set successfully'
    });

  } catch (error) {
    console.error('Error setting withdrawal PIN:', error);
    res.status(500).json({
      success: false,
      message: 'Error setting withdrawal PIN',
      error: error.message
    });
  }
};

const updateProfile = async (req, res) => {
  const userId = req.user.userId;
  const { username, firstName, lastName, email, phone } = req.body;

  try {
    const updateData = {};
    
    if (username) {
      const lowercaseUsername = username.toLowerCase();
      
      const currentUser = await User.findById(userId);
      if (currentUser.username !== lowercaseUsername) {
        const existingUser = await User.findOne({ 
          username: lowercaseUsername,
          _id: { $ne: userId }
        });
        
        if (existingUser) {
          return res.status(409).json({
            success: false,
            message: 'Username already exists'
          });
        }
        
        updateData.username = lowercaseUsername;
      }
    }
    
    if (firstName !== undefined) updateData['profile.firstName'] = firstName;
    if (lastName !== undefined) updateData['profile.lastName'] = lastName;
    if (email !== undefined) updateData['profile.email'] = email;
    if (phone !== undefined) updateData['profile.phone'] = phone;

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update'
      });
    }

    const user = await User.findByIdAndUpdate(
      userId,
      updateData,
      { new: true, runValidators: true }
    ).select('-password');

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
        user: {
          _id: user._id,
          username: user.username,
          role: user.role,
          profile: {
            firstName: user.profile?.firstName || null,
            lastName: user.profile?.lastName || null,
            email: user.profile?.email || null,
            emailVerified: user.profile?.emailVerified || false,
            phone: user.profile?.phone || null,
            avatar: user.profile?.avatar || null
          },
          wallet: user.wallet,
          createdAt: user.createdAt,
          account: user.account
        }
      }
    });
  } catch (error) {
    console.error('Error updating profile:', error);
    
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        error: error.message
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Error updating profile',
      error: error.message
    });
  }
};

module.exports = {
  sendOTP,
  verifyOTP,
  register,
  login,
  changePassword,
  resetPassword,
  changePin,
  getCurrentUser,
  updateProfile
};