// src/controllers/delivery/walletTopUp.controller.js
//
// ═══════════════════════════════════════════════════════════════════════════════
// WALLET TOP-UP CONTROLLER  —  driver-facing
// ═══════════════════════════════════════════════════════════════════════════════
//
// These endpoints are called by the driver's mobile app.
//
// Endpoints owned by this file:
//   POST   /api/deliveries/driver/wallet/topup          submitTopUp
//   GET    /api/deliveries/driver/wallet/topup          getMyTopUps
//   GET    /api/deliveries/driver/wallet/topup/:id      getTopUpDetail
//   GET    /api/deliveries/driver/wallet                getWallet
//
// Auth: authenticate (JWT) → driver resolved via req.user.uuid → Driver.userId
//
// Mobile money note:
//   MTN MoMo and Orange Money flows currently follow the same manual
//   screenshot-verification path as cash.  When the telco APIs become
//   available, submitTopUp() will be extended with a payment-initiation
//   branch — the rest of this controller stays unchanged.
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const { Driver, Account }       = require('../../models');
const walletTopUpService        = require('../../services/delivery/walletTopUp.service');
const { uploadFileToR2 }        = require('../../middleware/upload');

// ─── Internal helper ──────────────────────────────────────────────────────────

/**
 * Resolve the Driver record from the JWT user UUID.
 * Returns null if not found — callers handle the 404.
 *
 * @param {string} accountUuid  req.user.uuid
 */
async function getDriverByAccountUuid(accountUuid) {
    return Driver.findOne({
        where:      { userId: accountUuid },
        attributes: ['id', 'userId', 'status', 'current_mode', 'phone', 'rating'],
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. SUBMIT TOP-UP REQUEST
// POST /api/deliveries/driver/wallet/topup
//
// Body (multipart/form-data):
//   amount            {number}  required  — XAF amount to reload
//   payment_channel   {string}  required  — 'cash' | 'mtn_mobile_money' | 'orange_money'
//   proof             {file}    optional  — screenshot (required for MTN/Orange)
//   payment_reference {string}  optional  — telco transaction reference
//   sender_phone      {string}  optional  — phone number used for the transfer
//   driver_note       {string}  optional  — message to the reviewer
//
// The driver uploads their proof screenshot directly from the app.
// The file is pushed to R2 before the DB record is created.
// ═══════════════════════════════════════════════════════════════════════════════
exports.submitTopUp = async (req, res) => {
    try {
        const driver = await getDriverByAccountUuid(req.user.uuid);
        if (!driver) {
            return res.status(404).json({
                success: false,
                message: 'Driver record not found. Please contact support.',
            });
        }

        const {
            amount,
            payment_channel,
            payment_reference = null,
            sender_phone      = null,
            driver_note       = null,
        } = req.body;

        // ── Upload proof screenshot to R2 (if provided) ───────────────────────
        let proof_url = null;
        if (req.file) {
            try {
                proof_url = await uploadFileToR2(req.file, 'delivery/topup-proofs');
            } catch (uploadErr) {
                console.error('❌ [TOP-UP] Proof upload failed:', uploadErr.message);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to upload payment proof. Please try again.',
                });
            }
        }

        const topUp = await walletTopUpService.submitTopUp(driver.id, {
            amount,
            payment_channel,
            proof_url,
            payment_reference,
            sender_phone,
            driver_note,
        });

        // Determine whether this was an existing duplicate or newly created
        const isExisting = (new Date() - new Date(topUp.created_at)) > 5000;

        return res.status(isExisting ? 200 : 201).json({
            success: true,
            message: isExisting
                ? 'You already have a pending request for this amount. Showing existing request.'
                : 'Top-up request submitted successfully. A WeGo agent will verify your payment shortly.',
            data: {
                id:               topUp.id,
                topup_code:       topUp.topup_code,
                amount:           topUp.amount,
                payment_channel:  topUp.payment_channel,
                channel_label:    topUp.channelLabel,
                status:           topUp.status,
                proof_url:        topUp.proof_url,
                payment_reference: topUp.payment_reference,
                driver_note:      topUp.driver_note,
                submitted_at:     topUp.created_at,
            },
        });

    } catch (error) {
        console.error('❌ [TOP-UP] submitTopUp error:', error.message);
        const status = error.statusCode || 500;
        return res.status(status).json({
            success: false,
            message: error.message || 'Failed to submit top-up request.',
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 2. LIST MY TOP-UP REQUESTS
// GET /api/deliveries/driver/wallet/topup
//
// Query params:
//   page    {number}  default 1
//   limit   {number}  default 20
//   status  {string}  optional — filter by status
// ═══════════════════════════════════════════════════════════════════════════════
exports.getMyTopUps = async (req, res) => {
    try {
        const driver = await getDriverByAccountUuid(req.user.uuid);
        if (!driver) {
            return res.status(404).json({ success: false, message: 'Driver record not found.' });
        }

        const { page = 1, limit = 20, status } = req.query;

        const result = await walletTopUpService.getDriverTopUps(driver.id, {
            page,
            limit,
            status: status || undefined,
        });

        return res.json({
            success: true,
            data: {
                topups: result.rows.map(formatTopUpForDriver),
                pagination: {
                    total:      result.count,
                    page:       result.page,
                    limit:      result.limit,
                    totalPages: Math.ceil(result.count / result.limit),
                },
            },
        });

    } catch (error) {
        console.error('❌ [TOP-UP] getMyTopUps error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to load top-up history.' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 3. GET SINGLE TOP-UP DETAIL
// GET /api/deliveries/driver/wallet/topup/:id
// ═══════════════════════════════════════════════════════════════════════════════
exports.getTopUpDetail = async (req, res) => {
    try {
        const driver = await getDriverByAccountUuid(req.user.uuid);
        if (!driver) {
            return res.status(404).json({ success: false, message: 'Driver record not found.' });
        }

        const topUpId = parseInt(req.params.id);
        if (!topUpId || isNaN(topUpId)) {
            return res.status(400).json({ success: false, message: 'Invalid top-up ID.' });
        }

        // Pass driverId to scope the query — prevents drivers viewing each other's requests
        const topUp = await walletTopUpService.getTopUpById(topUpId, driver.id);

        return res.json({
            success: true,
            data:    formatTopUpForDriver(topUp),
        });

    } catch (error) {
        console.error('❌ [TOP-UP] getTopUpDetail error:', error.message);
        const status = error.statusCode || 500;
        return res.status(status).json({
            success: false,
            message: error.message || 'Failed to load top-up detail.',
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 4. GET WALLET BALANCE
// GET /api/deliveries/driver/wallet
//
// Returns the driver's current wallet with all balance fields.
// Called by the app on every screen load to keep the balance display fresh.
// ═══════════════════════════════════════════════════════════════════════════════
exports.getWallet = async (req, res) => {
    try {
        const driver = await getDriverByAccountUuid(req.user.uuid);
        if (!driver) {
            return res.status(404).json({ success: false, message: 'Driver record not found.' });
        }

        // getOrCreateWallet ensures every driver always has a wallet record
        const wallet = await walletTopUpService.getOrCreateWallet(driver.id);

        return res.json({
            success: true,
            data: {
                wallet_id:              wallet.id,
                balance:                wallet.balance,
                available_balance:      wallet.availableBalance,
                reserved_balance:       wallet.reserved_balance,
                pending_withdrawal:     wallet.pending_withdrawal,
                total_topped_up:        wallet.total_topped_up,
                total_earned:           wallet.total_earned,
                total_commission_paid:  wallet.total_commission_paid,
                outstanding_commission: wallet.outstandingCashCommission,
                status:                 wallet.status,
                // Guidance for the app UI
                can_accept_jobs:        wallet.status === 'active' && wallet.availableBalance > 0,
                frozen_reason:          wallet.status !== 'active' ? wallet.frozen_reason : null,
            },
        });

    } catch (error) {
        console.error('❌ [TOP-UP] getWallet error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to load wallet.' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// INTERNAL FORMATTERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Shape a top-up record for the driver's mobile app.
 * Never expose admin_note or reviewed_by to the driver.
 */
function formatTopUpForDriver(topUp) {
    return {
        id:                    topUp.id,
        topup_code:            topUp.topup_code,
        amount:                topUp.amount,
        payment_channel:       topUp.payment_channel,
        channel_label:         topUp.channelLabel,
        status:                topUp.status,
        proof_url:             topUp.proof_url,
        payment_reference:     topUp.payment_reference,
        driver_note:           topUp.driver_note,
        // Only show rejection reason when actually rejected
        rejection_reason:      topUp.status === 'rejected' ? topUp.rejection_reason : null,
        // Balance snapshot — visible once credited
        balance_before_credit: topUp.balance_before_credit,
        balance_after_credit:  topUp.balance_after_credit,
        // Timeline
        submitted_at:          topUp.created_at,
        confirmed_at:          topUp.confirmed_at,
        credited_at:           topUp.credited_at,
        rejected_at:           topUp.rejected_at,
    };
}