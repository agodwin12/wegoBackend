// src/controllers/delivery/walletTopUp.controller.js
//
// ═══════════════════════════════════════════════════════════════════════════════
// WALLET TOP-UP CONTROLLER  —  driver-facing
// ═══════════════════════════════════════════════════════════════════════════════
//
// Endpoints owned by this file:
//   POST   /api/deliveries/driver/wallet/topup          submitTopUp (cash only)
//   POST   /api/deliveries/driver/wallet/topup/initiate initiateDigitalTopUp (MTN/Orange)
//   GET    /api/deliveries/driver/wallet/topup          getMyTopUps
//   GET    /api/deliveries/driver/wallet/topup/:id      getTopUpDetail
//   GET    /api/deliveries/driver/wallet                getWallet
//
// Auth: authenticate (JWT) → driver resolved via req.user.uuid → Driver.userId
//
// Payment channel routing:
//   cash             → submitTopUp()         — manual screenshot flow, backoffice reviews
//   mtn_mobile_money → initiateDigitalTopUp() — CamPay USSD, webhook auto-credits wallet
//   orange_money     → initiateDigitalTopUp() — CamPay USSD, webhook auto-credits wallet
//
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const { Driver }         = require('../../models');
const walletTopUpService = require('../../services/delivery/walletTopUp.service');

// ─── Internal helper ──────────────────────────────────────────────────────────

async function getDriverByAccountUuid(accountUuid) {
    return Driver.findOne({
        where:      { userId: accountUuid },
        attributes: ['id', 'userId', 'status', 'current_mode', 'phone', 'rating'],
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. SUBMIT CASH TOP-UP REQUEST
// POST /api/deliveries/driver/wallet/topup
//
// Cash channel only. Driver submits a reload request that goes into the
// backoffice queue for manual verification.
//
// Body (multipart/form-data  OR  application/json):
//   amount       {number}  required — XAF amount to reload
//   driver_note  {string}  optional — message to the reviewer
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

        const { amount, driver_note = null } = req.body;

        const { topUp, isDuplicate } = await walletTopUpService.submitTopUp(driver.id, {
            amount,
            payment_channel: 'cash',
            driver_note,
        });

        return res.status(isDuplicate ? 200 : 201).json({
            success: true,
            message: isDuplicate
                ? 'You already have a pending cash request for this amount.'
                : 'Top-up request submitted. A WeGo agent will verify your payment shortly.',
            data: formatTopUpForDriver(topUp),
        });

    } catch (error) {
        console.error('❌ [TOP-UP] submitTopUp error:', error.message);
        // Only surface messages we deliberately threw (they carry a statusCode).
        // Unexpected errors (DB, null refs) must NOT leak their raw text.
        return res.status(error.statusCode || 500).json({
            success: false,
            message: error.statusCode
                ? error.message
                : 'Something went wrong submitting your top-up. Please try again.',
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 2. INITIATE DIGITAL TOP-UP  (MTN MoMo / Orange Money via CamPay)
// POST /api/deliveries/driver/wallet/topup/initiate
//
// Triggers a CamPay USSD collection. No screenshot needed — CamPay confirms
// the payment automatically and the webhook credits the wallet.
//
// Body (application/json):
//   amount            {number}  required — XAF amount to reload
//   payment_channel   {string}  required — 'mtn_mobile_money' | 'orange_money'
//   phone             {string}  required — MoMo number to charge (9 digits or 237xxxxxxxxx)
//   driver_note       {string}  optional — personal note
//
// Flutter flow after this call:
//   1. Show "Check your phone" screen
//   2. Driver enters USSD PIN on their handset
//   3. CamPay fires webhook → wallet credited → socket event wallet:topped_up
//   4. App listens for wallet:topped_up and refreshes balance
//   5. Flutter may also poll GET /api/payments/:campayRef/status as fallback
// ═══════════════════════════════════════════════════════════════════════════════
exports.initiateDigitalTopUp = async (req, res) => {
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
            phone,
            driver_note = null,
        } = req.body;

        // ── Validate channel ──────────────────────────────────────────────────
        if (!['mtn_mobile_money', 'orange_money'].includes(payment_channel)) {
            return res.status(400).json({
                success: false,
                message: "payment_channel must be 'mtn_mobile_money' or 'orange_money' for this endpoint. Use /topup for cash.",
                code:    'INVALID_CHANNEL',
            });
        }

        if (!phone) {
            return res.status(400).json({
                success: false,
                message: 'phone is required for mobile money top-up.',
                code:    'MISSING_PHONE',
            });
        }

        if (!amount) {
            return res.status(400).json({
                success: false,
                message: 'amount is required.',
                code:    'MISSING_AMOUNT',
            });
        }

        // ── Initiate CamPay collection ────────────────────────────────────────
        const result = await walletTopUpService.initiateTopUpPayment(driver.id, {
            amount,
            payment_channel,
            phone,
            account_uuid: req.user.uuid,
            driver_note,
        });

        // ── Duplicate pending top-up — return the existing one ────────────────
        if (result.isDuplicate) {
            return res.status(200).json({
                success:    true,
                resumed:    true,
                message:    'A payment is already pending for this amount. Please check your phone.',
                campay_ref: result.campayRef,
                data:       formatTopUpForDriver(result.topUp),
            });
        }

        // ── New payment initiated ─────────────────────────────────────────────
        return res.status(201).json({
            success:     true,
            resumed:     false,
            message:     'Payment initiated. Please check your phone and enter your PIN.',
            // Flutter displays ussd_code as a prompt if CamPay returns it
            ussd_code:   result.ussdCode  || null,
            campay_ref:  result.campayRef || null,
            payment_id:  result.paymentId || null,
            data:        formatTopUpForDriver(result.topUp),
        });

    } catch (error) {
        console.error('❌ [TOP-UP] initiateDigitalTopUp error:', error.message);

        // ── Map CamPay error codes to clean responses ─────────────────────────
        if (error.campayCode) {
            const codeMap = {
                ER101: { status: 400, message: 'Invalid phone number. Please check and try again.' },
                ER102: { status: 400, message: 'This number is not supported. Use an MTN or Orange number.' },
                ER201: { status: 500, message: 'Internal payment error. Please try again.' },
                ER301: { status: 503, message: 'Payment service temporarily unavailable. Please try again shortly.' },
            };
            const mapped = codeMap[error.campayCode];
            if (mapped) {
                return res.status(mapped.status).json({
                    success: false,
                    message: mapped.message,
                    code:    error.campayCode,
                    // Include the topup record if it was created before CamPay failed,
                    // so Flutter can show the failed state rather than a blank error.
                    data: error.topUp ? formatTopUpForDriver(error.topUp) : null,
                });
            }
        }

        return res.status(error.statusCode || 500).json({
            success: false,
            message: error.statusCode
                ? error.message
                : 'Could not start the mobile money payment. Please try again.',
            code:    'TOPUP_INITIATION_FAILED',
            data:    error.topUp ? formatTopUpForDriver(error.topUp) : null,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 3. LIST MY TOP-UP REQUESTS
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
// 4. GET SINGLE TOP-UP DETAIL
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

        const topUp = await walletTopUpService.getTopUpById(topUpId, driver.id);

        return res.json({
            success: true,
            data:    formatTopUpForDriver(topUp),
        });

    } catch (error) {
        console.error('❌ [TOP-UP] getTopUpDetail error:', error.message);
        return res.status(error.statusCode || 500).json({
            success: false,
            message: error.statusCode
                ? error.message
                : 'Could not load this top-up. Please try again.',
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 5. GET WALLET BALANCE
// GET /api/deliveries/driver/wallet
//
// Returns the driver's current wallet with all balance fields.
// Called on every dashboard load to keep the balance display fresh.
// ═══════════════════════════════════════════════════════════════════════════════
exports.getWallet = async (req, res) => {
    try {
        const driver = await getDriverByAccountUuid(req.user.uuid);
        if (!driver) {
            return res.status(404).json({ success: false, message: 'Driver record not found.' });
        }

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
 * Surfaces the right message for each status so Flutter doesn't need
 * to implement its own status-to-message mapping.
 */
function formatTopUpForDriver(topUp) {
    // Status-specific fields only shown when relevant
    const rejectionReason = ['rejected', 'campay_failed'].includes(topUp.status)
        ? topUp.rejection_reason
        : null;

    // Human-readable status label for Flutter to display
    const statusLabel = {
        pending:        'Pending review',
        under_review:   'Under review',
        confirmed:      'Confirmed — being credited',
        credited:       'Credited to wallet',
        rejected:       'Rejected',
        campay_pending: 'Awaiting payment confirmation',
        campay_failed:  'Payment failed',
    }[topUp.status] || topUp.status;

    return {
        id:               topUp.id,
        topup_code:       topUp.topup_code,
        amount:           topUp.amount,
        payment_channel:  topUp.payment_channel,
        channel_label:    topUp.channelLabel,
        status:           topUp.status,
        status_label:     statusLabel,
        is_campay_flow:   topUp.isCampayFlow,
        // Proof only relevant for manual (cash) flow
        proof_url:        topUp.proof_url        || null,
        payment_reference: topUp.payment_reference || null,
        driver_note:      topUp.driver_note      || null,
        rejection_reason: rejectionReason,
        // Balance snapshot — only populated once credited
        balance_before_credit: topUp.balance_before_credit,
        balance_after_credit:  topUp.balance_after_credit,
        // Timeline
        submitted_at:  topUp.created_at,
        confirmed_at:  topUp.confirmed_at  || null,
        credited_at:   topUp.credited_at   || null,
        rejected_at:   topUp.rejected_at   || null,
    };
}