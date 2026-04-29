// src/controllers/delivery/walletTopUpAdmin.controller.js
//
// ═══════════════════════════════════════════════════════════════════════════════
// WALLET TOP-UP ADMIN CONTROLLER  —  backoffice
// ═══════════════════════════════════════════════════════════════════════════════
//
// Used by WeGo office staff (cashiers, support, managers) to process
// driver wallet reload requests.
//
// Workflow for a typical request:
//   1. Driver submits → status: pending
//   2. Employee opens the queue → calls markUnderReview (claims item)
//   3. Employee checks proof / counts cash → calls confirmTopUp
//   4. Employee (or manager) calls creditWallet → balance updated
//   OR in one shot: calls confirmAndCredit (roles that allow self-approval)
//
// Endpoints owned by this file:
//   GET    /api/backoffice/delivery/topups               getQueue
//   GET    /api/backoffice/delivery/topups/:id           getTopUpDetail
//   PATCH  /api/backoffice/delivery/topups/:id/review    markUnderReview
//   PATCH  /api/backoffice/delivery/topups/:id/confirm   confirmTopUp
//   POST   /api/backoffice/delivery/topups/:id/credit    creditWallet
//   POST   /api/backoffice/delivery/topups/:id/approve   confirmAndCredit
//   PATCH  /api/backoffice/delivery/topups/:id/reject    rejectTopUp
//
// Auth: authenticateEmployee — req.user is the Employee row.
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const { Account, Driver } = require('../../models');
const walletTopUpService  = require('../../services/delivery/walletTopUp.service');

// ═══════════════════════════════════════════════════════════════════════════════
// 1. GET QUEUE
// GET /api/backoffice/delivery/topups
//
// Returns paginated top-up requests with summary stats for the dashboard banner.
//
// Query params:
//   status   {string|string[]}  default 'pending,under_review'
//   channel  {string}           optional filter: cash | mtn_mobile_money | orange_money
//   page     {number}           default 1
//   limit    {number}           default 30
// ═══════════════════════════════════════════════════════════════════════════════
exports.getQueue = async (req, res) => {
    try {
        const {
            status,
            channel,
            page  = 1,
            limit = 30,
        } = req.query;

        // Support ?status=pending&status=under_review  OR  ?status=credited
        const statusFilter = status
            ? (Array.isArray(status) ? status : status.split(',').map(s => s.trim()))
            : undefined;

        const result = await walletTopUpService.getPendingQueue({
            status:  statusFilter,
            channel: channel || undefined,
            page,
            limit,
        });

        // Build summary totals from the stats rows
        const summaryMap  = { pending: 0, under_review: 0 };
        const amountMap   = { pending: 0, under_review: 0 };
        result.summary.forEach(row => {
            summaryMap[row.status] = parseInt(row.count       || 0);
            amountMap[row.status]  = parseFloat(row.total_amount || 0);
        });

        return res.json({
            success: true,
            data: {
                topups: result.rows.map(formatTopUpForAdmin),
                pagination: {
                    total:      result.count,
                    page:       result.page,
                    limit:      result.limit,
                    totalPages: Math.ceil(result.count / result.limit),
                },
                summary: {
                    pending_count:        summaryMap.pending,
                    under_review_count:   summaryMap.under_review,
                    pending_amount_xaf:   amountMap.pending,
                    under_review_amount_xaf: amountMap.under_review,
                    total_actionable:     summaryMap.pending + summaryMap.under_review,
                },
            },
        });

    } catch (error) {
        console.error('❌ [TOP-UP ADMIN] getQueue error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to load top-up queue.' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 2. GET SINGLE TOP-UP DETAIL
// GET /api/backoffice/delivery/topups/:id
// ═══════════════════════════════════════════════════════════════════════════════
exports.getTopUpDetail = async (req, res) => {
    try {
        const topUpId = parseInt(req.params.id);
        if (!topUpId || isNaN(topUpId)) {
            return res.status(400).json({ success: false, message: 'Invalid top-up ID.' });
        }

        // No driverId scope — admin can view any request
        const topUp = await walletTopUpService.getTopUpById(topUpId);

        // Enrich driver account details for the review panel
        let driverAccount = null;
        if (topUp.driver) {
            driverAccount = await Account.findOne({
                where:      { uuid: topUp.driver.userId },
                attributes: ['first_name', 'last_name', 'phone_e164', 'avatar_url', 'status'],
            });
        }

        return res.json({
            success: true,
            data: {
                ...formatTopUpForAdmin(topUp),
                driver_account: driverAccount
                    ? {
                        name:       `${driverAccount.first_name} ${driverAccount.last_name}`.trim(),
                        phone:      driverAccount.phone_e164,
                        avatar_url: driverAccount.avatar_url,
                        status:     driverAccount.status,
                    }
                    : null,
            },
        });

    } catch (error) {
        console.error('❌ [TOP-UP ADMIN] getTopUpDetail error:', error.message);
        const status = error.statusCode || 500;
        return res.status(status).json({ success: false, message: error.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 3. MARK UNDER REVIEW
// PATCH /api/backoffice/delivery/topups/:id/review
//
// Employee claims the item — moves pending → under_review.
// Prevents two employees processing the same request simultaneously.
// No body required.
// ═══════════════════════════════════════════════════════════════════════════════
exports.markUnderReview = async (req, res) => {
    try {
        const topUpId = parseInt(req.params.id);
        if (!topUpId || isNaN(topUpId)) {
            return res.status(400).json({ success: false, message: 'Invalid top-up ID.' });
        }

        const topUp = await walletTopUpService.markUnderReview(topUpId, req.user.id);

        return res.json({
            success: true,
            message: `Top-up ${topUp.topup_code} is now under review by you.`,
            data:    formatTopUpForAdmin(topUp),
        });

    } catch (error) {
        console.error('❌ [TOP-UP ADMIN] markUnderReview error:', error.message);
        const status = error.statusCode || 500;
        return res.status(status).json({ success: false, message: error.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 4. CONFIRM TOP-UP
// PATCH /api/backoffice/delivery/topups/:id/confirm
//
// Employee has verified the payment is genuine.
// Moves under_review → confirmed.
// Does NOT yet touch the wallet — call /credit to finalize.
//
// Body:
//   admin_note  {string}  optional — internal note
// ═══════════════════════════════════════════════════════════════════════════════
exports.confirmTopUp = async (req, res) => {
    try {
        const topUpId = parseInt(req.params.id);
        if (!topUpId || isNaN(topUpId)) {
            return res.status(400).json({ success: false, message: 'Invalid top-up ID.' });
        }

        const { admin_note = null } = req.body;

        const topUp = await walletTopUpService.confirmTopUp(topUpId, req.user.id, admin_note);

        return res.json({
            success: true,
            message: `Top-up ${topUp.topup_code} confirmed. Proceed to credit the wallet.`,
            data:    formatTopUpForAdmin(topUp),
        });

    } catch (error) {
        console.error('❌ [TOP-UP ADMIN] confirmTopUp error:', error.message);
        const status = error.statusCode || 500;
        return res.status(status).json({ success: false, message: error.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 5. CREDIT WALLET
// POST /api/backoffice/delivery/topups/:id/credit
//
// Final step — credits the driver's wallet balance.
// Top-up must already be in 'confirmed' status.
// Restricted to manager / admin / super_admin to enforce two-step approval.
// No body required.
// ═══════════════════════════════════════════════════════════════════════════════
exports.creditWallet = async (req, res) => {
    try {
        const topUpId = parseInt(req.params.id);
        if (!topUpId || isNaN(topUpId)) {
            return res.status(400).json({ success: false, message: 'Invalid top-up ID.' });
        }

        const result = await walletTopUpService.creditWallet(topUpId, req.user.id);

        return res.json({
            success: true,
            message: `Wallet credited successfully. ${result.creditAmount.toLocaleString()} XAF added to driver's balance.`,
            data: {
                topup_code:      result.topUp.topup_code,
                amount_credited: result.creditAmount,
                balance_before:  result.balanceBefore,
                balance_after:   result.balanceAfter,
                credited_at:     result.topUp.credited_at,
            },
        });

    } catch (error) {
        console.error('❌ [TOP-UP ADMIN] creditWallet error:', error.message);
        const status = error.statusCode || 500;
        return res.status(status).json({ success: false, message: error.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 6. CONFIRM + CREDIT  (single-step approval)
// POST /api/backoffice/delivery/topups/:id/approve
//
// Convenience endpoint for roles with full approval rights.
// Does confirmTopUp + creditWallet in a single call.
// Restricted to manager / admin / super_admin.
//
// Body:
//   admin_note  {string}  optional
// ═══════════════════════════════════════════════════════════════════════════════
exports.confirmAndCredit = async (req, res) => {
    try {
        const topUpId = parseInt(req.params.id);
        if (!topUpId || isNaN(topUpId)) {
            return res.status(400).json({ success: false, message: 'Invalid top-up ID.' });
        }

        const { admin_note = null } = req.body;

        const result = await walletTopUpService.confirmAndCredit(topUpId, req.user.id, admin_note);

        return res.json({
            success: true,
            message: `Top-up approved and wallet credited. ${result.creditAmount.toLocaleString()} XAF added.`,
            data: {
                topup_code:      result.topUp.topup_code,
                amount_credited: result.creditAmount,
                balance_before:  result.balanceBefore,
                balance_after:   result.balanceAfter,
                credited_at:     result.topUp.credited_at,
            },
        });

    } catch (error) {
        console.error('❌ [TOP-UP ADMIN] confirmAndCredit error:', error.message);
        const status = error.statusCode || 500;
        return res.status(status).json({ success: false, message: error.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 7. REJECT TOP-UP
// PATCH /api/backoffice/delivery/topups/:id/reject
//
// Body:
//   reason  {string}  required — shown to the driver in the app
// ═══════════════════════════════════════════════════════════════════════════════
exports.rejectTopUp = async (req, res) => {
    try {
        const topUpId = parseInt(req.params.id);
        if (!topUpId || isNaN(topUpId)) {
            return res.status(400).json({ success: false, message: 'Invalid top-up ID.' });
        }

        const { reason } = req.body;
        if (!reason || !reason.trim()) {
            return res.status(400).json({
                success: false,
                message: 'A rejection reason is required. The driver will see this message.',
            });
        }

        const topUp = await walletTopUpService.rejectTopUp(topUpId, req.user.id, reason);

        return res.json({
            success: true,
            message: `Top-up ${topUp.topup_code} rejected.`,
            data:    formatTopUpForAdmin(topUp),
        });

    } catch (error) {
        console.error('❌ [TOP-UP ADMIN] rejectTopUp error:', error.message);
        const status = error.statusCode || 500;
        return res.status(status).json({ success: false, message: error.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// INTERNAL FORMATTER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Full shape for backoffice — includes all admin fields.
 */
function formatTopUpForAdmin(topUp) {
    const driver = topUp.driver || null;
    const reviewer = topUp.reviewedByEmployee || null;

    return {
        id:                    topUp.id,
        topup_code:            topUp.topup_code,
        amount:                topUp.amount,
        payment_channel:       topUp.payment_channel,
        channel_label:         topUp.channelLabel,
        status:                topUp.status,
        proof_url:             topUp.proof_url,
        payment_reference:     topUp.payment_reference,
        sender_phone:          topUp.sender_phone,
        driver_note:           topUp.driver_note,
        admin_note:            topUp.admin_note,
        rejection_reason:      topUp.rejection_reason,
        balance_before_credit: topUp.balance_before_credit,
        balance_after_credit:  topUp.balance_after_credit,
        // Driver summary for queue list
        driver: driver
            ? {
                driver_id:  driver.id,
                user_id:    driver.userId,
                phone:      driver.phone,
                rating:     driver.rating,
                // account fields populated when driver association includes Account
                name: driver.account
                    ? `${driver.account.first_name} ${driver.account.last_name}`.trim()
                    : null,
                avatar_url: driver.account?.avatar_url || null,
            }
            : null,
        // Reviewer info
        reviewed_by: reviewer
            ? { id: reviewer.id, name: reviewer.name, email: reviewer.email }
            : null,
        // Timeline
        submitted_at:  topUp.created_at,
        reviewed_at:   topUp.reviewed_at,
        confirmed_at:  topUp.confirmed_at,
        credited_at:   topUp.credited_at,
        rejected_at:   topUp.rejected_at,
    };
}