// jobs/chimeVerificationJob.js
const cron = require('node-cron');
const { autoVerifyChimePayments } = require('../controllers/paymentController');

// Run every 2 minutes
const startChimeVerificationJob = () => {
    cron.schedule('*/2 * * * *', async () => {
        console.log('Running Chime payment auto-verification...');
        try {
            await autoVerifyChimePayments();
        } catch (error) {
            console.error('Error in Chime verification cron job:', error);
        }
    });
    
    console.log('Chime payment verification cron job started (runs every 2 minutes)');
};

module.exports = { startChimeVerificationJob };