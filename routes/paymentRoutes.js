// routes/paymentRoutes.js
const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const authMiddleware = require('../middleware/authMiddleware');
const adminMiddleware = require('../middleware/adminMiddleware');

// ================================
// PUBLIC ROUTES (No Auth Required)
// ================================

// Crypto webhook (called by crypto payment gateway)
router.post('/crypto/webhook', paymentController.confirmPayment);

// OXPay webhook (called by OXPay platform — must be public, no auth)
router.post('/cashapp/webhook', paymentController.oxpayWebhook);

// ================================
// USER ROUTES (Auth Required)
// ================================

// Crypto routes
router.get('/crypto/list', authMiddleware, paymentController.getCryptoList);
router.post('/crypto/create', authMiddleware, paymentController.createPaymentRequest);

// CashApp (OXPay) routes
router.post('/cashapp/create', authMiddleware, paymentController.createCashappPaymentRequest);
// REMOVED: /cashapp/verify  (no longer needed — OXPay pushes webhook)
// REMOVED: /cashapp/status  (no longer needed — OXPay pushes webhook)
// REMOVED: /cashapp/proxy   (no longer needed — pay_url goes directly to OXPay)

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

router.get('/admin/configs', authMiddleware, adminMiddleware, paymentController.getAllPaymentConfigs);
router.post('/admin/crypto/config', authMiddleware, adminMiddleware, paymentController.saveCryptoConfig);
router.post('/admin/cashapp/config', authMiddleware, adminMiddleware, paymentController.saveCashappConfig);
router.post('/admin/chime/config', authMiddleware, adminMiddleware, paymentController.saveChimeConfig);
router.patch('/admin/:method/toggle', authMiddleware, adminMiddleware, paymentController.togglePaymentMethod);

module.exports = router;