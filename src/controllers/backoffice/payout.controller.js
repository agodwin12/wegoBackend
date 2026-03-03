// src/controllers/backoffice/payout.controller.js
//
// ═══════════════════════════════════════════════════════════════════════
// PAYOUT CONTROLLER (Backoffice)
// ═══════════════════════════════════════════════════════════════════════
//
// FULL EMPLOYEE AUDIT TRAIL — every state change records:
//   - which employee performed the action
//   - timestamp of the action
//   - their notes/reason
//
// PayoutRequest audit fields:
//   initiatedByEmployeeId + createdAt   → who created it
//   processedBy + processedAt           → who started processing
//   confirmedBy + confirmedAt + paidAt  → who confirmed payment
//   rejectedBy  + rejectedAt            → who rejected
//   cancelledBy + cancelledAt           → who cancelled
//
// DebtPayment audit fields:
//   handledByEmployeeId + createdAt     → who created/received it
//   verifiedBy + verifiedAt             → who confirmed the driver paid
//   rejectedBy + rejectedAt             → who rejected
//
// DailyBalanceSheet audit fields:
//   closedBy + closedAt                 → who closed the sheet
//
// ═══════════════════════════════════════════════════════════════════════

'use strict';

const { Op }          = require('sequelize');
const { runForDate }  = require('../../services/balanceSheetCron');

const {
    PayoutRequest,
    DebtPayment,
    DailyBalanceSheet,
    Account,
    DriverProfile,
    DriverWallet,
    sequelize,
} = require('../../models');

// ── Shared attribute lists ─────────────────────────────────────────────
const ACCOUNT_ATTRS     = ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url', 'status'];
const DRIVER_PROF_ATTRS = ['account_id', 'rating_avg', 'vehicle_make_model', 'vehicle_plate', 'status'];

const CAMEROON_UTC_OFFSET_HOURS = 1;

// ── Reference number generators ────────────────────────────────────────
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
// ── OVERVIEW ───────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/payouts/overview
 */
exports.getOverview = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📊 [PAYOUT] getOverview');

        const today = _todayDateString();

        const [
            pendingPayouts,
            overduePayouts,
            processingPayouts,
            pendingDebts,
            overdueDebts,
            openSheets,
            todaySheets,
            blockedDrivers,
        ] = await Promise.all([
            PayoutRequest.count({ where: { status: 'PENDING' } }),
            PayoutRequest.count({
                where: {
                    status:      { [Op.in]: ['PENDING', 'PROCESSING'] },
                    slaDeadline: { [Op.lt]: new Date() },
                },
            }),
            PayoutRequest.count({ where: { status: 'PROCESSING' } }),
            DebtPayment.count({ where: { status: 'PENDING' } }),
            DebtPayment.count({
                where: {
                    status:    'PENDING',
                    createdAt: { [Op.lt]: new Date(Date.now() - 6 * 60 * 60 * 1000) },
                },
            }),
            DailyBalanceSheet.count({ where: { status: 'OPEN' } }),
            DailyBalanceSheet.findAll({
                where:      { sheetDate: today },
                attributes: ['cashCommissionOwed', 'digitalEarned', 'debtRemainingAmount', 'digitalPayoutRemaining'],
            }),
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

        console.log('✅ [PAYOUT] Overview loaded');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({
            success: true,
            data: {
                payouts:        { pending: pendingPayouts, overdue: overduePayouts, processing: processingPayouts },
                debts:          { pending: pendingDebts,  overdue: overdueDebts },
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
// ── PAYOUT REQUESTS ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/payouts/requests
 * Query: status, driverId, from, to, overdue, page, limit
 */
exports.listPayoutRequests = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📋 [PAYOUT] listPayoutRequests');

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

        console.log(`✅ [PAYOUT] ${count} payout requests found`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

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

/**
 * GET /api/admin/payouts/requests/:id
 */
exports.getPayoutRequest = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔍 [PAYOUT] getPayoutRequest:', req.params.id);

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

        if (!request) {
            return res.status(404).json({ success: false, message: 'Payout request not found.' });
        }

        console.log('✅ [PAYOUT] Request found:', request.referenceNumber);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({
            success: true,
            data:    { request: _formatPayoutRequest(request, true) },
        });

    } catch (error) {
        console.error('❌ [PAYOUT] getPayoutRequest error:', error);
        next(error);
    }
};

/**
 * POST /api/admin/payouts/requests
 * Backoffice creates a payout for a driver
 * Body: driverId, amount, paymentMethod, paymentPhone?, balanceSheetId?, accountantNotes?
 *
 * AUDIT: initiatedByEmployeeId = req.user.id
 */
exports.createPayoutRequest = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('➕ [PAYOUT] createPayoutRequest');
        console.log(`   👤 By employee: ${req.user.id} (${req.user.role})`);

        const { driverId, amount, paymentMethod, paymentPhone, balanceSheetId, accountantNotes } = req.body;

        if (!driverId) {
            return res.status(400).json({ success: false, message: 'driverId is required.' });
        }

        const parsedAmount = parseInt(amount, 10);
        if (isNaN(parsedAmount) || parsedAmount <= 0) {
            return res.status(400).json({ success: false, message: 'Amount must be a positive integer (XAF).' });
        }

        const validMethods = ['CASH', 'MOMO', 'OM'];
        if (!validMethods.includes(paymentMethod)) {
            return res.status(400).json({ success: false, message: `paymentMethod must be one of: ${validMethods.join(', ')}` });
        }

        if (['MOMO', 'OM'].includes(paymentMethod) && !paymentPhone) {
            return res.status(400).json({ success: false, message: 'paymentPhone is required for MOMO and OM payouts.' });
        }

        const driver = await Account.findOne({ where: { uuid: driverId, user_type: 'DRIVER' } });
        if (!driver) {
            return res.status(404).json({ success: false, message: 'Driver not found.' });
        }

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

        console.log(`✅ [PAYOUT] Created ${request.referenceNumber} — ${parsedAmount} XAF → driver ${driverId} | by employee ${req.user.id}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(201).json({
            success: true,
            message: 'Payout request created.',
            data:    { request: _formatPayoutRequest(request) },
        });

    } catch (error) {
        console.error('❌ [PAYOUT] createPayoutRequest error:', error);
        next(error);
    }
};

/**
 * PUT /api/admin/payouts/requests/:id/process
 * Mark as PROCESSING — accountant has started the transfer
 *
 * AUDIT: processedBy = req.user.id, processedAt = now
 */
exports.processPayoutRequest = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('⚙️  [PAYOUT] processPayoutRequest:', req.params.id);
        console.log(`   👤 By employee: ${req.user.id} (${req.user.role})`);

        const request = await PayoutRequest.findByPk(req.params.id);
        if (!request) {
            return res.status(404).json({ success: false, message: 'Payout request not found.' });
        }

        if (request.status !== 'PENDING') {
            return res.status(400).json({
                success: false,
                message: `Cannot process a request with status ${request.status}. Must be PENDING.`,
            });
        }

        request.status      = 'PROCESSING';
        request.processedBy = req.user.id;
        request.processedAt = new Date();
        if (req.body.accountantNotes) request.accountantNotes = req.body.accountantNotes;

        await request.save();

        console.log(`✅ [PAYOUT] ${request.referenceNumber} → PROCESSING | employee: ${req.user.id} at ${request.processedAt}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({
            success: true,
            message: 'Payout marked as processing.',
            data:    { request: _formatPayoutRequest(request) },
        });

    } catch (error) {
        console.error('❌ [PAYOUT] processPayoutRequest error:', error);
        next(error);
    }
};

/**
 * PUT /api/admin/payouts/requests/:id/confirm
 * Mark as PAID — accountant confirms transfer is done
 * Body: transactionRef (required for MOMO/OM), proofUrl?, accountantNotes?
 *
 * AUDIT: confirmedBy = req.user.id, confirmedAt = now
 */
exports.confirmPayoutRequest = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ [PAYOUT] confirmPayoutRequest:', req.params.id);
        console.log(`   👤 By employee: ${req.user.id} (${req.user.role})`);

        const request = await PayoutRequest.findByPk(req.params.id);
        if (!request) {
            return res.status(404).json({ success: false, message: 'Payout request not found.' });
        }

        if (!['PENDING', 'PROCESSING'].includes(request.status)) {
            return res.status(400).json({
                success: false,
                message: `Cannot confirm a request with status ${request.status}.`,
            });
        }

        const { transactionRef, proofUrl, accountantNotes } = req.body;

        if (!transactionRef && request.paymentMethod !== 'CASH') {
            return res.status(400).json({
                success: false,
                message: 'transactionRef is required for MOMO and OM payouts.',
            });
        }

        const now = new Date();

        request.status         = 'PAID';
        request.processedBy    = request.processedBy || req.user.id;
        request.processedAt    = request.processedAt || now;
        request.confirmedBy    = req.user.id;
        request.confirmedAt    = now;
        request.transactionRef = transactionRef || null;
        request.proofUrl       = proofUrl       || null;
        request.paidAt         = now;
        if (accountantNotes) request.accountantNotes = accountantNotes;

        await request.save();

        if (request.balanceSheetId) {
            const sheet = await DailyBalanceSheet.findByPk(request.balanceSheetId);
            if (sheet) {
                sheet.digitalPayoutAmount    = (sheet.digitalPayoutAmount    || 0) + request.amount;
                sheet.digitalPayoutRemaining = Math.max(0, (sheet.digitalPayoutRemaining || 0) - request.amount);
                await sheet.save();
            }
        }

        const wallet = await DriverWallet.findOne({ where: { driverId: request.driverId } });
        if (wallet) {
            wallet.balance      = Math.max(0, (wallet.balance      || 0) - request.amount);
            wallet.totalPayouts = (wallet.totalPayouts || 0) + request.amount;
            wallet.lastPayoutAt = now;
            await wallet.save();
        }

        console.log(`✅ [PAYOUT] ${request.referenceNumber} → PAID | confirmed by employee: ${req.user.id} at ${now} | ref: ${transactionRef}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({
            success: true,
            message: `Payout ${request.referenceNumber} confirmed as paid.`,
            data:    { request: _formatPayoutRequest(request) },
        });

    } catch (error) {
        console.error('❌ [PAYOUT] confirmPayoutRequest error:', error);
        next(error);
    }
};

/**
 * PUT /api/admin/payouts/requests/:id/reject
 * Body: rejectionReason (required)
 *
 * AUDIT: rejectedBy = req.user.id, rejectedAt = now
 */
exports.rejectPayoutRequest = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('❌ [PAYOUT] rejectPayoutRequest:', req.params.id);
        console.log(`   👤 By employee: ${req.user.id} (${req.user.role})`);

        const request = await PayoutRequest.findByPk(req.params.id);
        if (!request) {
            return res.status(404).json({ success: false, message: 'Payout request not found.' });
        }

        if (!['PENDING', 'PROCESSING'].includes(request.status)) {
            return res.status(400).json({
                success: false,
                message: `Cannot reject a request with status ${request.status}.`,
            });
        }

        const { rejectionReason, accountantNotes } = req.body;
        if (!rejectionReason?.trim()) {
            return res.status(400).json({ success: false, message: 'rejectionReason is required.' });
        }

        request.status          = 'REJECTED';
        request.rejectionReason = rejectionReason.trim();
        request.rejectedBy      = req.user.id;
        request.rejectedAt      = new Date();
        if (accountantNotes) request.accountantNotes = accountantNotes;

        await request.save();

        console.log(`✅ [PAYOUT] ${request.referenceNumber} → REJECTED | by employee: ${req.user.id} | reason: ${rejectionReason}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({
            success: true,
            message: 'Payout request rejected.',
            data:    { request: _formatPayoutRequest(request) },
        });

    } catch (error) {
        console.error('❌ [PAYOUT] rejectPayoutRequest error:', error);
        next(error);
    }
};

/**
 * PUT /api/admin/payouts/requests/:id/cancel
 *
 * AUDIT: cancelledBy = req.user.id, cancelledAt = now
 */
exports.cancelPayoutRequest = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🚫 [PAYOUT] cancelPayoutRequest:', req.params.id);
        console.log(`   👤 By employee: ${req.user.id} (${req.user.role})`);

        const request = await PayoutRequest.findByPk(req.params.id);
        if (!request) {
            return res.status(404).json({ success: false, message: 'Payout request not found.' });
        }

        if (!['PENDING', 'PROCESSING'].includes(request.status)) {
            return res.status(400).json({
                success: false,
                message: `Cannot cancel a request with status ${request.status}.`,
            });
        }

        request.status      = 'CANCELLED';
        request.cancelledBy = req.user.id;
        request.cancelledAt = new Date();
        if (req.body.accountantNotes) request.accountantNotes = req.body.accountantNotes;

        await request.save();

        console.log(`✅ [PAYOUT] ${request.referenceNumber} → CANCELLED | by employee: ${req.user.id}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({
            success: true,
            message: 'Payout request cancelled.',
            data:    { request: _formatPayoutRequest(request) },
        });

    } catch (error) {
        console.error('❌ [PAYOUT] cancelPayoutRequest error:', error);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// ── DEBT COLLECTION ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/payouts/debts
 * Query: status, driverId, from, to, page, limit
 */
exports.listDebtPayments = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📋 [PAYOUT] listDebtPayments');

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

        console.log(`✅ [PAYOUT] ${count} debt payments found`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

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

/**
 * GET /api/admin/payouts/debts/:id
 */
exports.getDebtPayment = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔍 [PAYOUT] getDebtPayment:', req.params.id);

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

        if (!payment) {
            return res.status(404).json({ success: false, message: 'Debt payment not found.' });
        }

        console.log('✅ [PAYOUT] Debt payment found:', payment.referenceNumber);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({
            success: true,
            data:    { payment: _formatDebtPayment(payment, true) },
        });

    } catch (error) {
        console.error('❌ [PAYOUT] getDebtPayment error:', error);
        next(error);
    }
};

/**
 * POST /api/admin/payouts/debts
 * Agent or accountant creates a debt payment record on behalf of driver
 *
 * AUDIT: handledByEmployeeId = req.user.id, submittedVia = BACKOFFICE or WHATSAPP_AGENT
 */
exports.createDebtPayment = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('➕ [PAYOUT] createDebtPayment');
        console.log(`   👤 By employee: ${req.user.id} (${req.user.role})`);

        const {
            driverId, amount, paymentMethod,
            driverTransactionRef, balanceSheetId,
            driverNote, accountantNotes, proofUrl,
            submittedVia,
        } = req.body;

        if (!driverId) {
            return res.status(400).json({ success: false, message: 'driverId is required.' });
        }

        const parsedAmount = parseInt(amount, 10);
        if (isNaN(parsedAmount) || parsedAmount <= 0) {
            return res.status(400).json({ success: false, message: 'Amount must be a positive integer (XAF).' });
        }

        const validMethods = ['CASH', 'MOMO', 'OM'];
        if (!validMethods.includes(paymentMethod)) {
            return res.status(400).json({ success: false, message: `paymentMethod must be one of: ${validMethods.join(', ')}` });
        }

        const driver = await Account.findOne({ where: { uuid: driverId, user_type: 'DRIVER' } });
        if (!driver) {
            return res.status(404).json({ success: false, message: 'Driver not found.' });
        }

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

        console.log(`✅ [PAYOUT] Debt payment created: ${payment.referenceNumber} — ${parsedAmount} XAF from driver ${driverId} | by employee ${req.user.id} via ${resolvedVia}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(201).json({
            success: true,
            message: 'Debt payment record created.',
            data:    { payment: _formatDebtPayment(payment) },
        });

    } catch (error) {
        console.error('❌ [PAYOUT] createDebtPayment error:', error);
        next(error);
    }
};

/**
 * PUT /api/admin/payouts/debts/:id/confirm
 * Accountant verifies proof and confirms driver paid
 * Body: wegoTransactionRef?, accountantNotes?
 *
 * AUDIT: verifiedBy = req.user.id, verifiedAt = now
 */
exports.confirmDebtPayment = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ [PAYOUT] confirmDebtPayment:', req.params.id);
        console.log(`   👤 By employee: ${req.user.id} (${req.user.role})`);

        const payment = await DebtPayment.findByPk(req.params.id);
        if (!payment) {
            return res.status(404).json({ success: false, message: 'Debt payment not found.' });
        }

        if (payment.status !== 'PENDING') {
            return res.status(400).json({
                success: false,
                message: `Cannot confirm a payment with status ${payment.status}.`,
            });
        }

        const { wegoTransactionRef, accountantNotes } = req.body;

        let sheet = null;
        if (payment.balanceSheetId) {
            sheet = await DailyBalanceSheet.findByPk(payment.balanceSheetId);
        } else {
            sheet = await DailyBalanceSheet.findOne({
                where: {
                    driverId:            payment.driverId,
                    status:              'OPEN',
                    debtRemainingAmount: { [Op.gt]: 0 },
                },
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
                    await Account.update(
                        { status: 'ACTIVE' },
                        { where: { uuid: payment.driverId } }
                    );
                    await DriverProfile.update(
                        { status: 'online' },
                        { where: { account_id: payment.driverId } }
                    );
                    payment.triggeredUnblock = true;
                    driverUnblocked = true;
                    console.log(`  🔓 Driver ${payment.driverId} UNBLOCKED — debt fully cleared`);
                }
            }

            await sheet.save();
        }

        await payment.save();

        console.log(`✅ [PAYOUT] Debt ${payment.referenceNumber} CONFIRMED | by employee: ${req.user.id} at ${now} | debt: ${debtBefore} → ${debtAfter} XAF${driverUnblocked ? ' | Driver UNBLOCKED' : ''}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({
            success: true,
            message: `Debt payment confirmed.${driverUnblocked ? ' Driver has been unblocked.' : ''}`,
            data: {
                payment:         _formatDebtPayment(payment),
                driverUnblocked,
                debtBefore,
                debtAfter,
            },
        });

    } catch (error) {
        console.error('❌ [PAYOUT] confirmDebtPayment error:', error);
        next(error);
    }
};

/**
 * PUT /api/admin/payouts/debts/:id/reject
 * Body: rejectionReason (required)
 *
 * AUDIT: rejectedBy = req.user.id, rejectedAt = now
 */
exports.rejectDebtPayment = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('❌ [PAYOUT] rejectDebtPayment:', req.params.id);
        console.log(`   👤 By employee: ${req.user.id} (${req.user.role})`);

        const payment = await DebtPayment.findByPk(req.params.id);
        if (!payment) {
            return res.status(404).json({ success: false, message: 'Debt payment not found.' });
        }

        if (payment.status !== 'PENDING') {
            return res.status(400).json({
                success: false,
                message: `Cannot reject a payment with status ${payment.status}.`,
            });
        }

        const { rejectionReason, accountantNotes } = req.body;
        if (!rejectionReason?.trim()) {
            return res.status(400).json({ success: false, message: 'rejectionReason is required.' });
        }

        payment.status          = 'REJECTED';
        payment.rejectionReason = rejectionReason.trim();
        payment.rejectedBy      = req.user.id;
        payment.rejectedAt      = new Date();
        if (accountantNotes) payment.accountantNotes = accountantNotes;

        await payment.save();

        console.log(`✅ [PAYOUT] Debt ${payment.referenceNumber} → REJECTED | by employee: ${req.user.id} | reason: ${rejectionReason}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({
            success: true,
            message: 'Debt payment rejected.',
            data:    { payment: _formatDebtPayment(payment) },
        });

    } catch (error) {
        console.error('❌ [PAYOUT] rejectDebtPayment error:', error);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// ── BALANCE SHEETS ─────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/payouts/balance-sheets
 * Query: driverId, date, from, to, status, page, limit
 */
exports.listBalanceSheets = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📋 [PAYOUT] listBalanceSheets');

        const page   = Math.max(parseInt(req.query.page  || '1',  10), 1);
        const limit  = Math.min(parseInt(req.query.limit || '20', 10), 100);
        const offset = (page - 1) * limit;
        const where  = {};

        if (req.query.driverId) where.driverId = req.query.driverId;
        if (req.query.status)   where.status    = req.query.status.toUpperCase();
        if (req.query.date)     where.sheetDate = req.query.date;

        if (req.query.from || req.query.to) {
            where.sheetDate = {};
            if (req.query.from) where.sheetDate[Op.gte] = req.query.from;
            if (req.query.to)   where.sheetDate[Op.lte] = req.query.to;
        }

        // Driver name/phone search
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
                required:   req.query.driver ? true : false,
                where:      req.query.driver ? driverWhere : undefined,
            }],
            order:   [['sheetDate', 'DESC'], ['createdAt', 'DESC']],
            limit,
            offset,
        });

        console.log(`✅ [PAYOUT] ${count} balance sheets found`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

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

/**
 * GET /api/admin/payouts/balance-sheets/:id
 */
exports.getBalanceSheet = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔍 [PAYOUT] getBalanceSheet:', req.params.id);

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

        if (!sheet) {
            return res.status(404).json({ success: false, message: 'Balance sheet not found.' });
        }

        const [payoutRequests, debtPayments] = await Promise.all([
            PayoutRequest.findAll({ where: { balanceSheetId: sheet.id }, order: [['createdAt', 'DESC']] }),
            DebtPayment.findAll({   where: { balanceSheetId: sheet.id }, order: [['createdAt', 'DESC']] }),
        ]);

        console.log('✅ [PAYOUT] Balance sheet loaded');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

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

/**
 * PUT /api/admin/payouts/balance-sheets/:id/close
 *
 * AUDIT: closedBy = req.user.id, closedAt = now
 */
exports.closeBalanceSheet = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔒 [PAYOUT] closeBalanceSheet:', req.params.id);
        console.log(`   👤 By employee: ${req.user.id} (${req.user.role})`);

        const sheet = await DailyBalanceSheet.findByPk(req.params.id);
        if (!sheet) {
            return res.status(404).json({ success: false, message: 'Balance sheet not found.' });
        }

        if (sheet.status === 'CLOSED') {
            return res.status(400).json({ success: false, message: 'Sheet is already closed.' });
        }

        sheet.status   = 'CLOSED';
        sheet.closedBy = req.user.id;
        sheet.closedAt = new Date();
        if (req.body.notes) sheet.notes = req.body.notes;

        await sheet.save();

        console.log(`✅ [PAYOUT] Sheet ${sheet.id} → CLOSED | by employee: ${req.user.id} at ${sheet.closedAt}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({
            success: true,
            message: 'Balance sheet closed.',
            data:    { sheet: _formatSheet(sheet) },
        });

    } catch (error) {
        console.error('❌ [PAYOUT] closeBalanceSheet error:', error);
        next(error);
    }
};

/**
 * POST /api/admin/payouts/balance-sheets/run
 * Manually trigger balance sheet generation for a date
 * Body: date (YYYY-MM-DD)
 * Access: super_admin only
 */
exports.runBalanceSheet = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('▶️  [PAYOUT] runBalanceSheet manual trigger');
        console.log(`   👤 By employee: ${req.user.id} (${req.user.role})`);

        const { date } = req.body;

        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({
                success: false,
                message: 'date is required in YYYY-MM-DD format.',
            });
        }

        runForDate(date).catch(err => {
            console.error(`❌ [PAYOUT] Manual balance sheet run error for ${date}:`, err);
        });

        console.log(`✅ [PAYOUT] Manual run started for ${date} | triggered by employee: ${req.user.id}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

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
// ── OFFICE SETTLEMENT ──────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

/**
 * POST /api/admin/payouts/settle
 * Atomic office settlement — clears all open balance sheets for a driver in one transaction.
 *
 * Body: driverId, paymentMethod, transactionRef? (required for MOMO/OM), notes?
 *
 * What it does:
 *   1. Creates a DebtPayment (CONFIRMED) for the total cash commission owed
 *   2. Creates a PayoutRequest (PAID) for the total digital earnings owed
 *   3. Marks all open balance sheets as CLOSED
 *   4. Updates DriverWallet
 *   5. Unblocks driver if SUSPENDED
 *
 * Access: super_admin, admin, manager, accountant
 */
exports.settleAtOffice = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🏢 [PAYOUT] settleAtOffice');
        console.log(`   👤 By employee: ${req.user.id} (${req.user.role})`);

        const { driverId, paymentMethod, transactionRef, notes } = req.body;

        // ── Validation ────────────────────────────────────────────────
        if (!driverId) {
            return res.status(400).json({ success: false, message: 'driverId is required.' });
        }

        const validMethods = ['CASH', 'MOMO', 'OM'];
        if (!validMethods.includes(paymentMethod)) {
            return res.status(400).json({
                success: false,
                message: `paymentMethod must be one of: ${validMethods.join(', ')}`,
            });
        }

        if (['MOMO', 'OM'].includes(paymentMethod) && !transactionRef?.trim()) {
            return res.status(400).json({
                success: false,
                message: 'transactionRef is required for MOMO and OM settlements.',
            });
        }

        // ── Fetch driver ──────────────────────────────────────────────
        const driver = await Account.findOne({ where: { uuid: driverId, user_type: 'DRIVER' } });
        if (!driver) {
            return res.status(404).json({ success: false, message: 'Driver not found.' });
        }

        // ── Fetch all OPEN balance sheets ─────────────────────────────
        const openSheets = await DailyBalanceSheet.findAll({
            where: { driverId, status: 'OPEN' },
            order: [['sheetDate', 'ASC']],
        });

        if (openSheets.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No open balance sheets found for this driver. Nothing to settle.',
            });
        }

        // ── Calculate totals ──────────────────────────────────────────
        const totalDebt    = openSheets.reduce((a, s) => a + (s.debtRemainingAmount    || 0), 0);
        const totalDigital = openSheets.reduce((a, s) => a + (s.digitalPayoutRemaining || 0), 0);
        const netAmount    = totalDigital - totalDebt;

        console.log(`   💰 Total debt (driver owes WEGO):     ${totalDebt} XAF`);
        console.log(`   💸 Total digital (WEGO owes driver):  ${totalDigital} XAF`);
        console.log(`   📊 Net position:                       ${netAmount} XAF`);

        const now = new Date();

        // ── Atomic transaction ────────────────────────────────────────
        const result = await sequelize.transaction(async (t) => {

            // 1. Create DebtPayment (CONFIRMED) — only if there's debt
            let debtPayment = null;
            if (totalDebt > 0) {
                const debtRef = _generateDebtRef();  // ✅ generate reference manually
                debtPayment = await DebtPayment.create({
                    referenceNumber:      debtRef,          // ✅ explicit reference
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

            // 2. Create PayoutRequest (PAID) — only if WEGO owes driver
            let payoutRequest = null;
            if (totalDigital > 0) {
                const payoutRef = _generatePayoutRef();  // ✅ generate reference manually
                payoutRequest = await PayoutRequest.create({
                    referenceNumber:       payoutRef,        // ✅ explicit reference
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

            // 3. Update all open balance sheets → CLOSED
            for (const sheet of openSheets) {
                const sheetDebt    = sheet.debtRemainingAmount    || 0;
                const sheetDigital = sheet.digitalPayoutRemaining || 0;

                sheet.debtPaidAmount         = (sheet.debtPaidAmount    || 0) + sheetDebt;
                sheet.debtRemainingAmount    = 0;
                sheet.consecutiveUnpaidDays  = 0;
                sheet.digitalPayoutAmount    = (sheet.digitalPayoutAmount || 0) + sheetDigital;
                sheet.digitalPayoutRemaining = 0;
                sheet.driverBlockedToday     = false;
                sheet.status                 = 'CLOSED';
                sheet.closedBy               = req.user.id;
                sheet.closedAt               = now;
                sheet.notes                  = notes || sheet.notes;

                await sheet.save({ transaction: t });
            }

            // 4. Update DriverWallet
            const wallet = await DriverWallet.findOne({ where: { driverId } });
            if (wallet) {
                wallet.balance      = Math.max(0, (wallet.balance || 0) - totalDigital);
                wallet.totalPayouts = (wallet.totalPayouts || 0) + (totalDigital > 0 ? totalDigital : 0);
                wallet.lastPayoutAt = now;
                await wallet.save({ transaction: t });
            }

            // 5. Unblock driver if SUSPENDED
            let driverUnblocked = false;
            if (driver.status === 'SUSPENDED') {
                await Account.update(
                    { status: 'ACTIVE' },
                    { where: { uuid: driverId }, transaction: t }
                );
                await DriverProfile.update(
                    { status: 'online' },
                    { where: { account_id: driverId }, transaction: t }
                );
                driverUnblocked = true;
                console.log(`   🔓 Driver ${driverId} UNBLOCKED — fully settled`);
            }

            return { debtPayment, payoutRequest, driverUnblocked };
        });

        console.log(`✅ [PAYOUT] Office settlement complete for driver ${driverId}`);
        console.log(`   DebtPayment:   ${result.debtPayment?.referenceNumber   ?? 'N/A (no debt)'}`);
        console.log(`   PayoutRequest: ${result.payoutRequest?.referenceNumber ?? 'N/A (no digital)'}`);
        console.log(`   Driver unblocked: ${result.driverUnblocked}`);
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
// ── PRIVATE FORMATTERS ─────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

function _formatPayoutRequest(r, detailed = false) {
    const base = {
        id:              r.id,
        referenceNumber: r.referenceNumber,
        amount:          r.amount,
        paymentMethod:   r.paymentMethod,
        paymentPhone:    r.paymentPhone,
        initiatedBy:     r.initiatedBy,
        status:          r.status,
        isOverdue:       r.isOverdue ? r.isOverdue() : false,
        slaDeadline:     r.slaDeadline,
        createdAt:       r.createdAt,
        paidAt:          r.paidAt,
        transactionRef:  r.transactionRef,
        proofUrl:        r.proofUrl,
        rejectionReason: r.rejectionReason,
        audit: {
            initiatedByEmployeeId: r.initiatedByEmployeeId || null,
            processedBy:           r.processedBy           || null,
            processedAt:           r.processedAt           || null,
            confirmedBy:           r.confirmedBy           || null,
            confirmedAt:           r.confirmedAt           || null,
            rejectedBy:            r.rejectedBy            || null,
            rejectedAt:            r.rejectedAt            || null,
            cancelledBy:           r.cancelledBy           || null,
            cancelledAt:           r.cancelledAt           || null,
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

    if (detailed) {
        base.driverNote      = r.driverNote;
        base.accountantNotes = r.accountantNotes;
    }

    return base;
}

function _formatDebtPayment(p, detailed = false) {
    const base = {
        id:                   p.id,
        referenceNumber:      p.referenceNumber,
        amount:               p.amount,
        paymentMethod:        p.paymentMethod,
        driverTransactionRef: p.driverTransactionRef,
        proofUrl:             p.proofUrl,
        submittedVia:         p.submittedVia,
        status:               p.status,
        isOverdue:            p.isOverdue ? p.isOverdue() : false,
        createdAt:            p.createdAt,
        triggeredUnblock:     p.triggeredUnblock,
        debtBeforePayment:    p.debtBeforePayment,
        debtAfterPayment:     p.debtAfterPayment,
        rejectionReason:      p.rejectionReason,
        audit: {
            handledByEmployeeId: p.handledByEmployeeId || null,
            verifiedBy:          p.verifiedBy          || null,
            verifiedAt:          p.verifiedAt          || null,
            rejectedBy:          p.rejectedBy          || null,
            rejectedAt:          p.rejectedAt          || null,
        },
    };

    if (p.driver) {
        base.driver = {
            uuid:   p.driver.uuid,
            name:   `${p.driver.first_name || ''} ${p.driver.last_name || ''}`.trim(),
            phone:  p.driver.phone_e164,
            photo:  p.driver.avatar_url,
            status: p.driver.status,
        };
    }

    if (detailed) {
        base.driverNote         = p.driverNote;
        base.accountantNotes    = p.accountantNotes;
        base.wegoTransactionRef = p.wegoTransactionRef;
    }

    return base;
}

function _formatSheet(s, detailed = false) {
    const base = {
        id:                     s.id,
        sheetDate:              s.sheetDate,
        status:                 s.status,
        cashTripsCount:         s.cashTripsCount,
        cashGrossFare:          s.cashGrossFare,
        cashCommissionOwed:     s.cashCommissionOwed,
        digitalTripsCount:      s.digitalTripsCount,
        digitalEarned:          s.digitalEarned,
        debtCarriedForward:     s.debtCarriedForward,
        totalDebt:              s.totalDebt,
        netPosition:            s.netPosition,
        debtPaidAmount:         s.debtPaidAmount,
        debtRemainingAmount:    s.debtRemainingAmount,
        digitalPayoutAmount:    s.digitalPayoutAmount,
        digitalPayoutRemaining: s.digitalPayoutRemaining,
        consecutiveUnpaidDays:  s.consecutiveUnpaidDays,
        driverBlockedToday:     s.driverBlockedToday,
        createdAt:              s.createdAt,
        audit: {
            closedBy: s.closedBy || null,
            closedAt: s.closedAt || null,
        },
    };

    if (s.driver) {
        base.driver = {
            uuid:   s.driver.uuid,
            name:   `${s.driver.first_name || ''} ${s.driver.last_name || ''}`.trim(),
            phone:  s.driver.phone_e164,
            photo:  s.driver.avatar_url,
            status: s.driver.status,
        };
    }

    if (detailed) {
        base.notes = s.notes;
    }

    return base;
}

function _todayDateString() {
    const now      = new Date();
    const cameroon = new Date(now.getTime() + CAMEROON_UTC_OFFSET_HOURS * 60 * 60 * 1000);
    return cameroon.toISOString().slice(0, 10);
}