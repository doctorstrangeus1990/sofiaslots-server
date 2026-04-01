// routes/paymentRoutes.js
const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const authMiddleware = require('../middleware/authMiddleware');
const adminMiddleware = require('../middleware/adminMiddleware');

// ================================
// PUBLIC ROUTES (No Auth Required)
// ================================

// Crypto webhook (called by payment gateway)
router.post('/crypto/webhook', paymentController.confirmPayment);

// Cashapp proxy
router.get('/cashapp/proxy', paymentController.cashappProxy);

// ================================
// USER ROUTES (Auth Required)
// ================================

// Crypto routes
router.get('/crypto/list', authMiddleware, paymentController.getCryptoList);
router.post('/crypto/create', authMiddleware, paymentController.createPaymentRequest);

// Cashapp routes
router.post('/cashapp/create', authMiddleware, paymentController.createCashappPaymentRequest);
router.post('/cashapp/verify', authMiddleware, paymentController.verifyCashappPayment); // NEW - Start verification polling
router.get('/cashapp/status/:transactionId', authMiddleware, paymentController.checkCashappPaymentStatus); // NEW - Check payment status

// Chime routes
router.post('/chime/setup', authMiddleware, paymentController.setupChimePayment);
router.post('/chime/create', authMiddleware, paymentController.createChimePaymentRequest);
router.post('/chime/verify', authMiddleware, paymentController.verifyChimePayment);
router.get('/chime/details', authMiddleware, paymentController.getUserChimeDetails);

// General payment routes
router.get('/methods', authMiddleware, paymentController.getPaymentMethods);

// ================================
// ADMIN ROUTES (Admin Auth Required)
// ================================

// Get all payment configurations
router.get('/admin/configs', authMiddleware, adminMiddleware, paymentController.getAllPaymentConfigs);

// Save crypto configuration
router.post('/admin/crypto/config', authMiddleware, adminMiddleware, paymentController.saveCryptoConfig);

// Save cashapp configuration
router.post('/admin/cashapp/config', authMiddleware, adminMiddleware, paymentController.saveCashappConfig);

// Save chime configuration
router.post('/admin/chime/config', authMiddleware, adminMiddleware, paymentController.saveChimeConfig);

// Toggle payment method active status
router.patch('/admin/:method/toggle', authMiddleware, adminMiddleware, paymentController.togglePaymentMethod);

module.exports = router;