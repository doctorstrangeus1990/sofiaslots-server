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
const register = async (req, res) => {
  const role = 2;
  const { username, password, email, affiliateUsername } = req.body;

  if (!username || !password || !email) {
    return res.status(400).json({ 
      success: false,
      message: 'Username, password, and email are required' 
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

  const lowercaseEmail = email.toLowerCase().trim();
  const clientIP = getClientIP(req);

  console.log(`📍 Registration from IP: ${clientIP}, User-Agent: ${req.get('User-Agent')}`);

  try {
    // ========================================
    // ✅ CHECK FOR MULTIPLE ACCOUNTS FROM SAME IP
    // ========================================
    // Skip localhost/development IPs from this check
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

    const verifiedOTP = await OTP.findOne({
      email: lowercaseEmail,
      purpose: 'registration',
      verified: true
    }).sort({ createdAt: -1 });

    if (!verifiedOTP) {
      return res.status(400).json({
        success: false,
        message: 'Email not verified. Please verify your email first.'
      });
    }

    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    if (verifiedOTP.createdAt < thirtyMinutesAgo) {
      return res.status(400).json({
        success: false,
        message: 'Email verification expired. Please verify again.'
      });
    }

    const existingUsername = await User.findOne({ username: username.toLowerCase() });
    if (existingUsername) {
      return res.status(409).json({ 
        success: false,
        message: 'Username already exists' 
      });
    }

    const existingEmail = await User.findOne({ 'profile.email': lowercaseEmail });
    if (existingEmail) {
      return res.status(409).json({ 
        success: false,
        message: 'Email already registered' 
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = new User({
      username: username.toLowerCase(),
      password: hashedPassword,
      role,
      profile: {
        email: lowercaseEmail,
        emailVerified: true
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

    // Add user to Mailtrap contact list for future bulk campaigns
    await emailService.addToMailtrapContactList(lowercaseEmail, username);

    // Award signup bonus
    let signupBonusAmount = 0;
    try {
      const settings = await Settings.getSettings();
      if (settings.signupBonus.enabled) {
        signupBonusAmount = settings.signupBonus.amount || 0;
      }
    } catch (settingsError) {
      console.error('Error fetching signup bonus settings:', settingsError);
      signupBonusAmount = 3;
    }

    if (signupBonusAmount > 0) {
      try {
        const newUserWallet = await Wallet.findOrCreateWallet(newUser._id);
        newUserWallet.addTransaction({
          type: 'bonus',
          amount: signupBonusAmount,
          description: 'Welcome signup bonus',
          status: 'completed',
          isBonus: true,
          metadata: {
            source: 'signup_bonus',
            rewardType: 'welcome_bonus',
            signupIP: clientIP
          }
        });
        await newUserWallet.save();
        console.log(`✅ $${signupBonusAmount} signup bonus awarded to new user`);
      } catch (signupBonusError) {
        console.error('Error awarding signup bonus:', signupBonusError);
      }
    }

    // Process referral code
    let referralApplied = false;
    let referralCode = affiliateUsername || verifiedOTP.metadata?.referralCode;
    
    if (referralCode) {
      console.log(`\n🔗 Processing referral code: ${referralCode}`);
      
      try {
        const referralTemplate = await Referral.findOne({
          referralCode: referralCode.toUpperCase(),
          referredUserId: null
        }).populate('referrerId', 'username');

        if (!referralTemplate) {
          console.log('   ❌ Invalid referral code provided');
        } else if (referralTemplate.referrerId._id.toString() === newUser._id.toString()) {
          console.log('   ❌ User tried to refer themselves');
        } else {
          const alreadyReferred = await Referral.findOne({
            referredUserId: newUser._id
          });

          if (alreadyReferred) {
            console.log('   ⚠️  User already has a referral applied');
          } else {
            await User.findByIdAndUpdate(newUser._id, {
              affiliateId: referralTemplate.referrerId._id
            });

            const newReferral = await Referral.create({
              referrerId: referralTemplate.referrerId._id,
              referredUserId: newUser._id,
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
                referredUserIP: clientIP,
                referredUserAgent: req.get('User-Agent'),
                referralSource: 'registration',
                depositCount: 0,
                totalReferralEarnings: 0,
                highRewardEarnings: 0,
                lifetimeEarnings: 0
              }
            });

            referralApplied = true;
            
            console.log('   ✅ Referral applied successfully!');
            console.log(`      Referrer: ${referralTemplate.referrerId.username} (${referralTemplate.referrerId._id})`);
            console.log(`      Referred: ${newUser.username} (${newUser._id})`);
            console.log(`      Referral ID: ${newReferral._id}`);
            console.log(`      Rewards: 10% on first 5 deposits, then 5% lifetime`);
          }
        }
      } catch (referralError) {
        console.error('   ❌ Error processing referral:', referralError);
      }
    } else {
      console.log('ℹ️  No referral code provided during registration');
    }

    // Delete the OTP record after successful registration
    await OTP.findByIdAndDelete(verifiedOTP._id);

    const userResponse = {
      _id: newUser._id,
      username: newUser.username,
      role: newUser.role,
      affiliateId: newUser.affiliateId || null,
      profile: {
        email: lowercaseEmail,
        emailVerified: true
      }
    };

    res.status(201).json({
      success: true,
      message: referralApplied ? 
        `Account created successfully with referral code ${referralCode}! $${signupBonusAmount} signup bonus added.` : 
        `Account created successfully! $${signupBonusAmount} signup bonus added.`,
      data: {
        user: userResponse,
        referralApplied,
        signupBonus: signupBonusAmount
      }
    });

  } catch (error) {
    console.error('Error creating user:', error);
    
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(409).json({
        success: false,
        message: field === 'username' ? 'Username already exists' : 'Email already registered',
      });
    }

    res.status(500).json({
      success: false,
      message: 'Error creating user',
      error: error.message,
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
  changePin,
  getCurrentUser,
  updateProfile
};