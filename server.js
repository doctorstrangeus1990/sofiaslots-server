const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const path = require('path');
const requestIp = require('request-ip'); // ✅ ADD THIS

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 5000;

// ================================
// IMPORT ROUTES
// ================================

const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const gameRoutes = require('./routes/gameRoutes');
const walletRoutes = require('./routes/walletRoutes');
const adminAuthRoutes = require('./routes/adminAuthRoutes');
const adminDataRoutes = require('./routes/adminDataRoutes');
const adminSettingsRoutes = require('./routes/adminSettingsRoutes');
const gameAdminRoutes = require('./routes/gameAdminRoutes');
const publicRoutes = require('./routes/publicRoutes');
const spinWheelRoutes = require('./routes/spinWheelRoutes');
const adminSpinRoutes = require('./routes/adminSpinRoutes');
const referralRoutes = require('./routes/referralRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const cashoutRulesRoutes = require('./routes/CashoutRulesRoutes');
const unsubscribeRoutes = require('./routes/unsubscribeRoutes');

// ================================
// IMPORT CRON JOBS
// ================================

const { startChimeVerificationJob } = require('./jobs/chimeVerificationJob');

// ================================
// TRUST PROXY CONFIGURATION
// ================================
// ✅ CRITICAL: Must be set BEFORE any middleware that uses req.ip
app.set('trust proxy', true);

// ================================
// SECURITY MIDDLEWARE
// ================================

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// ================================
// IP DETECTION MIDDLEWARE
// ================================
// ✅ ADD THIS - Must come early in middleware chain
app.use(requestIp.mw());

// ================================
// DYNAMIC CORS CONFIGURATION
// ================================

const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:8080',
  'https://frontend-belucky.ngrok-free.dev',
  'https://your-production-domain.com',
  'https://sofiaslots-admin-frontend.onrender.com/',
  'https://sofiaslots-frontend-user.onrender.com/',
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  
  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  
  next();
});

// ================================
// RATE LIMITING - TEMPORARILY DISABLED FOR TESTING
// ================================

// const limiter = rateLimit({
//   windowMs: 15 * 60 * 1000,
//   max: 100,
//   message: {
//     success: false,
//     message: 'Too many requests from this IP, please try again later.'
//   },
//   standardHeaders: true,
//   legacyHeaders: false,
// });
// app.use(limiter);

// TODO: Re-enable rate limiting after testing

// ================================
// BODY PARSING MIDDLEWARE
// ================================

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// ================================
// IP LOGGING MIDDLEWARE (OPTIONAL - FOR DEBUGGING)
// ================================
app.use((req, res, next) => {
  // Clean up IPv6 localhost
  let ip = req.clientIp || req.ip || 'unknown';
  if (ip === '::1' || ip === '::ffff:127.0.0.1') {
    ip = '127.0.0.1';
  }
  if (ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }
  
  // Log requests (comment out in production if too verbose)
  if (process.env.NODE_ENV === 'development') {
    console.log(`${req.method} ${req.path} from ${ip}`);
  }
  
  next();
});

// ================================
// DATABASE CONNECTION
// ================================

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(
      process.env.MONGODB_URI || 'mongodb://localhost:27017/belucky-casino'
    );
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
    
    // Start cron jobs after successful database connection
    startChimeVerificationJob();
    
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    process.exit(1);
  }
};

connectDB();

// ================================
// API ROUTES
// ================================

app.post('/api/test-post', (req, res) => {
  res.json({ 
    success: true, 
    message: 'POST request working', 
    body: req.body,
    ip: req.clientIp || req.ip // ✅ Test IP detection
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/games', gameRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/bonus-settings', adminSettingsRoutes);
app.use('/api/admin/spin-wheel', adminSpinRoutes);
app.use('/api/admin-data', adminDataRoutes);
app.use('/api/admin', adminAuthRoutes);
app.use('/api/admin', gameAdminRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/spin-wheel', spinWheelRoutes);
app.use('/api/referral', referralRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/cashout-rules', cashoutRulesRoutes);
app.use('/api/unsubscribe', unsubscribeRoutes);

// Static files
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// ================================
// HEALTH CHECK
// ================================

app.get('/health', (req, res) => {
  let ip = req.clientIp || req.ip || 'unknown';
  if (ip === '::1' || ip === '::ffff:127.0.0.1') {
    ip = '127.0.0.1';
  }
  if (ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }

  res.json({ 
    success: true, 
    message: 'Server is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    requestIP: ip, // ✅ Show detected IP
    headers: {
      'x-forwarded-for': req.headers['x-forwarded-for'] || null,
      'x-real-ip': req.headers['x-real-ip'] || null,
      'cf-connecting-ip': req.headers['cf-connecting-ip'] || null
    }
  });
});

// ================================
// 404 HANDLER
// ================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
    path: req.path,
    method: req.method
  });
});

// ================================
// ERROR HANDLING MIDDLEWARE
// ================================

app.use((err, req, res, next) => {
  console.error('❌ Error:', err.message);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Something went wrong!',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// ================================
// GRACEFUL SHUTDOWN
// ================================

process.on('SIGTERM', () => {
  console.log('⚠️  SIGTERM received. Closing HTTP server gracefully...');
  mongoose.connection.close(false, () => {
    console.log('✅ MongoDB connection closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('⚠️  SIGINT received. Closing HTTP server gracefully...');
  mongoose.connection.close(false, () => {
    console.log('✅ MongoDB connection closed');
    process.exit(0);
  });
});

// ================================
// START SERVER
// ================================

app.listen(PORT, () => {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║                                                            ║');
  console.log(`║  🚀 BeLucky Casino Server                                  ║`);
  console.log(`║  📍 Port: ${PORT.toString().padEnd(46)} ║`);
  console.log(`║  🌍 Environment: ${(process.env.NODE_ENV || 'development').padEnd(39)} ║`);
  console.log(`║  ⏰ Started: ${new Date().toLocaleString().padEnd(41)} ║`);
  console.log('║                                                            ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log('║  📋 AVAILABLE PAYMENT METHODS:                             ║');
  console.log('║     • Cryptocurrency (Bitcoin, ETH, LTC, etc.)             ║');
  console.log('║     • CashApp                                              ║');
  console.log('║     • Chime (Auto-verification enabled)                    ║');
  console.log('║                                                            ║');
  console.log('║  🔄 BACKGROUND JOBS:                                       ║');
  console.log('║     • Chime payment verification (Every 2 minutes)         ║');
  console.log('║                                                            ║');
  console.log('║  🎁 BONUS SYSTEM:                                          ║');
  console.log('║     • Signup bonus (configurable)                          ║');
  console.log('║     • First deposit bonus (configurable)                   ║');
  console.log('║     • Promotional campaigns (time-limited)                 ║');
  console.log('║     • API: /api/bonus-settings (admin protected)           ║');
  console.log('║                                                            ║');
  console.log('║  🔐 SECURITY:                                              ║');
  console.log('║     • Helmet.js enabled                                    ║');
  console.log('║     • IP tracking with request-ip library                  ║');
  console.log('║     • Trust proxy enabled                                  ║');
  console.log('║     • Rate limiting DISABLED (testing mode)                ║');
  console.log('║     • CORS configured for allowed origins                  ║');
  console.log('║                                                            ║');
  console.log('║  🌐 IP DETECTION:                                          ║');
  console.log('║     • Works with proxies (Nginx, Cloudflare, etc.)         ║');
  console.log('║     • Tracks signup and login IPs                          ║');
  console.log('║     • Login history with IP and user agent                 ║');
  console.log('║     • Test endpoint: GET /health                           ║');
  console.log('║                                                            ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
});

module.exports = app;