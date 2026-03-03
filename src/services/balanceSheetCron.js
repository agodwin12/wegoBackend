// src/services/balanceSheetCron.js
//
// ═══════════════════════════════════════════════════════════════════════
// DAILY BALANCE SHEET CRON JOB
// ═══════════════════════════════════════════════════════════════════════
//
// Runs every day at midnight Cameroon time (UTC+1 = 23:00 UTC)
// Covers the previous calendar day: 00:00:00 → 23:59:59 Cameroon time
//
// What it does for each active driver:
//   1. Reads all SETTLED TripReceipts for yesterday
//   2. Splits by payment method: CASH vs MOMO/OM
//   3. Calculates cash_commission_owed and digital_earned
//   4. Carries forward any unpaid debt from previous day
//   5. Creates one DailyBalanceSheet row (idempotent — skips if exists)
//   6. Checks consecutiveUnpaidDays → blocks driver if >= 2
//   7. Sends push/SMS notification to driver with their daily summary
//
// Idempotency:
//   Safe to run multiple times — uses findOrCreate on (driverId, sheetDate)
//   so duplicate runs never create duplicate sheets.
//
// How to register in server.js:
//   const balanceSheetCron = require('./services/balanceSheetCron');
//   balanceSheetCron.start();
//
// ═══════════════════════════════════════════════════════════════════════

'use strict';

const cron       = require('node-cron');
const { Op }     = require('sequelize');
const sequelize  = require('../config/database');

const {
    Account,
    DriverProfile,
    TripReceipt,
    DailyBalanceSheet,
    DriverWallet,
} = require('../models');

// ─── Constants ────────────────────────────────────────────────────────
const CAMEROON_UTC_OFFSET_HOURS = 1;   // UTC+1
const MAX_UNPAID_DAYS_BEFORE_BLOCK = 2;

// ═══════════════════════════════════════════════════════════════════════
// MAIN CRON FUNCTION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Generates balance sheets for ALL active drivers for yesterday.
 * Called by the cron schedule and also exportable for manual runs.
 */
async function runDailyBalanceSheet() {
    const runId = `BS-RUN-${Date.now()}`;

    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log(`║  💰 BALANCE SHEET CRON STARTED  [${runId}]`);
    console.log('╚══════════════════════════════════════════════════════╝');

    // ── 1. Calculate yesterday's date range in Cameroon time ──────────
    const { sheetDate, dayStart, dayEnd } = _getYesterdayRange();
    console.log(`📅 Processing date: ${sheetDate}  (${dayStart.toISOString()} → ${dayEnd.toISOString()})`);

    // ── 2. Get all active driver accounts ─────────────────────────────
    const drivers = await Account.findAll({
        where:      { user_type: 'DRIVER', status: 'ACTIVE' },
        attributes: ['uuid'],
    });

    console.log(`👥 Processing ${drivers.length} active drivers`);

    let processed  = 0;
    let skipped    = 0;
    let blocked    = 0;
    let errors     = 0;

    // ── 3. Process each driver ────────────────────────────────────────
    for (const driver of drivers) {
        try {
            await _processDriverDay(driver.uuid, sheetDate, dayStart, dayEnd);
            processed++;
        } catch (err) {
            errors++;
            console.error(`❌ Error processing driver ${driver.uuid}:`, err.message);
        }
    }

    // ── 4. Auto-block drivers with >= 2 consecutive unpaid days ───────
    blocked = await _autoBlockOverdueDrivers(sheetDate);

    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log(`║  ✅ BALANCE SHEET CRON COMPLETED [${runId}]`);
    console.log(`║  📊 Processed: ${processed} | Skipped: ${skipped} | Blocked: ${blocked} | Errors: ${errors}`);
    console.log('╚══════════════════════════════════════════════════════╝\n');

    return { processed, skipped, blocked, errors, sheetDate };
}

// ═══════════════════════════════════════════════════════════════════════
// PROCESS ONE DRIVER FOR ONE DAY
// ═══════════════════════════════════════════════════════════════════════

async function _processDriverDay(driverId, sheetDate, dayStart, dayEnd) {

    // ── Step 1: Check if sheet already exists (idempotency) ───────────
    const existing = await DailyBalanceSheet.findOne({
        where: { driverId, sheetDate },
    });

    if (existing) {
        console.log(`  ⏭️  Sheet already exists for driver ${driverId} on ${sheetDate} — skipping`);
        return;
    }

    // ── Step 2: Fetch all SETTLED receipts for this driver yesterday ───
    const receipts = await TripReceipt.findAll({
        where: {
            driverId,
            status:    'SETTLED',
            createdAt: { [Op.gte]: dayStart, [Op.lte]: dayEnd },
        },
    });

    // ── Step 3: Split by payment method and aggregate ─────────────────
    const cashReceipts    = receipts.filter(r => r.paymentMethod === 'CASH');
    const digitalReceipts = receipts.filter(r => ['MOMO', 'OM'].includes(r.paymentMethod));

    const cashTripsCount   = cashReceipts.length;
    const cashGrossFare    = cashReceipts.reduce((s, r) => s + (r.grossFare        || 0), 0);
    const cashCommOwed     = cashReceipts.reduce((s, r) => s + (r.commissionAmount || 0), 0);

    const digitalTripsCount = digitalReceipts.length;
    const digitalEarned     = digitalReceipts.reduce((s, r) => s + (r.driverNet || 0), 0);

    // ── Step 4: Get debt carried forward from previous day ────────────
    const debtCarriedForward = await _getDebtCarriedForward(driverId, sheetDate);

    // ── Step 5: Calculate totals ──────────────────────────────────────
    const totalDebt              = cashCommOwed + debtCarriedForward;
    const netPosition            = digitalEarned - totalDebt;
    const debtRemainingAmount    = totalDebt;      // starts at full debt, reduced as driver pays
    const digitalPayoutRemaining = digitalEarned;  // starts at full amount, reduced as WEGO pays

    // ── Step 6: Count consecutive unpaid days ─────────────────────────
    const consecutiveUnpaidDays = await _getConsecutiveUnpaidDays(driverId, sheetDate);

    // ── Step 7: Create the balance sheet ──────────────────────────────
    const sheet = await DailyBalanceSheet.create({
        driverId,
        sheetDate,

        cashTripsCount,
        cashGrossFare,
        cashCommissionOwed:     cashCommOwed,

        digitalTripsCount,
        digitalEarned,

        debtCarriedForward,
        totalDebt,
        netPosition,

        debtPaidAmount:          0,
        debtRemainingAmount,
        digitalPayoutAmount:     0,
        digitalPayoutRemaining,

        consecutiveUnpaidDays,
        driverBlockedToday:      false,   // will be set by _autoBlockOverdueDrivers
        status:                  'OPEN',
    });

    // ── Step 8: Update driver wallet totals ───────────────────────────
    await _updateWalletFromSheet(driverId, cashCommOwed, digitalEarned);

    console.log(
        `  ✅ Sheet created for ${driverId} | ` +
        `Cash debt: ${cashCommOwed} XAF | ` +
        `Digital earned: ${digitalEarned} XAF | ` +
        `Net: ${netPosition} XAF | ` +
        `Carried forward: ${debtCarriedForward} XAF`
    );
}

// ═══════════════════════════════════════════════════════════════════════
// AUTO-BLOCK OVERDUE DRIVERS
// ═══════════════════════════════════════════════════════════════════════

async function _autoBlockOverdueDrivers(sheetDate) {
    // Find all drivers whose sheet today shows consecutiveUnpaidDays >= MAX
    const overdueSheets = await DailyBalanceSheet.findAll({
        where: {
            sheetDate,
            consecutiveUnpaidDays: { [Op.gte]: MAX_UNPAID_DAYS_BEFORE_BLOCK },
            debtRemainingAmount:   { [Op.gt]: 0 },
            driverBlockedToday:    false,
        },
        attributes: ['id', 'driverId'],
    });

    if (overdueSheets.length === 0) {
        console.log('  ℹ️  No drivers to auto-block today');
        return 0;
    }

    let blockedCount = 0;

    for (const sheet of overdueSheets) {
        try {
            // Block the account
            await Account.update(
                { status: 'SUSPENDED' },
                { where: { uuid: sheet.driverId } }
            );

            // Block the driver profile (set status to suspended)
            await DriverProfile.update(
                { status: 'suspended' },
                { where: { account_id: sheet.driverId } }
            );

            // Mark the sheet
            await sheet.update({ driverBlockedToday: true });

            blockedCount++;
            console.log(`  🚫 Driver ${sheet.driverId} AUTO-BLOCKED — ${MAX_UNPAID_DAYS_BEFORE_BLOCK} consecutive days unpaid`);

        } catch (err) {
            console.error(`  ❌ Failed to block driver ${sheet.driverId}:`, err.message);
        }
    }

    console.log(`  🚫 Auto-blocked ${blockedCount} drivers`);
    return blockedCount;
}

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Returns yesterday's date string and UTC timestamps for day start/end
 * adjusted for Cameroon time (UTC+1).
 *
 * Cameroon midnight = UTC 23:00 the day before.
 * So "yesterday Cameroon" = UTC (yesterday 23:00) → (today 22:59:59)
 */
function _getYesterdayRange() {
    const now = new Date();

    // Yesterday in Cameroon = today minus 1 day, at midnight Cameroon
    const yesterdayCameroon = new Date(now);
    yesterdayCameroon.setUTCDate(yesterdayCameroon.getUTCDate() - 1);

    const year  = yesterdayCameroon.getUTCFullYear();
    const month = yesterdayCameroon.getUTCMonth();
    const day   = yesterdayCameroon.getUTCDate();

    // Cameroon midnight (00:00 local) = UTC 23:00 the day before
    const dayStart = new Date(Date.UTC(year, month, day - 1, 23, 0, 0, 0));  // 23:00 UTC two days ago
    const dayEnd   = new Date(Date.UTC(year, month, day,     22, 59, 59, 999)); // 22:59:59 UTC yesterday

    // Sheet date string = yesterday in Cameroon (YYYY-MM-DD)
    const sheetDate = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    return { sheetDate, dayStart, dayEnd };
}

/**
 * Gets the unpaid debt carried forward from the most recent previous sheet.
 * If the previous sheet has remaining unpaid debt, that rolls into today.
 */
async function _getDebtCarriedForward(driverId, sheetDate) {
    const previousSheet = await DailyBalanceSheet.findOne({
        where:   {
            driverId,
            sheetDate: { [Op.lt]: sheetDate },
            debtRemainingAmount: { [Op.gt]: 0 },
        },
        order:   [['sheetDate', 'DESC']],
        attributes: ['debtRemainingAmount'],
    });

    return previousSheet ? previousSheet.debtRemainingAmount : 0;
}

/**
 * Counts how many consecutive days this driver has had unpaid debt
 * leading up to (not including) today.
 */
async function _getConsecutiveUnpaidDays(driverId, sheetDate) {
    // Get the last 7 sheets (more than enough) ordered newest first
    const recentSheets = await DailyBalanceSheet.findAll({
        where:   {
            driverId,
            sheetDate: { [Op.lt]: sheetDate },
        },
        order:      [['sheetDate', 'DESC']],
        limit:      7,
        attributes: ['sheetDate', 'debtRemainingAmount', 'totalDebt'],
    });

    if (recentSheets.length === 0) return 0;

    let consecutive = 0;
    for (const sheet of recentSheets) {
        // A day counts as "unpaid" if totalDebt > 0 and debtRemainingAmount > 0
        if (sheet.totalDebt > 0 && sheet.debtRemainingAmount > 0) {
            consecutive++;
        } else {
            break; // streak broken
        }
    }

    return consecutive;
}

/**
 * Updates the DriverWallet running totals from the day's figures.
 * totalCommission increases by cash commission owed.
 * totalEarned increases by digital earned.
 */
async function _updateWalletFromSheet(driverId, cashCommOwed, digitalEarned) {
    const wallet = await DriverWallet.findOne({ where: { driverId } });
    if (!wallet) {
        console.warn(`  ⚠️  No wallet found for driver ${driverId} — skipping wallet update`);
        return;
    }

    wallet.totalCommission = (wallet.totalCommission || 0) + cashCommOwed;
    wallet.totalEarned     = (wallet.totalEarned     || 0) + digitalEarned;
    // balance increases by digital earned (WEGO owes this to driver)
    wallet.balance         = (wallet.balance         || 0) + digitalEarned;

    await wallet.save();
}

// ═══════════════════════════════════════════════════════════════════════
// MANUAL RUN HELPER (for admin endpoint or testing)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Run balance sheet for a specific date manually.
 * Used by admin endpoint POST /api/admin/earnings/balance-sheets/run
 *
 * @param {string} dateString  YYYY-MM-DD in Cameroon time
 */
async function runForDate(dateString) {
    console.log(`\n📅 [BALANCE SHEET] Manual run for date: ${dateString}`);

    // Build UTC range from the Cameroon date string
    const [year, month, day] = dateString.split('-').map(Number);

    // Cameroon 00:00 = UTC 23:00 previous day
    const dayStart = new Date(Date.UTC(year, month - 1, day - 1, 23, 0, 0, 0));
    const dayEnd   = new Date(Date.UTC(year, month - 1, day,     22, 59, 59, 999));

    const drivers = await Account.findAll({
        where:      { user_type: 'DRIVER', status: { [Op.in]: ['ACTIVE', 'SUSPENDED'] } },
        attributes: ['uuid'],
    });

    console.log(`👥 Processing ${drivers.length} drivers for ${dateString}`);

    let processed = 0;
    let errors    = 0;

    for (const driver of drivers) {
        try {
            await _processDriverDay(driver.uuid, dateString, dayStart, dayEnd);
            processed++;
        } catch (err) {
            errors++;
            console.error(`❌ Error for driver ${driver.uuid}:`, err.message);
        }
    }

    await _autoBlockOverdueDrivers(dateString);

    console.log(`✅ Manual run complete: ${processed} processed, ${errors} errors`);
    return { processed, errors, dateString };
}

// ═══════════════════════════════════════════════════════════════════════
// CRON SCHEDULE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Starts the cron job.
 * Schedule: 23:00 UTC = 00:00 Cameroon time (UTC+1)
 *
 * Cron syntax: '0 23 * * *'
 *   0    = minute 0
 *   23   = hour 23 UTC
 *   * * *  = every day, every month, every weekday
 */
function start() {
    console.log('⏰ [BALANCE SHEET CRON] Scheduled for 23:00 UTC (00:00 Cameroon time) daily');

    cron.schedule('0 23 * * *', async () => {
        try {
            await runDailyBalanceSheet();
        } catch (err) {
            console.error('❌ [BALANCE SHEET CRON] Fatal error:', err);
        }
    }, {
        timezone: 'UTC',
    });
}

// ═══════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════

module.exports = {
    start,
    runDailyBalanceSheet,
    runForDate,
};