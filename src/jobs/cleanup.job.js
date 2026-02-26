// src/jobs/cleanup.job.js
const cron = require('node-cron');
const { cleanupExpiredPendingSignups } = require('../services/cleanup.service');



function startCleanupJob() {
    console.log('🚀 [CRON JOB] Starting cleanup job scheduler...');
    console.log('⏰ [CRON JOB] Will run every hour');

    // Run every hour
    cron.schedule('0 * * * *', async () => {
        console.log('\n⏰ [CRON JOB] Scheduled cleanup triggered');
        await cleanupExpiredPendingSignups();
    });

    // Optional: Run immediately on startup (for testing)
    if (process.env.RUN_CLEANUP_ON_STARTUP === 'true') {
        console.log('🔧 [CRON JOB] Running initial cleanup on startup...');
        setTimeout(async () => {
            await cleanupExpiredPendingSignups();
        }, 5000); // Wait 5 seconds after startup
    }

    console.log('✅ [CRON JOB] Cleanup job scheduler started\n');
}

module.exports = {
    startCleanupJob,
};