// src/controllers/driverPayout.controller.js
//
// ═══════════════════════════════════════════════════════════════════════
// DRIVER PAYOUT CONTROLLER (Mobile)
// ═══════════════════════════════════════════════════════════════════════

'use strict';

const { Op } = require('sequelize');

const {
    PayoutRequest,
    Account,
    DriverWallet,
} = require('../models');

// ── Notification service (lazy — avoids circular dep at startup) ──────────────
const getNotificationService = () => require('../services/NotificationService');

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

function _generatePayoutRef() {
    const ts     = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substr(2, 5).toUpperCase();
    return `PAY-${ts}-${random}`;
}

function _formatRequest(r) {
    return {
        id:              r.id,
        referenceNumber: r.referenceNumber,
        amount:          r.amount,
        paymentMethod:   r.paymentMethod,
        paymentPhone:    r.paymentPhone,
        status:          r.status,
        initiatedBy:     r.initiatedBy,
        transactionRef:  r.transactionRef,
        proofUrl:        r.proofUrl,
        rejectionReason: r.rejectionReason,
        slaDeadline:     r.slaDeadline,
        paidAt:          r.paidAt,
        createdAt:       r.createdAt,
        updatedAt:       r.updatedAt,
    };
}

// ═══════════════════════════════════════════════════════════════════════
// POST /api/request/payout/driver — Submit a new payout request
// ═══════════════════════════════════════════════════════════════════════

exports.requestPayout = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('💸 [DRIVER PAYOUT] requestPayout');
        console.log(`   👤 Driver: ${req.user.uuid}`);

        const { amount, paymentMethod, note } = req.body;

        const parsedAmount = parseInt(amount, 10);
        if (isNaN(parsedAmount) || parsedAmount <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Amount must be a positive number.',
            });
        }

        const validMethods = ['CASH', 'MOMO', 'OM'];
        if (!validMethods.includes(paymentMethod)) {
            return res.status(400).json({
                success: false,
                message: `paymentMethod must be one of: ${validMethods.join(', ')}`,
            });
        }

        const driver = await Account.findOne({
            where: { uuid: req.user.uuid, user_type: 'DRIVER' },
        });
        if (!driver) {
            return res.status(404).json({ success: false, message: 'Driver account not found.' });
        }

        const wallet           = await DriverWallet.findOne({ where: { driverId: driver.uuid } });
        const availableBalance = wallet ? (wallet.balance || 0) : 0;

        console.log(`   💰 Requested: ${parsedAmount} XAF | Available: ${availableBalance} XAF`);

        if (parsedAmount > availableBalance) {
            return res.status(400).json({
                success: false,
                message: `Insufficient balance. You requested ${parsedAmount} XAF but your available balance is ${availableBalance} XAF.`,
                data:    { requested: parsedAmount, available: availableBalance },
            });
        }

        const paymentPhone = ['MOMO', 'OM'].includes(paymentMethod)
            ? (driver.phone_e164 || null)
            : null;

        if (['MOMO', 'OM'].includes(paymentMethod) && !paymentPhone) {
            return res.status(400).json({
                success: false,
                message: 'No phone number found on your profile. Please update your profile before requesting a mobile payout.',
            });
        }

        const referenceNumber = _generatePayoutRef();
        const slaDeadline     = new Date(Date.now() + 48 * 60 * 60 * 1000);

        const request = await PayoutRequest.create({
            referenceNumber,
            driverId:      driver.uuid,
            amount:        parsedAmount,
            paymentMethod,
            paymentPhone,
            initiatedBy:   'DRIVER',
            driverNote:    note || null,
            status:        'PENDING',
            slaDeadline,
        });

        console.log(`✅ [DRIVER PAYOUT] Request created: ${referenceNumber} | ${parsedAmount} XAF via ${paymentMethod}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        // ── 🔔 NOTIFICATION: Withdrawal requested ────────────────────────────
        getNotificationService().send({
            accountUuid: driver.uuid,
            type:        'WALLET_WITHDRAWAL_REQUESTED',
            title:       'Withdrawal requested',
            body:        `Your withdrawal of ${parsedAmount.toLocaleString()} XAF via ${paymentMethod} has been submitted. We'll process it within 48 hours.`,
            data: {
                screen:    'wallet',
                amount:    String(parsedAmount),
                ref:       referenceNumber,
                method:    paymentMethod,
            },
        }).catch(e => console.warn('⚠️  [DRIVER PAYOUT] Withdrawal requested push failed:', e.message));

        return res.status(201).json({
            success: true,
            message: 'Payout request submitted successfully. It will be processed by our team.',
            data: {
                request:          _formatRequest(request),
                availableBalance: availableBalance - parsedAmount,
            },
        });

    } catch (error) {
        console.error('❌ [DRIVER PAYOUT] requestPayout error:', error);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET /api/request/payout/driver — List driver's own payout history
// ═══════════════════════════════════════════════════════════════════════

exports.listMyPayouts = async (req, res, next) => {
    try {
        const page   = Math.max(parseInt(req.query.page  || '1',  10), 1);
        const limit  = Math.min(parseInt(req.query.limit || '20', 10), 50);
        const offset = (page - 1) * limit;
        const where  = { driverId: req.user.uuid };

        if (req.query.status) where.status = req.query.status.toUpperCase();

        const { count, rows } = await PayoutRequest.findAndCountAll({
            where,
            order:  [['createdAt', 'DESC']],
            limit,
            offset,
        });

        const wallet           = await DriverWallet.findOne({ where: { driverId: req.user.uuid } });
        const availableBalance = wallet ? (wallet.balance || 0) : 0;

        return res.status(200).json({
            success: true,
            data: {
                requests:         rows.map(r => _formatRequest(r)),
                availableBalance,
                pagination: {
                    total:      count,
                    page,
                    limit,
                    totalPages: Math.ceil(count / limit),
                },
            },
        });

    } catch (error) {
        console.error('❌ [DRIVER PAYOUT] listMyPayouts error:', error);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET /api/request/payout/driver/:id — Single payout request detail
// ═══════════════════════════════════════════════════════════════════════

exports.getMyPayout = async (req, res, next) => {
    try {
        const request = await PayoutRequest.findOne({
            where: { id: req.params.id, driverId: req.user.uuid },
        });

        if (!request) {
            return res.status(404).json({ success: false, message: 'Payout request not found.' });
        }

        return res.status(200).json({
            success: true,
            data:    { request: _formatRequest(request) },
        });

    } catch (error) {
        console.error('❌ [DRIVER PAYOUT] getMyPayout error:', error);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// DELETE /api/request/payout/driver/:id — Cancel a PENDING payout request
// ═══════════════════════════════════════════════════════════════════════

exports.cancelMyPayout = async (req, res, next) => {
    try {
        const request = await PayoutRequest.findOne({
            where: { id: req.params.id, driverId: req.user.uuid },
        });

        if (!request) {
            return res.status(404).json({ success: false, message: 'Payout request not found.' });
        }

        if (request.status !== 'PENDING') {
            return res.status(400).json({
                success: false,
                message: `This request cannot be cancelled. Current status: ${request.status}.`,
            });
        }

        request.status      = 'CANCELLED';
        request.cancelledAt = new Date();
        await request.save();

        console.log(`✅ [DRIVER PAYOUT] ${request.referenceNumber} → CANCELLED by driver`);

        return res.status(200).json({
            success: true,
            message: 'Payout request cancelled.',
            data:    { request: _formatRequest(request) },
        });

    } catch (error) {
        console.error('❌ [DRIVER PAYOUT] cancelMyPayout error:', error);
        next(error);
    }
};