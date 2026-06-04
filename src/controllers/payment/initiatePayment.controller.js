// src/controllers/payment/initiatePayment.controller.js
//
// ═══════════════════════════════════════════════════════════════════════════════
// PAYMENT INITIATION CONTROLLER
// ═══════════════════════════════════════════════════════════════════════════════
//
// Three endpoints consumed by the Flutter app:
//
//   POST /api/payments/initiate
//     → Validates request, calls campayService.initiateCollection()
//     → Returns { paymentId, campayRef, ussdCode, status: 'PENDING' }
//     → Flutter shows "Check your phone" screen and listens for socket event
//
//   GET /api/payments/:campayRef/status
//     → Polls campayService.checkStatus() for apps that missed the socket event
//     → Also syncs WegoPayment record if CamPay reports a resolved status
//
//   GET /api/payments/history
//     → Returns paginated WegoPayment records for the authenticated user
//
// Security:
//   - All three routes require authenticate middleware (JWT)
//   - Amount is NEVER taken from the request — always resolved from DB in campayService
//   - One active PENDING payment per vertical record enforced here (guard below)
//
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const campayService              = require('../../services/campay/campayService');
const { VERTICALS }              = require('../../services/campay/campayService');
const { WegoPayment, sequelize } = require('../../models');
const { Op }                     = require('sequelize');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/initiate
// ─────────────────────────────────────────────────────────────────────────────

exports.initiate = async (req, res) => {
    try {
        const { vertical, vertical_id, phone } = req.body;
        const initiatedBy = req.user.uuid;

        // ── Input validation ──────────────────────────────────────────────────
        if (!vertical || !Object.values(VERTICALS).includes(vertical)) {
            return res.status(400).json({
                success: false,
                message: `Invalid vertical. Must be one of: ${Object.values(VERTICALS).join(', ')}`,
                code:    'INVALID_VERTICAL',
            });
        }

        if (!vertical_id) {
            return res.status(400).json({
                success: false,
                message: 'vertical_id is required.',
                code:    'MISSING_VERTICAL_ID',
            });
        }

        if (!phone) {
            return res.status(400).json({
                success: false,
                message: 'phone is required.',
                code:    'MISSING_PHONE',
            });
        }

        // ── Duplicate payment guard ───────────────────────────────────────────
        // Prevent double-charging if the Flutter app taps "Pay" twice or
        // retries while a previous attempt is still PENDING.
        const existingPending = await WegoPayment.findOne({
            where: {
                vertical,
                vertical_id: String(vertical_id),
                status:      'PENDING',
            },
        });

        if (existingPending) {
            // Return the existing pending payment so Flutter can resume
            // polling/waiting rather than starting a new charge.
            console.log(`ℹ️  [INITIATE] Returning existing PENDING payment for ${vertical} #${vertical_id}`);
            return res.status(200).json({
                success:     true,
                resumed:     true,  // Flutter can use this flag to show correct UI
                paymentId:   existingPending.id,
                campayRef:   existingPending.campay_ref,
                externalRef: existingPending.external_ref,
                status:      'PENDING',
                message:     'A payment is already pending for this item. Please check your phone.',
            });
        }

        // ── Initiate collection via campayService ─────────────────────────────
        const result = await campayService.initiateCollection({
            vertical,
            verticalId:  vertical_id,
            phone,
            initiatedBy,
        });

        return res.status(200).json({
            success:     true,
            resumed:     false,
            paymentId:   result.paymentId,
            campayRef:   result.campayRef,
            externalRef: result.externalRef,
            ussdCode:    result.ussdCode,   // e.g. "*126#" — show to customer
            operator:    result.operator,   // "MTN" or "ORANGE"
            status:      'PENDING',
            message:     'Payment initiated. Please check your phone and enter your PIN.',
        });

    } catch (err) {
        console.error('❌ [INITIATE] Error:', err.message);

        // ── Map CamPay error codes to clean HTTP responses ────────────────────
        if (err.campayCode) {
            const codeMap = {
                ER101: { status: 400, message: 'Invalid phone number. Please check and try again.' },
                ER102: { status: 400, message: 'This phone number is not supported. Only MTN and Orange numbers are accepted.' },
                ER201: { status: 500, message: 'Internal payment error. Please try again.' },
                ER301: { status: 503, message: 'Payment service temporarily unavailable. Please try again shortly.' },
            };
            const mapped = codeMap[err.campayCode];
            if (mapped) {
                return res.status(mapped.status).json({
                    success:   false,
                    message:   mapped.message,
                    code:      err.campayCode,
                });
            }
        }

        // ── Domain validation errors from campayService ───────────────────────
        // e.g. "Trip #42 is not in a payable state"
        if (err.message.includes('[CAMPAY SERVICE]')) {
            return res.status(400).json({
                success: false,
                message: err.message.replace('[CAMPAY SERVICE] ', ''),
                code:    'PAYMENT_NOT_ALLOWED',
            });
        }

        return res.status(500).json({
            success: false,
            message: 'Failed to initiate payment. Please try again.',
            code:    'PAYMENT_INITIATION_FAILED',
        });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payments/:campayRef/status
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payments/:campayRef/status
// ─────────────────────────────────────────────────────────────────────────────

exports.checkStatus = async (req, res) => {
    try {
        const { campayRef } = req.params;
        const userUuid      = req.user.uuid;

        if (!campayRef) {
            return res.status(400).json({
                success: false,
                message: 'campayRef is required.',
            });
        }

        // ── Load WegoPayment record ───────────────────────────────────────────
        const payment = await WegoPayment.findOne({
            where: { campay_ref: campayRef },
        });

        if (!payment) {
            return res.status(404).json({
                success: false,
                message: 'Payment record not found.',
                code:    'PAYMENT_NOT_FOUND',
            });
        }

        // ── Ownership check ───────────────────────────────────────────────────
        if (payment.initiated_by !== userUuid) {
            return res.status(403).json({
                success: false,
                message: 'You do not have permission to view this payment.',
                code:    'FORBIDDEN',
            });
        }

        // ── Already resolved — return from DB, no need to call CamPay ─────────
        if (payment.isResolved) {
            return res.status(200).json({
                success:    true,
                paymentId:  payment.id,
                campayRef:  payment.campay_ref,
                status:     payment.status,
                operator:   payment.operator,
                amount:     payment.amount,
                resolvedAt: payment.resolved_at,
            });
        }

        // ── Still PENDING — poll CamPay for latest status ─────────────────────
        const campayStatus = await campayService.checkStatus(campayRef);

        // ── If CamPay has resolved it, sync our record and run finalizer ──────
        if (campayStatus.status !== 'PENDING') {
            const newStatus = campayStatus.status === 'SUCCESSFUL' ? 'SUCCESSFUL' : 'FAILED';

            // Only update + finalize if not already resolved (race condition guard)
            const freshPayment = await WegoPayment.findOne({ where: { campay_ref: campayRef } });
            if (freshPayment && !freshPayment.isResolved) {

                await freshPayment.update({
                    status:      newStatus,
                    operator:    campayStatus.operator || freshPayment.operator,
                    resolved_at: new Date(),
                    ...(newStatus === 'FAILED' && {
                        failure_reason: 'Payment failed (detected via polling)',
                    }),
                });

                console.log(`🔄 [STATUS POLL] Payment ${campayRef} synced from CamPay: ${newStatus}`);

                // ── Run vertical finalizer (webhook may never arrive in sandbox) ──
                if (newStatus === 'SUCCESSFUL') {
                    const webhookCtrl = require('../payment/campayWebhook.controller');
                    if (webhookCtrl._finalizeFromPoll) {
                        webhookCtrl._finalizeFromPoll(
                            freshPayment,
                            { operator: campayStatus.operator || freshPayment.operator },
                            req.app.get('io')
                        ).catch(err => {
                            console.error('❌ [STATUS POLL] _finalizeFromPoll error:', err.message);
                        });
                    }
                }
            }
        }

        return res.status(200).json({
            success:           true,
            paymentId:         payment.id,
            campayRef:         payment.campay_ref,
            status:            campayStatus.status,
            operator:          campayStatus.operator          || null,
            operatorReference: campayStatus.operatorReference || null,
            amount:            payment.amount,
        });

    } catch (err) {
        console.error('❌ [STATUS] Error checking payment status:', err.message);
        return res.status(500).json({
            success: false,
            message: 'Failed to check payment status.',
        });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payments/history
// ─────────────────────────────────────────────────────────────────────────────

exports.getHistory = async (req, res) => {
    try {
        const userUuid = req.user.uuid;
        const page     = Math.max(1, parseInt(req.query.page)  || 1);
        const limit    = Math.min(50, parseInt(req.query.limit) || 20);
        const offset   = (page - 1) * limit;

        // Optional filters
        const { vertical, status } = req.query;

        const where = { initiated_by: userUuid };

        if (vertical && Object.values(VERTICALS).includes(vertical)) {
            where.vertical = vertical;
        }

        if (status && ['PENDING', 'SUCCESSFUL', 'FAILED', 'EXPIRED'].includes(status)) {
            where.status = status;
        }

        const { count, rows } = await WegoPayment.findAndCountAll({
            where,
            order:  [['initiated_at', 'DESC']],
            limit,
            offset,
            attributes: [
                'id', 'vertical', 'vertical_id', 'external_ref', 'campay_ref',
                'phone', 'operator', 'amount', 'currency', 'direction',
                'status', 'failure_reason', 'initiated_at', 'resolved_at',
            ],
        });

        return res.status(200).json({
            success: true,
            data:    rows,
            meta: {
                total:      count,
                page,
                limit,
                totalPages: Math.ceil(count / limit),
            },
        });

    } catch (err) {
        console.error('❌ [HISTORY] Error fetching payment history:', err.message);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch payment history.',
        });
    }
};