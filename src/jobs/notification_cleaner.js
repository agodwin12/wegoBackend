// src/jobs/notification_cleaner.js
//
// ═══════════════════════════════════════════════════════════════════════
// NOTIFICATION CLEANER — Two cron jobs for notification lifecycle
// ═══════════════════════════════════════════════════════════════════════
//
// Job 1 — Expired notification cleanup (daily at 02:00)
//   Deletes Notification rows where expires_at < NOW() (7-day TTL)
//
// Job 2 — Broadcast scheduler (every minute)
//   Fires BroadcastMessage rows where status=SCHEDULED and scheduled_at <= NOW()
//
// Usage: call startNotificationCleaner() once at app startup
// ═══════════════════════════════════════════════════════════════════════

const cron = require('node-cron');
const { Op } = require('sequelize');

// Lazy getters to avoid circular dependency issues at startup
const getNotification        = () => require('../models/Notification');
const getBroadcastMessage    = () => require('../models/BroadcastMessage');
const getNotificationService = () => require('../services/NotificationService');

// ─────────────────────────────────────────────────────────────────────────────
// JOB 1 — Delete expired notifications
// Runs: daily at 02:00
// ─────────────────────────────────────────────────────────────────────────────
async function runNotificationCleanup() {
    console.log('\n⏰ [CRON:NOTIF_CLEANUP] Deleting expired notifications...');
    try {
        const Notification = getNotification();
        const deleted = await Notification.destroy({
            where: {
                expires_at: { [Op.lt]: new Date() },
            },
        });
        console.log(`✅ [CRON:NOTIF_CLEANUP] Deleted ${deleted} expired notification(s)`);
    } catch (error) {
        console.error('❌ [CRON:NOTIF_CLEANUP] Failed:', error.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// JOB 2 — Fire scheduled broadcasts
// Runs: every minute
// ─────────────────────────────────────────────────────────────────────────────
async function runBroadcastScheduler() {
    try {
        const BroadcastMessage    = getBroadcastMessage();
        const NotificationService = getNotificationService();

        const dueBroadcasts = await BroadcastMessage.getDue();

        if (dueBroadcasts.length === 0) return; // silent — runs every minute

        console.log(`\n⏰ [CRON:BROADCAST] ${dueBroadcasts.length} broadcast(s) due — firing now...`);

        for (const broadcast of dueBroadcasts) {
            try {
                console.log(`📢 [CRON:BROADCAST] Firing #${broadcast.id}: "${broadcast.title}" → ${broadcast.target_type}`);
                await NotificationService.sendBroadcast(broadcast);
                console.log(`✅ [CRON:BROADCAST] Broadcast #${broadcast.id} sent`);
            } catch (err) {
                console.error(`❌ [CRON:BROADCAST] Broadcast #${broadcast.id} failed:`, err.message);
                // Don't rethrow — keep processing remaining broadcasts
            }
        }
    } catch (error) {
        console.error('❌ [CRON:BROADCAST] Scheduler error:', error.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
function startNotificationCleaner() {
    console.log('🚀 [CRON:NOTIF] Starting notification cleaner jobs...');

    // Job 1: Expired notifications — daily at 02:00
    cron.schedule('0 2 * * *', async () => {
        await runNotificationCleanup();
    });
    console.log('⏰ [CRON:NOTIF] Notif cleanup    → daily at 02:00');

    // Job 2: Broadcast scheduler — every minute
    cron.schedule('* * * * *', async () => {
        await runBroadcastScheduler();
    });
    console.log('⏰ [CRON:NOTIF] Broadcast cron   → every minute');

    // Optional: run cleanup immediately on startup for testing
    if (process.env.RUN_CLEANUP_ON_STARTUP === 'true') {
        console.log('🔧 [CRON:NOTIF] Running notification cleanup on startup in 5s...');
        setTimeout(async () => {
            await runNotificationCleanup();
        }, 5000);
    }

    console.log('✅ [CRON:NOTIF] Notification cleaner started\n');
}

module.exports = {
    startNotificationCleaner,
    // Export runners for manual testing / one-off calls
    runNotificationCleanup,
    runBroadcastScheduler,
};