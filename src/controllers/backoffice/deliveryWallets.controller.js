// src/controllers/backoffice/deliveryWallets.controller.js

const { Op, fn, col, literal } = require('sequelize');
const {
    DeliveryWallet,
    DeliveryWalletTransaction,
    Driver,
    Account,
    sequelize,
} = require('../../models');
const deliveryEarningsService = require('../../services/deliveryEarningsService');
const ExcelJS = require('exceljs');

// ═══════════════════════════════════════════════════════════════════════════════
// GET ALL WALLETS
// GET /api/backoffice/delivery/wallets
// ═══════════════════════════════════════════════════════════════════════════════
exports.getWallets = async (req, res) => {
    try {
        const {
            page   = 1,
            limit  = 20,
            search = '',
            status = '',
        } = req.query;

        const offset = (parseInt(page) - 1) * parseInt(limit);

        const walletWhere = {};
        if (status) walletWhere.status = status;

        const { count, rows: wallets } = await DeliveryWallet.findAndCountAll({
            where: walletWhere,
            include: [
                {
                    association: 'driver',
                    attributes:  ['id', 'userId', 'status', 'current_mode', 'vehicle_make_model', 'rating'],
                    include: [
                        {
                            model:      Account,
                            as:         'account',
                            attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url', 'user_type'],
                            ...(search && {
                                where: {
                                    [Op.or]: [
                                        { first_name: { [Op.like]: `%${search}%` } },
                                        { last_name:  { [Op.like]: `%${search}%` } },
                                        { phone_e164: { [Op.like]: `%${search}%` } },
                                    ],
                                },
                            }),
                            required: !!search,
                        },
                    ],
                    required: true,
                },
            ],
            order:    [['balance', 'DESC']],
            limit:    parseInt(limit),
            offset,
            distinct: true,
        });

        // Summary totals
        const [totalBalance, totalEarned, totalCashCollected, totalCommissionOwed, totalWithdrawn] = await Promise.all([
            DeliveryWallet.sum('balance'),
            DeliveryWallet.sum('total_earned'),
            DeliveryWallet.sum('total_cash_collected'),
            DeliveryWallet.sum('total_commission_owed'),
            DeliveryWallet.sum('total_withdrawn'),
        ]);

        const formatted = wallets.map(w => ({
            id:                    w.id,
            driverId:              w.driver_id,
            balance:               w.balance,
            availableBalance:      w.balance - w.pending_withdrawal,
            totalEarned:           w.total_earned,
            totalCashCollected:    w.total_cash_collected,
            totalCommissionOwed:   w.total_commission_owed,
            totalCommissionPaid:   w.total_commission_paid,
            outstandingCommission: parseFloat(w.total_commission_owed) - parseFloat(w.total_commission_paid),
            totalWithdrawn:        w.total_withdrawn,
            pendingWithdrawal:     w.pending_withdrawal,
            status:                w.status,
            frozenReason:          w.frozen_reason,
            driver: {
                id:               w.driver?.id,
                onlineStatus:     w.driver?.status,
                currentMode:      w.driver?.current_mode,
                vehicleMakeModel: w.driver?.vehicle_make_model,
                rating:           w.driver?.rating,
                account: {
                    firstName: w.driver?.account?.first_name,
                    lastName:  w.driver?.account?.last_name,
                    phone:     w.driver?.account?.phone_e164,
                    avatar:    w.driver?.account?.avatar_url,
                    userType:  w.driver?.account?.user_type,
                },
            },
        }));

        return res.json({
            success: true,
            wallets: formatted,
            summary: {
                totalBalance:          totalBalance          || 0,
                totalEarned:           totalEarned           || 0,
                totalCashCollected:    totalCashCollected    || 0,
                totalCommissionOwed:   totalCommissionOwed   || 0,
                totalWithdrawn:        totalWithdrawn        || 0,
                walletCount:           count,
            },
            pagination: {
                total:      count,
                page:       parseInt(page),
                limit:      parseInt(limit),
                totalPages: Math.ceil(count / parseInt(limit)),
            },
        });

    } catch (error) {
        console.error('❌ [WALLETS] getWallets error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch wallets' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET SINGLE WALLET WITH TRANSACTIONS
// GET /api/backoffice/delivery/wallets/:walletId
// ═══════════════════════════════════════════════════════════════════════════════
exports.getWallet = async (req, res) => {
    try {
        const { walletId } = req.params;
        const page  = parseInt(req.query.page  || 1);
        const limit = parseInt(req.query.limit || 15);

        const wallet = await DeliveryWallet.findByPk(walletId, {
            include: [
                {
                    association: 'driver',
                    include: [{ model: Account, as: 'account' }],
                },
            ],
        });

        if (!wallet) {
            return res.status(404).json({ success: false, message: 'Wallet not found' });
        }

        const { count, rows: transactions } = await DeliveryWalletTransaction.findAndCountAll({
            where:  { wallet_id: walletId },
            order:  [['created_at', 'DESC']],
            limit,
            offset: (page - 1) * limit,
        });

        return res.json({
            success: true,
            wallet: {
                ...wallet.toJSON(),
                availableBalance:      wallet.balance - wallet.pending_withdrawal,
                outstandingCommission: parseFloat(wallet.total_commission_owed) - parseFloat(wallet.total_commission_paid),
            },
            transactions,
            pagination: {
                total:      count,
                page,
                limit,
                totalPages: Math.ceil(count / limit),
            },
        });

    } catch (error) {
        console.error('❌ [WALLETS] getWallet error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch wallet' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// MANUAL ADJUSTMENT (credit or debit)
// POST /api/backoffice/delivery/wallets/:walletId/adjust
// ═══════════════════════════════════════════════════════════════════════════════
exports.adjustWallet = async (req, res) => {
    try {
        const { walletId } = req.params;
        const { type, amount, notes } = req.body;

        if (!['adjustment_credit', 'adjustment_debit'].includes(type)) {
            return res.status(400).json({ success: false, message: 'type must be adjustment_credit or adjustment_debit' });
        }
        if (!amount || parseFloat(amount) <= 0) {
            return res.status(400).json({ success: false, message: 'Amount must be greater than 0' });
        }
        if (!notes?.trim()) {
            return res.status(400).json({ success: false, message: 'Notes are required for manual adjustments' });
        }

        const wallet = await DeliveryWallet.findByPk(walletId);
        if (!wallet) return res.status(404).json({ success: false, message: 'Wallet not found' });

        const t           = await sequelize.transaction();
        const parsedAmount = parseFloat(amount);
        const balanceBefore = parseFloat(wallet.balance);

        try {
            let balanceAfter;

            if (type === 'adjustment_credit') {
                balanceAfter = balanceBefore + parsedAmount;
                await wallet.increment({ balance: parsedAmount, total_earned: parsedAmount }, { transaction: t });
            } else {
                if (parsedAmount > balanceBefore) {
                    await t.rollback();
                    return res.status(400).json({ success: false, message: 'Debit amount exceeds wallet balance' });
                }
                balanceAfter = balanceBefore - parsedAmount;
                await wallet.decrement({ balance: parsedAmount }, { transaction: t });
            }

            await DeliveryWalletTransaction.create({
                wallet_id:             walletId,
                delivery_id:           null,
                type,
                payment_method:        'system',
                amount:                parsedAmount,
                balance_before:        balanceBefore,
                balance_after:         balanceAfter,
                notes:                 notes.trim(),
                created_by_employee_id: req.user.id,
            }, { transaction: t });

            await t.commit();

            return res.json({
                success:      true,
                message:      `Wallet ${type === 'adjustment_credit' ? 'credited' : 'debited'} successfully`,
                balanceBefore,
                balanceAfter,
                amount:       parsedAmount,
            });

        } catch (err) {
            await t.rollback();
            throw err;
        }

    } catch (error) {
        console.error('❌ [WALLETS] adjustWallet error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to adjust wallet' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// SETTLE CASH COMMISSION
// POST /api/backoffice/delivery/wallets/:walletId/settle-commission
// ═══════════════════════════════════════════════════════════════════════════════
exports.settleCommission = async (req, res) => {
    try {
        const { walletId } = req.params;
        const { amount, notes } = req.body;

        if (!amount || parseFloat(amount) <= 0) {
            return res.status(400).json({ success: false, message: 'Amount must be greater than 0' });
        }

        const wallet = await DeliveryWallet.findByPk(walletId, {
            include: [{ association: 'driver', attributes: ['id'] }],
        });
        if (!wallet) return res.status(404).json({ success: false, message: 'Wallet not found' });

        await deliveryEarningsService.settleCashCommission(
            wallet.driver_id,
            parseFloat(amount),
            req.user.id,
            notes || null
        );

        const outstanding = parseFloat(wallet.total_commission_owed) - parseFloat(wallet.total_commission_paid) - parseFloat(amount);

        return res.json({
            success:              true,
            message:              `${parseFloat(amount).toLocaleString()} XAF commission settled`,
            settledAmount:        parseFloat(amount),
            remainingOutstanding: Math.max(0, outstanding),
        });

    } catch (error) {
        console.error('❌ [WALLETS] settleCommission error:', error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// FREEZE / UNFREEZE WALLET
// PATCH /api/backoffice/delivery/wallets/:walletId/status
// ═══════════════════════════════════════════════════════════════════════════════
exports.updateWalletStatus = async (req, res) => {
    try {
        const { walletId } = req.params;
        const { status, reason } = req.body;

        if (!['active', 'frozen', 'suspended'].includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status' });
        }

        const wallet = await DeliveryWallet.findByPk(walletId);
        if (!wallet) return res.status(404).json({ success: false, message: 'Wallet not found' });

        await wallet.update({
            status,
            frozen_reason: status === 'active' ? null : (reason || null),
            frozen_by:     status === 'active' ? null : req.user.id,
        });

        return res.json({ success: true, message: `Wallet ${status}`, status });

    } catch (error) {
        console.error('❌ [WALLETS] updateWalletStatus error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to update wallet status' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT WALLETS REPORT (Excel)
// GET /api/backoffice/delivery/wallets/export
// ═══════════════════════════════════════════════════════════════════════════════
exports.exportWallets = async (req, res) => {
    try {
        const wallets = await DeliveryWallet.findAll({
            include: [
                {
                    association: 'driver',
                    attributes:  ['id', 'vehicle_make_model', 'rating'],
                    include: [
                        {
                            model:      Account,
                            as:         'account',
                            attributes: ['first_name', 'last_name', 'phone_e164', 'user_type'],
                        },
                    ],
                },
            ],
            order: [['balance', 'DESC']],
        });

        const workbook  = new ExcelJS.Workbook();
        const sheet     = workbook.addWorksheet('Delivery Wallets');

        sheet.columns = [
            { header: 'Agent Name',           key: 'name',            width: 25 },
            { header: 'Phone',                key: 'phone',           width: 18 },
            { header: 'Type',                 key: 'type',            width: 16 },
            { header: 'Vehicle',              key: 'vehicle',         width: 20 },
            { header: 'Balance (XAF)',        key: 'balance',         width: 16 },
            { header: 'Total Earned (XAF)',   key: 'totalEarned',     width: 18 },
            { header: 'Cash Collected (XAF)', key: 'cashCollected',   width: 20 },
            { header: 'Commission Owed (XAF)',key: 'commissionOwed',  width: 22 },
            { header: 'Commission Paid (XAF)',key: 'commissionPaid',  width: 22 },
            { header: 'Outstanding (XAF)',    key: 'outstanding',     width: 18 },
            { header: 'Total Withdrawn (XAF)',key: 'withdrawn',       width: 22 },
            { header: 'Wallet Status',        key: 'walletStatus',    width: 14 },
        ];

        // Header style
        sheet.getRow(1).eachCell(cell => {
            cell.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A0A0A' } };
            cell.alignment = { horizontal: 'center' };
        });

        wallets.forEach(w => {
            const outstanding = parseFloat(w.total_commission_owed) - parseFloat(w.total_commission_paid);
            sheet.addRow({
                name:          `${w.driver?.account?.first_name || ''} ${w.driver?.account?.last_name || ''}`.trim(),
                phone:         w.driver?.account?.phone_e164  || '—',
                type:          w.driver?.account?.user_type   || '—',
                vehicle:       w.driver?.vehicle_make_model   || '—',
                balance:       parseFloat(w.balance),
                totalEarned:   parseFloat(w.total_earned),
                cashCollected: parseFloat(w.total_cash_collected),
                commissionOwed:parseFloat(w.total_commission_owed),
                commissionPaid:parseFloat(w.total_commission_paid),
                outstanding:   outstanding,
                withdrawn:     parseFloat(w.total_withdrawn),
                walletStatus:  w.status,
            });
        });

        // Alternate row colors
        sheet.eachRow((row, rowNumber) => {
            if (rowNumber > 1) {
                row.eachCell(cell => {
                    cell.fill = {
                        type:    'pattern',
                        pattern: 'solid',
                        fgColor: { argb: rowNumber % 2 === 0 ? 'FFF9F9F9' : 'FFFFFFFF' },
                    };
                });
            }
        });

        const filename = `wego_delivery_wallets_${new Date().toISOString().split('T')[0]}.xlsx`;
        res.setHeader('Content-Type',        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error('❌ [WALLETS] exportWallets error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to export' });
    }
};
