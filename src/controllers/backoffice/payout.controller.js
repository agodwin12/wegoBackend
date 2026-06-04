// src/controllers/backoffice/payout.controller.js
//
// ═══════════════════════════════════════════════════════════════════════
// PAYOUT CONTROLLER (Backoffice)
// ═══════════════════════════════════════════════════════════════════════

'use strict';

const { Op }          = require('sequelize');
const { runForDate }  = require('../../services/balanceSheetCron');
const campayService   = require('../../services/campay/campayService');
const { DISBURSE_TYPES } = require('../../services/campay/campayService');

const {
    PayoutRequest,
    DebtPayment,
    DailyBalanceSheet,
    Account,
    DriverProfile,
    DriverWallet,
    sequelize,
} = require('../../models');

// ── Notification service (lazy — avoids circular dep at startup) ──────────────
const getNotificationService = () => require('../../services/NotificationService');

// ── Shared attribute lists ─────────────────────────────────────────────
const ACCOUNT_ATTRS     = ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url', 'status'];
const DRIVER_PROF_ATTRS = ['account_id', 'rating_avg', 'vehicle_make_model', 'vehicle_plate', 'status'];

const CAMEROON_UTC_OFFSET_HOURS = 1;

function _generateDebtRef() {
    const ts     = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substr(2, 5).toUpperCase();
    return `DBT-${ts}-${random}`;
}

function _generatePayoutRef() {
    const ts     = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substr(2, 5).toUpperCase();
    return `PAY-${ts}-${random}`;
}

// ═══════════════════════════════════════════════════════════════════════
// OVERVIEW
// ═══════════════════════════════════════════════════════════════════════

exports.getOverview = async (req, res, next) => {
    try {
        const today = _todayDateString();

        const [
            pendingPayouts, overduePayouts, processingPayouts,
            pendingDebts, overdueDebts, openSheets, todaySheets, blockedDrivers,
        ] = await Promise.all([
            PayoutRequest.count({ where: { status: 'PENDING' } }),
            PayoutRequest.count({ where: { status: { [Op.in]: ['PENDING', 'PROCESSING'] }, slaDeadline: { [Op.lt]: new Date() } } }),
            PayoutRequest.count({ where: { status: 'PROCESSING' } }),
            DebtPayment.count({ where: { status: 'PENDING' } }),
            DebtPayment.count({ where: { status: 'PENDING', createdAt: { [Op.lt]: new Date(Date.now() - 6 * 60 * 60 * 1000) } } }),
            DailyBalanceSheet.count({ where: { status: 'OPEN' } }),
            DailyBalanceSheet.findAll({ where: { sheetDate: today }, attributes: ['cashCommissionOwed', 'digitalEarned', 'debtRemainingAmount', 'digitalPayoutRemaining'] }),
            Account.count({ where: { user_type: 'DRIVER', status: 'SUSPENDED' } }),
        ]);

        const todayTotals = todaySheets.reduce(
            (acc, s) => ({
                cashCommissionOwed:     acc.cashCommissionOwed     + (s.cashCommissionOwed     || 0),
                digitalEarned:          acc.digitalEarned          + (s.digitalEarned          || 0),
                debtRemainingAmount:    acc.debtRemainingAmount    + (s.debtRemainingAmount    || 0),
                digitalPayoutRemaining: acc.digitalPayoutRemaining + (s.digitalPayoutRemaining || 0),
            }),
            { cashCommissionOwed: 0, digitalEarned: 0, debtRemainingAmount: 0, digitalPayoutRemaining: 0 }
        );

        return res.status(200).json({
            success: true,
            data: {
                payouts:        { pending: pendingPayouts, overdue: overduePayouts, processing: processingPayouts },
                debts:          { pending: pendingDebts,   overdue: overdueDebts },
                sheets:         { open: openSheets, today: todaySheets.length },
                blockedDrivers,
                today: {
                    date:               today,
                    totalCashCommOwed:  todayTotals.cashCommissionOwed,
                    totalDigitalEarned: todayTotals.digitalEarned,
                    totalDebtRemaining: todayTotals.debtRemainingAmount,
                    totalDigitalUnpaid: todayTotals.digitalPayoutRemaining,
                },
            },
        });

    } catch (error) {
        console.error('❌ [PAYOUT] getOverview error:', error);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// PAYOUT REQUESTS
// ═══════════════════════════════════════════════════════════════════════

exports.listPayoutRequests = async (req, res, next) => {
    try {
        const page   = Math.max(parseInt(req.query.page  || '1',  10), 1);
        const limit  = Math.min(parseInt(req.query.limit || '20', 10), 100);
        const offset = (page - 1) * limit;
        const where  = {};

        if (req.query.status)   where.status   = req.query.status.toUpperCase();
        if (req.query.driverId) where.driverId = req.query.driverId;

        if (req.query.from || req.query.to) {
            where.createdAt = {};
            if (req.query.from) where.createdAt[Op.gte] = new Date(req.query.from);
            if (req.query.to)   where.createdAt[Op.lte] = new Date(req.query.to);
        }

        if (req.query.overdue === 'true') {
            where.status      = { [Op.in]: ['PENDING', 'PROCESSING'] };
            where.slaDeadline = { [Op.lt]: new Date() };
        }

        const { count, rows } = await PayoutRequest.findAndCountAll({
            where,
            include: [{ model: Account, as: 'driver', attributes: ACCOUNT_ATTRS, required: false }],
            order:   [['createdAt', 'DESC']],
            limit,
            offset,
        });

        return res.status(200).json({
            success: true,
            data: {
                requests:   rows.map(r => _formatPayoutRequest(r)),
                pagination: { total: count, page, limit, totalPages: Math.ceil(count / limit) },
            },
        });

    } catch (error) {
        console.error('❌ [PAYOUT] listPayoutRequests error:', error);
        next(error);
    }
};

exports.getPayoutRequest = async (req, res, next) => {
    try {
        const request = await PayoutRequest.findByPk(req.params.id, {
            include: [
                {
                    model:      Account,
                    as:         'driver',
                    attributes: ACCOUNT_ATTRS,
                    include: [{ model: DriverProfile, as: 'driver_profile', attributes: DRIVER_PROF_ATTRS, required: false }],
                },
                { model: DailyBalanceSheet, as: 'balanceSheet', required: false },
            ],
        });

        if (!request) return res.status(404).json({ success: false, message: 'Payout request not found.' });

        return res.status(200).json({ success: true, data: { request: _formatPayoutRequest(request, true) } });

    } catch (error) {
        console.error('❌ [PAYOUT] getPayoutRequest error:', error);
        next(error);
    }
};

exports.createPayoutRequest = async (req, res, next) => {
    try {
        const { driverId, amount, paymentMethod, paymentPhone, balanceSheetId, accountantNotes } = req.body;

        if (!driverId) return res.status(400).json({ success: false, message: 'driverId is required.' });

        const parsedAmount = parseInt(amount, 10);
        if (isNaN(parsedAmount) || parsedAmount <= 0) return res.status(400).json({ success: false, message: 'Amount must be a positive integer (XAF).' });

        const validMethods = ['CASH', 'MOMO', 'OM'];
        if (!validMethods.includes(paymentMethod)) return res.status(400).json({ success: false, message: `paymentMethod must be one of: ${validMethods.join(', ')}` });

        if (['MOMO', 'OM'].includes(paymentMethod) && !paymentPhone) return res.status(400).json({ success: false, message: 'paymentPhone is required for MOMO and OM payouts.' });

        const driver = await Account.findOne({ where: { uuid: driverId, user_type: 'DRIVER' } });
        if (!driver) return res.status(404).json({ success: false, message: 'Driver not found.' });

        const request = await PayoutRequest.create({
            driverId,
            amount:                parsedAmount,
            paymentMethod,
            paymentPhone:          paymentPhone    || null,
            balanceSheetId:        balanceSheetId  || null,
            initiatedBy:           'BACKOFFICE',
            initiatedByEmployeeId: req.user.id,
            accountantNotes:       accountantNotes || null,
            status:                'PENDING',
        });

        return res.status(201).json({ success: true, message: 'Payout request created.', data: { request: _formatPayoutRequest(request) } });

    } catch (error) {
        console.error('❌ [PAYOUT] createPayoutRequest error:', error);
        next(error);
    }
};

exports.processPayoutRequest = async (req, res, next) => {
    try {
        const request = await PayoutRequest.findByPk(req.params.id);
        if (!request) return res.status(404).json({ success: false, message: 'Payout request not found.' });

        if (request.status !== 'PENDING') {
            return res.status(400).json({ success: false, message: `Cannot process a request with status ${request.status}. Must be PENDING.` });
        }

        request.status      = 'PROCESSING';
        request.processedBy = req.user.id;
        request.processedAt = new Date();
        if (req.body.accountantNotes) request.accountantNotes = req.body.accountantNotes;
        await request.save();

        return res.status(200).json({ success: true, message: 'Payout marked as processing.', data: { request: _formatPayoutRequest(request) } });

    } catch (error) {
        console.error('❌ [PAYOUT] processPayoutRequest error:', error);
        next(error);
    }
};

exports.confirmPayoutRequest = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ [PAYOUT] confirmPayoutRequest:', req.params.id);
        console.log(`   👤 By employee: ${req.user.id} (${req.user.role})`);

        const request = await PayoutRequest.findByPk(req.params.id, {
            include: [{ model: Account, as: 'driver', attributes: ['uuid', 'first_name', 'last_name'], required: false }],
        });
        if (!request) return res.status(404).json({ success: false, message: 'Payout request not found.' });

        if (!['PENDING', 'PROCESSING'].includes(request.status)) {
            return res.status(400).json({ success: false, message: `Cannot confirm a request with status ${request.status}.` });
        }

        const { transactionRef, proofUrl, accountantNotes } = req.body;
        const isDigital = ['MOMO', 'OM'].includes(request.paymentMethod);

        if (!isDigital && !transactionRef) {
            return res.status(400).json({ success: false, message: 'transactionRef is required for CASH payouts.' });
        }
        if (isDigital && !request.paymentPhone) {
            return res.status(400).json({ success: false, message: 'This payout request has no paymentPhone set.' });
        }

        const now = new Date();
        let campayRef = transactionRef || null;

        if (isDigital) {
            console.log(`💸 [PAYOUT] Initiating CamPay disbursement — ${request.amount} XAF → ${request.paymentPhone}`);
            try {
                const disburseResult = await campayService.initiateDisbursement({
                    disburseType: DISBURSE_TYPES.DRIVER_CASHOUT,
                    recipientId:  request.driverId,
                    amount:       request.amount,
                    phone:        request.paymentPhone,
                    approvedBy:   String(req.user.id),
                    payoutRef:    request.referenceNumber,
                });

                if (!disburseResult.success) {
                    // ── 🔔 NOTIFICATION: Withdrawal failed (CamPay rejected) ──
                    getNotificationService().send({
                        accountUuid: request.driverId,
                        type:        'WALLET_WITHDRAWAL_FAILED',
                        title:       'Withdrawal failed',
                        body:        `Your withdrawal of ${request.amount.toLocaleString()} XAF could not be processed. Please contact support.`,
                        data:        { screen: 'wallet', ref: request.referenceNumber },
                    }).catch(() => {});

                    return res.status(502).json({
                        success: false,
                        message: 'CamPay disbursement failed. Please retry or switch to cash payout.',
                        campayRef: disburseResult.campayRef || null,
                    });
                }

                campayRef = disburseResult.campayRef;
                console.log(`✅ [PAYOUT] CamPay disbursement successful — campayRef: ${campayRef}`);

            } catch (campayErr) {
                console.error(`❌ [PAYOUT] CamPay disbursement threw error:`, campayErr.message);

                // ── 🔔 NOTIFICATION: Withdrawal failed (exception) ────────────
                getNotificationService().send({
                    accountUuid: request.driverId,
                    type:        'WALLET_WITHDRAWAL_FAILED',
                    title:       'Withdrawal failed',
                    body:        `Your withdrawal of ${request.amount.toLocaleString()} XAF could not be processed. Please contact support.`,
                    data:        { screen: 'wallet', ref: request.referenceNumber },
                }).catch(() => {});

                return res.status(502).json({
                    success: false,
                    message: `CamPay disbursement error: ${campayErr.message}`,
                    code:    campayErr.campayCode || 'CAMPAY_ERROR',
                });
            }
        }

        request.status         = 'PAID';
        request.processedBy    = request.processedBy || req.user.id;
        request.processedAt    = request.processedAt || now;
        request.confirmedBy    = req.user.id;
        request.confirmedAt    = now;
        request.transactionRef = campayRef;
        request.proofUrl       = proofUrl || null;
        request.paidAt         = now;
        if (accountantNotes) request.accountantNotes = accountantNotes;
        await request.save();

        // ── Update balance sheet ──────────────────────────────────────────────
        if (request.balanceSheetId) {
            const sheet = await DailyBalanceSheet.findByPk(request.balanceSheetId);
            if (sheet) {
                sheet.digitalPayoutAmount    = (sheet.digitalPayoutAmount    || 0) + request.amount;
                sheet.digitalPayoutRemaining = Math.max(0, (sheet.digitalPayoutRemaining || 0) - request.amount);
                await sheet.save();
            }
        }

        // ── Update driver wallet ──────────────────────────────────────────────
        const wallet = await DriverWallet.findOne({ where: { driverId: request.driverId } });
        if (wallet) {
            wallet.balance      = Math.max(0, (wallet.balance || 0) - request.amount);
            wallet.totalPayouts = (wallet.totalPayouts || 0) + request.amount;
            wallet.lastPayoutAt = now;
            await wallet.save();
        }

        // ── 🔔 NOTIFICATION: Withdrawal completed ─────────────────────────────
        const driverName = request.driver
            ? `${request.driver.first_name || ''} ${request.driver.last_name || ''}`.trim()
            : '';
        getNotificationService().send({
            accountUuid: request.driverId,
            type:        'WALLET_WITHDRAWAL_COMPLETED',
            title:       '✅ Withdrawal successful!',
            body:        `${request.amount.toLocaleString()} XAF has been sent to your ${request.paymentMethod} account.`,
            data: {
                screen: 'wallet',
                amount: String(request.amount),
                method: request.paymentMethod,
                ref:    request.referenceNumber,
            },
        }).catch(e => console.warn('⚠️  [PAYOUT] Withdrawal completed push failed:', e.message));

        console.log(`✅ [PAYOUT] ${request.referenceNumber} → PAID | employee: ${req.user.id} | campayRef: ${campayRef || 'N/A (cash)'}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({
            success: true,
            message: `Payout ${request.referenceNumber} confirmed as paid.${isDigital ? ' Money sent via CamPay.' : ''}`,
            data:    { request: _formatPayoutRequest(request) },
        });

    } catch (error) {
        console.error('❌ [PAYOUT] confirmPayoutRequest error:', error);
        next(error);
    }
};

exports.rejectPayoutRequest = async (req, res, next) => {
    try {
        const request = await PayoutRequest.findByPk(req.params.id);
        if (!request) return res.status(404).json({ success: false, message: 'Payout request not found.' });

        if (!['PENDING', 'PROCESSING'].includes(request.status)) {
            return res.status(400).json({ success: false, message: `Cannot reject a request with status ${request.status}.` });
        }

        const { rejectionReason, accountantNotes } = req.body;
        if (!rejectionReason?.trim()) return res.status(400).json({ success: false, message: 'rejectionReason is required.' });

        request.status          = 'REJECTED';
        request.rejectionReason = rejectionReason.trim();
        request.rejectedBy      = req.user.id;
        request.rejectedAt      = new Date();
        if (accountantNotes) request.accountantNotes = accountantNotes;
        await request.save();

        // ── 🔔 NOTIFICATION: Withdrawal failed (rejected by backoffice) ───────
        getNotificationService().send({
            accountUuid: request.driverId,
            type:        'WALLET_WITHDRAWAL_FAILED',
            title:       'Withdrawal rejected',
            body:        `Your withdrawal of ${request.amount.toLocaleString()} XAF was rejected. Reason: ${rejectionReason.trim()}`,
            data: {
                screen: 'wallet',
                amount: String(request.amount),
                ref:    request.referenceNumber,
                reason: rejectionReason.trim(),
            },
        }).catch(e => console.warn('⚠️  [PAYOUT] Rejection push failed:', e.message));

        console.log(`✅ [PAYOUT] ${request.referenceNumber} → REJECTED | employee: ${req.user.id}`);

        return res.status(200).json({ success: true, message: 'Payout request rejected.', data: { request: _formatPayoutRequest(request) } });

    } catch (error) {
        console.error('❌ [PAYOUT] rejectPayoutRequest error:', error);
        next(error);
    }
};

exports.cancelPayoutRequest = async (req, res, next) => {
    try {
        const request = await PayoutRequest.findByPk(req.params.id);
        if (!request) return res.status(404).json({ success: false, message: 'Payout request not found.' });

        if (!['PENDING', 'PROCESSING'].includes(request.status)) {
            return res.status(400).json({ success: false, message: `Cannot cancel a request with status ${request.status}.` });
        }

        request.status      = 'CANCELLED';
        request.cancelledBy = req.user.id;
        request.cancelledAt = new Date();
        if (req.body.accountantNotes) request.accountantNotes = req.body.accountantNotes;
        await request.save();

        console.log(`✅ [PAYOUT] ${request.referenceNumber} → CANCELLED | employee: ${req.user.id}`);

        return res.status(200).json({ success: true, message: 'Payout request cancelled.', data: { request: _formatPayoutRequest(request) } });

    } catch (error) {
        console.error('❌ [PAYOUT] cancelPayoutRequest error:', error);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// DEBT COLLECTION
// ═══════════════════════════════════════════════════════════════════════

exports.listDebtPayments = async (req, res, next) => {
    try {
        const page   = Math.max(parseInt(req.query.page  || '1',  10), 1);
        const limit  = Math.min(parseInt(req.query.limit || '20', 10), 100);
        const offset = (page - 1) * limit;
        const where  = {};

        if (req.query.status)   where.status   = req.query.status.toUpperCase();
        if (req.query.driverId) where.driverId = req.query.driverId;

        if (req.query.from || req.query.to) {
            where.createdAt = {};
            if (req.query.from) where.createdAt[Op.gte] = new Date(req.query.from);
            if (req.query.to)   where.createdAt[Op.lte] = new Date(req.query.to);
        }

        const { count, rows } = await DebtPayment.findAndCountAll({
            where,
            include: [{ model: Account, as: 'driver', attributes: ACCOUNT_ATTRS, required: false }],
            order:   [['createdAt', 'DESC']],
            limit,
            offset,
        });

        return res.status(200).json({
            success: true,
            data: {
                payments:   rows.map(p => _formatDebtPayment(p)),
                pagination: { total: count, page, limit, totalPages: Math.ceil(count / limit) },
            },
        });

    } catch (error) {
        console.error('❌ [PAYOUT] listDebtPayments error:', error);
        next(error);
    }
};

exports.getDebtPayment = async (req, res, next) => {
    try {
        const payment = await DebtPayment.findByPk(req.params.id, {
            include: [
                {
                    model:      Account,
                    as:         'driver',
                    attributes: ACCOUNT_ATTRS,
                    include: [{ model: DriverProfile, as: 'driver_profile', attributes: DRIVER_PROF_ATTRS, required: false }],
                },
                { model: DailyBalanceSheet, as: 'balanceSheet', required: false },
            ],
        });

        if (!payment) return res.status(404).json({ success: false, message: 'Debt payment not found.' });

        return res.status(200).json({ success: true, data: { payment: _formatDebtPayment(payment, true) } });

    } catch (error) {
        console.error('❌ [PAYOUT] getDebtPayment error:', error);
        next(error);
    }
};

exports.createDebtPayment = async (req, res, next) => {
    try {
        const { driverId, amount, paymentMethod, driverTransactionRef, balanceSheetId, driverNote, accountantNotes, proofUrl, submittedVia } = req.body;

        if (!driverId) return res.status(400).json({ success: false, message: 'driverId is required.' });

        const parsedAmount = parseInt(amount, 10);
        if (isNaN(parsedAmount) || parsedAmount <= 0) return res.status(400).json({ success: false, message: 'Amount must be a positive integer (XAF).' });

        const validMethods = ['CASH', 'MOMO', 'OM'];
        if (!validMethods.includes(paymentMethod)) return res.status(400).json({ success: false, message: `paymentMethod must be one of: ${validMethods.join(', ')}` });

        const driver = await Account.findOne({ where: { uuid: driverId, user_type: 'DRIVER' } });
        if (!driver) return res.status(404).json({ success: false, message: 'Driver not found.' });

        const resolvedVia = (submittedVia === 'WHATSAPP_AGENT') ? 'WHATSAPP_AGENT' : 'BACKOFFICE';

        const payment = await DebtPayment.create({
            driverId,
            amount:               parsedAmount,
            paymentMethod,
            driverTransactionRef: driverTransactionRef || null,
            balanceSheetId:       balanceSheetId       || null,
            proofUrl:             proofUrl             || null,
            driverNote:           driverNote           || null,
            accountantNotes:      accountantNotes      || null,
            submittedVia:         resolvedVia,
            handledByEmployeeId:  req.user.id,
            status:               'PENDING',
        });

        return res.status(201).json({ success: true, message: 'Debt payment record created.', data: { payment: _formatDebtPayment(payment) } });

    } catch (error) {
        console.error('❌ [PAYOUT] createDebtPayment error:', error);
        next(error);
    }
};

exports.confirmDebtPayment = async (req, res, next) => {
    try {
        const payment = await DebtPayment.findByPk(req.params.id);
        if (!payment) return res.status(404).json({ success: false, message: 'Debt payment not found.' });

        if (payment.status !== 'PENDING') {
            return res.status(400).json({ success: false, message: `Cannot confirm a payment with status ${payment.status}.` });
        }

        const { wegoTransactionRef, accountantNotes } = req.body;

        let sheet = null;
        if (payment.balanceSheetId) {
            sheet = await DailyBalanceSheet.findByPk(payment.balanceSheetId);
        } else {
            sheet = await DailyBalanceSheet.findOne({
                where: { driverId: payment.driverId, status: 'OPEN', debtRemainingAmount: { [Op.gt]: 0 } },
                order: [['sheetDate', 'DESC']],
            });
        }

        const debtBefore = sheet ? (sheet.debtRemainingAmount || 0) : 0;
        const debtAfter  = Math.max(0, debtBefore - payment.amount);
        const now        = new Date();

        payment.status             = 'CONFIRMED';
        payment.verifiedBy         = req.user.id;
        payment.verifiedAt         = now;
        payment.wegoTransactionRef = wegoTransactionRef || null;
        payment.debtBeforePayment  = debtBefore;
        payment.debtAfterPayment   = debtAfter;
        if (accountantNotes) payment.accountantNotes = accountantNotes;

        let driverUnblocked = false;
        if (sheet) {
            sheet.debtPaidAmount      = (sheet.debtPaidAmount || 0) + payment.amount;
            sheet.debtRemainingAmount = debtAfter;

            if (debtAfter === 0) {
                sheet.consecutiveUnpaidDays = 0;
                const driver = await Account.findOne({ where: { uuid: payment.driverId } });
                if (driver && driver.status === 'SUSPENDED') {
                    await Account.update({ status: 'ACTIVE' }, { where: { uuid: payment.driverId } });
                    await DriverProfile.update({ status: 'online' }, { where: { account_id: payment.driverId } });
                    payment.triggeredUnblock = true;
                    driverUnblocked = true;
                }
            }
            await sheet.save();
        }

        await payment.save();

        return res.status(200).json({
            success: true,
            message: `Debt payment confirmed.${driverUnblocked ? ' Driver has been unblocked.' : ''}`,
            data:    { payment: _formatDebtPayment(payment), driverUnblocked, debtBefore, debtAfter },
        });

    } catch (error) {
        console.error('❌ [PAYOUT] confirmDebtPayment error:', error);
        next(error);
    }
};

exports.rejectDebtPayment = async (req, res, next) => {
    try {
        const payment = await DebtPayment.findByPk(req.params.id);
        if (!payment) return res.status(404).json({ success: false, message: 'Debt payment not found.' });

        if (payment.status !== 'PENDING') {
            return res.status(400).json({ success: false, message: `Cannot reject a payment with status ${payment.status}.` });
        }

        const { rejectionReason, accountantNotes } = req.body;
        if (!rejectionReason?.trim()) return res.status(400).json({ success: false, message: 'rejectionReason is required.' });

        payment.status          = 'REJECTED';
        payment.rejectionReason = rejectionReason.trim();
        payment.rejectedBy      = req.user.id;
        payment.rejectedAt      = new Date();
        if (accountantNotes) payment.accountantNotes = accountantNotes;
        await payment.save();

        return res.status(200).json({ success: true, message: 'Debt payment rejected.', data: { payment: _formatDebtPayment(payment) } });

    } catch (error) {
        console.error('❌ [PAYOUT] rejectDebtPayment error:', error);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// BALANCE SHEETS
// ═══════════════════════════════════════════════════════════════════════

exports.listBalanceSheets = async (req, res, next) => {
    try {
        const page   = Math.max(parseInt(req.query.page  || '1',  10), 1);
        const limit  = Math.min(parseInt(req.query.limit || '20', 10), 100);
        const offset = (page - 1) * limit;
        const where  = {};

        if (req.query.driverId) where.driverId  = req.query.driverId;
        if (req.query.status)   where.status    = req.query.status.toUpperCase();
        if (req.query.date)     where.sheetDate = req.query.date;

        if (req.query.from || req.query.to) {
            where.sheetDate = {};
            if (req.query.from) where.sheetDate[Op.gte] = req.query.from;
            if (req.query.to)   where.sheetDate[Op.lte] = req.query.to;
        }

        const driverWhere = {};
        if (req.query.driver) {
            driverWhere[Op.or] = [
                { first_name: { [Op.like]: `%${req.query.driver}%` } },
                { last_name:  { [Op.like]: `%${req.query.driver}%` } },
                { phone_e164: { [Op.like]: `%${req.query.driver}%` } },
            ];
        }

        const { count, rows } = await DailyBalanceSheet.findAndCountAll({
            where,
            include: [{
                model:      Account,
                as:         'driver',
                attributes: ACCOUNT_ATTRS,
                required:   req.query.driver ? true  : false,
                where:      req.query.driver ? driverWhere : undefined,
            }],
            order:   [['sheetDate', 'DESC'], ['createdAt', 'DESC']],
            limit,
            offset,
        });

        return res.status(200).json({
            success: true,
            data: {
                sheets:     rows.map(s => _formatSheet(s)),
                pagination: { total: count, page, limit, totalPages: Math.ceil(count / limit) },
            },
        });

    } catch (error) {
        console.error('❌ [PAYOUT] listBalanceSheets error:', error);
        next(error);
    }
};

exports.getBalanceSheet = async (req, res, next) => {
    try {
        const sheet = await DailyBalanceSheet.findByPk(req.params.id, {
            include: [
                {
                    model:      Account,
                    as:         'driver',
                    attributes: ACCOUNT_ATTRS,
                    include: [{ model: DriverProfile, as: 'driver_profile', attributes: DRIVER_PROF_ATTRS, required: false }],
                },
            ],
        });

        if (!sheet) return res.status(404).json({ success: false, message: 'Balance sheet not found.' });

        const [payoutRequests, debtPayments] = await Promise.all([
            PayoutRequest.findAll({ where: { balanceSheetId: sheet.id }, order: [['createdAt', 'DESC']] }),
            DebtPayment.findAll({   where: { balanceSheetId: sheet.id }, order: [['createdAt', 'DESC']] }),
        ]);

        return res.status(200).json({
            success: true,
            data: {
                sheet:          _formatSheet(sheet, true),
                payoutRequests: payoutRequests.map(r => _formatPayoutRequest(r, true)),
                debtPayments:   debtPayments.map(p => _formatDebtPayment(p, true)),
            },
        });

    } catch (error) {
        console.error('❌ [PAYOUT] getBalanceSheet error:', error);
        next(error);
    }
};

exports.closeBalanceSheet = async (req, res, next) => {
    try {
        const sheet = await DailyBalanceSheet.findByPk(req.params.id);
        if (!sheet) return res.status(404).json({ success: false, message: 'Balance sheet not found.' });

        if (sheet.status === 'CLOSED') return res.status(400).json({ success: false, message: 'Sheet is already closed.' });

        sheet.status   = 'CLOSED';
        sheet.closedBy = req.user.id;
        sheet.closedAt = new Date();
        if (req.body.notes) sheet.notes = req.body.notes;
        await sheet.save();

        return res.status(200).json({ success: true, message: 'Balance sheet closed.', data: { sheet: _formatSheet(sheet) } });

    } catch (error) {
        console.error('❌ [PAYOUT] closeBalanceSheet error:', error);
        next(error);
    }
};

exports.runBalanceSheet = async (req, res, next) => {
    try {
        const { date } = req.body;
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ success: false, message: 'date is required in YYYY-MM-DD format.' });
        }

        runForDate(date).catch(err => {
            console.error(`❌ [PAYOUT] Manual balance sheet run error for ${date}:`, err);
        });

        return res.status(202).json({
            success: true,
            message: `Balance sheet generation started for ${date}. Check server logs for progress.`,
        });

    } catch (error) {
        console.error('❌ [PAYOUT] runBalanceSheet error:', error);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// OFFICE SETTLEMENT
// ═══════════════════════════════════════════════════════════════════════

exports.settleAtOffice = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🏢 [PAYOUT] settleAtOffice');
        console.log(`   👤 By employee: ${req.user.id} (${req.user.role})`);

        const { driverId, paymentMethod, transactionRef, notes } = req.body;

        if (!driverId) return res.status(400).json({ success: false, message: 'driverId is required.' });

        const validMethods = ['CASH', 'MOMO', 'OM'];
        if (!validMethods.includes(paymentMethod)) {
            return res.status(400).json({ success: false, message: `paymentMethod must be one of: ${validMethods.join(', ')}` });
        }

        if (['MOMO', 'OM'].includes(paymentMethod) && !transactionRef?.trim()) {
            return res.status(400).json({ success: false, message: 'transactionRef is required for MOMO and OM settlements.' });
        }

        const driver = await Account.findOne({ where: { uuid: driverId, user_type: 'DRIVER' } });
        if (!driver) return res.status(404).json({ success: false, message: 'Driver not found.' });

        const openSheets = await DailyBalanceSheet.findAll({ where: { driverId, status: 'OPEN' }, order: [['sheetDate', 'ASC']] });

        if (openSheets.length === 0) {
            return res.status(400).json({ success: false, message: 'No open balance sheets found for this driver. Nothing to settle.' });
        }

        const totalDebt    = openSheets.reduce((a, s) => a + (s.debtRemainingAmount    || 0), 0);
        const totalDigital = openSheets.reduce((a, s) => a + (s.digitalPayoutRemaining || 0), 0);
        const netAmount    = totalDigital - totalDebt;

        const now = new Date();

        const result = await sequelize.transaction(async (t) => {
            let debtPayment = null;
            if (totalDebt > 0) {
                const debtRef = _generateDebtRef();
                debtPayment = await DebtPayment.create({
                    referenceNumber:      debtRef,
                    driverId,
                    amount:               totalDebt,
                    paymentMethod,
                    driverTransactionRef: transactionRef || null,
                    submittedVia:         'BACKOFFICE',
                    handledByEmployeeId:  req.user.id,
                    verifiedBy:           req.user.id,
                    verifiedAt:           now,
                    accountantNotes:      notes || null,
                    status:               'CONFIRMED',
                    debtBeforePayment:    totalDebt,
                    debtAfterPayment:     0,
                }, { transaction: t });
            }

            let payoutRequest = null;
            if (totalDigital > 0) {
                const payoutRef = _generatePayoutRef();
                payoutRequest = await PayoutRequest.create({
                    referenceNumber:       payoutRef,
                    driverId,
                    amount:                totalDigital,
                    paymentMethod,
                    paymentPhone:          null,
                    initiatedBy:           'BACKOFFICE',
                    initiatedByEmployeeId: req.user.id,
                    processedBy:           req.user.id,
                    processedAt:           now,
                    confirmedBy:           req.user.id,
                    confirmedAt:           now,
                    transactionRef:        transactionRef || null,
                    accountantNotes:       notes || null,
                    status:                'PAID',
                    paidAt:                now,
                }, { transaction: t });
            }

            for (const sheet of openSheets) {
                sheet.debtPaidAmount         = (sheet.debtPaidAmount || 0) + (sheet.debtRemainingAmount || 0);
                sheet.debtRemainingAmount    = 0;
                sheet.consecutiveUnpaidDays  = 0;
                sheet.digitalPayoutAmount    = (sheet.digitalPayoutAmount || 0) + (sheet.digitalPayoutRemaining || 0);
                sheet.digitalPayoutRemaining = 0;
                sheet.driverBlockedToday     = false;
                sheet.status                 = 'CLOSED';
                sheet.closedBy               = req.user.id;
                sheet.closedAt               = now;
                sheet.notes                  = notes || sheet.notes;
                await sheet.save({ transaction: t });
            }

            const wallet = await DriverWallet.findOne({ where: { driverId } });
            if (wallet) {
                wallet.balance      = Math.max(0, (wallet.balance || 0) - totalDigital);
                wallet.totalPayouts = (wallet.totalPayouts || 0) + (totalDigital > 0 ? totalDigital : 0);
                wallet.lastPayoutAt = now;
                await wallet.save({ transaction: t });
            }

            let driverUnblocked = false;
            if (driver.status === 'SUSPENDED') {
                await Account.update({ status: 'ACTIVE' }, { where: { uuid: driverId }, transaction: t });
                await DriverProfile.update({ status: 'online' }, { where: { account_id: driverId }, transaction: t });
                driverUnblocked = true;
            }

            return { debtPayment, payoutRequest, driverUnblocked };
        });

        // ── 🔔 NOTIFICATION: Withdrawal completed (office settlement) ─────────
        if (totalDigital > 0) {
            getNotificationService().send({
                accountUuid: driverId,
                type:        'WALLET_WITHDRAWAL_COMPLETED',
                title:       '✅ Withdrawal successful!',
                body:        `${totalDigital.toLocaleString()} XAF has been paid to you via ${paymentMethod}.`,
                data: {
                    screen: 'wallet',
                    amount: String(totalDigital),
                    method: paymentMethod,
                    ref:    result.payoutRequest?.referenceNumber || '',
                },
            }).catch(e => console.warn('⚠️  [PAYOUT] Settlement push failed:', e.message));
        }

        console.log(`✅ [PAYOUT] Office settlement complete for driver ${driverId}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({
            success: true,
            message: `Settlement complete.${result.driverUnblocked ? ' Driver has been unblocked.' : ''}`,
            data: {
                totalDebt,
                totalDigital,
                netAmount,
                sheetsSettled:   openSheets.length,
                driverUnblocked: result.driverUnblocked,
                debtPayment:     result.debtPayment   ? _formatDebtPayment(result.debtPayment)     : null,
                payoutRequest:   result.payoutRequest ? _formatPayoutRequest(result.payoutRequest) : null,
            },
        });

    } catch (error) {
        console.error('❌ [PAYOUT] settleAtOffice error:', error);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// PRIVATE FORMATTERS
// ═══════════════════════════════════════════════════════════════════════

function _formatPayoutRequest(r, detailed = false) {
    const base = {
        id: r.id, referenceNumber: r.referenceNumber, amount: r.amount,
        paymentMethod: r.paymentMethod, paymentPhone: r.paymentPhone,
        initiatedBy: r.initiatedBy, status: r.status,
        isOverdue: r.isOverdue ? r.isOverdue() : false,
        slaDeadline: r.slaDeadline, createdAt: r.createdAt, paidAt: r.paidAt,
        transactionRef: r.transactionRef, proofUrl: r.proofUrl,
        rejectionReason: r.rejectionReason,
        audit: {
            initiatedByEmployeeId: r.initiatedByEmployeeId || null,
            processedBy: r.processedBy || null, processedAt: r.processedAt || null,
            confirmedBy: r.confirmedBy || null, confirmedAt: r.confirmedAt || null,
            rejectedBy:  r.rejectedBy  || null, rejectedAt:  r.rejectedAt  || null,
            cancelledBy: r.cancelledBy || null, cancelledAt: r.cancelledAt || null,
        },
    };

    if (r.driver) {
        base.driver = {
            uuid:   r.driver.uuid,
            name:   `${r.driver.first_name || ''} ${r.driver.last_name || ''}`.trim(),
            phone:  r.driver.phone_e164,
            photo:  r.driver.avatar_url,
            status: r.driver.status,
        };
    }

    if (detailed) { base.driverNote = r.driverNote; base.accountantNotes = r.accountantNotes; }
    return base;
}

function _formatDebtPayment(p, detailed = false) {
    const base = {
        id: p.id, referenceNumber: p.referenceNumber, amount: p.amount,
        paymentMethod: p.paymentMethod, driverTransactionRef: p.driverTransactionRef,
        proofUrl: p.proofUrl, submittedVia: p.submittedVia, status: p.status,
        isOverdue: p.isOverdue ? p.isOverdue() : false, createdAt: p.createdAt,
        triggeredUnblock: p.triggeredUnblock, debtBeforePayment: p.debtBeforePayment,
        debtAfterPayment: p.debtAfterPayment, rejectionReason: p.rejectionReason,
        audit: {
            handledByEmployeeId: p.handledByEmployeeId || null,
            verifiedBy: p.verifiedBy || null, verifiedAt: p.verifiedAt || null,
            rejectedBy: p.rejectedBy || null, rejectedAt: p.rejectedAt || null,
        },
    };

    if (p.driver) {
        base.driver = {
            uuid: p.driver.uuid,
            name: `${p.driver.first_name || ''} ${p.driver.last_name || ''}`.trim(),
            phone: p.driver.phone_e164, photo: p.driver.avatar_url, status: p.driver.status,
        };
    }

    if (detailed) { base.driverNote = p.driverNote; base.accountantNotes = p.accountantNotes; base.wegoTransactionRef = p.wegoTransactionRef; }
    return base;
}

function _formatSheet(s, detailed = false) {
    const base = {
        id: s.id, sheetDate: s.sheetDate, status: s.status,
        cashTripsCount: s.cashTripsCount, cashGrossFare: s.cashGrossFare,
        cashCommissionOwed: s.cashCommissionOwed, digitalTripsCount: s.digitalTripsCount,
        digitalEarned: s.digitalEarned, debtCarriedForward: s.debtCarriedForward,
        totalDebt: s.totalDebt, netPosition: s.netPosition,
        debtPaidAmount: s.debtPaidAmount, debtRemainingAmount: s.debtRemainingAmount,
        digitalPayoutAmount: s.digitalPayoutAmount, digitalPayoutRemaining: s.digitalPayoutRemaining,
        consecutiveUnpaidDays: s.consecutiveUnpaidDays, driverBlockedToday: s.driverBlockedToday,
        createdAt: s.createdAt, audit: { closedBy: s.closedBy || null, closedAt: s.closedAt || null },
    };

    if (s.driver) {
        base.driver = {
            uuid: s.driver.uuid,
            name: `${s.driver.first_name || ''} ${s.driver.last_name || ''}`.trim(),
            phone: s.driver.phone_e164, photo: s.driver.avatar_url, status: s.driver.status,
        };
    }

    if (detailed) base.notes = s.notes;
    return base;
}

function _todayDateString() {
    const now      = new Date();
    const cameroon = new Date(now.getTime() + CAMEROON_UTC_OFFSET_HOURS * 60 * 60 * 1000);
    return cameroon.toISOString().slice(0, 10);
}