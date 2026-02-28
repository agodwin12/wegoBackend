// src/controllers/backoffice/adminEarnings.controller.js
//
// ═══════════════════════════════════════════════════════════════════════
// ADMIN EARNINGS CONTROLLER (Backoffice)
// ═══════════════════════════════════════════════════════════════════════
//
// Accessible only to: super_admin, admin, manager
// (enforced via requireEmployeeRole in the routes file)
//
// Earning Rules endpoints:
//   GET    /api/admin/earnings/rules          → list all rules
//   POST   /api/admin/earnings/rules          → create a rule
//   PUT    /api/admin/earnings/rules/:id      → update a rule
//   DELETE /api/admin/earnings/rules/:id      → deactivate a rule
//
// Bonus Programs endpoints:
//   GET    /api/admin/earnings/programs       → list all programs
//   POST   /api/admin/earnings/programs       → create a program
//   PUT    /api/admin/earnings/programs/:id   → update a program
//   DELETE /api/admin/earnings/programs/:id   → deactivate a program
//
// Driver earnings read-only:
//   GET    /api/admin/earnings/drivers        → list drivers + wallet summary
//   GET    /api/admin/earnings/drivers/:uuid  → one driver full detail
//   GET    /api/admin/earnings/overview       → platform-wide revenue stats
//
// ═══════════════════════════════════════════════════════════════════════

'use strict';

const { v4: uuidv4 } = require('uuid');
const { Op }         = require('sequelize');
const earningsEngine = require('../../services/earningsEngineService');

const {
    EarningRule,
    BonusProgram,
    BonusAward,
    DriverWallet,
    DriverWalletTransaction,
    TripReceipt,
    Account,
    DriverProfile,
} = require('../../models');

// ═══════════════════════════════════════════════════════════════════════
// ── EARNING RULES ──────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/earnings/rules
 * List all earning rules (active and inactive)
 */
exports.listRules = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📋 [ADMIN EARNINGS] listRules');

        const rules = await EarningRule.findAll({
            order: [['priority', 'DESC'], ['createdAt', 'DESC']],
            include: [
                { association: 'creator', attributes: ['id', 'firstName', 'lastName', 'email'] },
                { association: 'updater', attributes: ['id', 'firstName', 'lastName', 'email'] },
            ],
        });

        console.log(`✅ [ADMIN EARNINGS] ${rules.length} rules returned`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({ success: true, data: { rules } });

    } catch (error) {
        console.error('❌ [ADMIN EARNINGS] listRules error:', error);
        next(error);
    }
};

/**
 * POST /api/admin/earnings/rules
 * Create a new earning rule
 *
 * Body:
 *   name        string   required
 *   type        string   required  COMMISSION_PERCENT | BONUS_FLAT | BONUS_MULTIPLIER | PENALTY
 *   value       number   required  e.g. 0.10 for 10% commission, 500 for 500 XAF flat bonus
 *   appliesTo   string   optional  RIDE | RENTAL | ALL (default: ALL)
 *   priority    number   optional  higher = evaluated first (default: 0)
 *   conditions  object   optional  { city, hour_from, hour_to, day_of_week, min_fare, ... }
 *   validFrom   string   optional  ISO date YYYY-MM-DD
 *   validTo     string   optional  ISO date YYYY-MM-DD
 *   description string   optional
 */
exports.createRule = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('➕ [ADMIN EARNINGS] createRule');
        console.log('   By:', req.user.id, `(${req.user.role})`);

        const {
            name, type, value, appliesTo, priority,
            conditions, validFrom, validTo, description,
        } = req.body;

        // ── Validation ────────────────────────────────────────────────
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, message: 'Rule name is required.' });
        }

        const validTypes = ['COMMISSION_PERCENT', 'BONUS_FLAT', 'BONUS_MULTIPLIER', 'PENALTY'];
        if (!validTypes.includes(type)) {
            return res.status(400).json({
                success: false,
                message: `Invalid type. Must be one of: ${validTypes.join(', ')}`,
            });
        }

        const parsedValue = parseFloat(value);
        if (isNaN(parsedValue) || parsedValue < 0) {
            return res.status(400).json({ success: false, message: 'Value must be a positive number.' });
        }

        // Commission must be between 0 and 1 (it's a rate, e.g. 0.10 = 10%)
        if (type === 'COMMISSION_PERCENT' && (parsedValue < 0 || parsedValue > 1)) {
            return res.status(400).json({
                success: false,
                message: 'Commission rate must be between 0 and 1 (e.g. 0.10 for 10%).',
            });
        }

        const validAppliesTo = ['RIDE', 'RENTAL', 'ALL'];
        const resolvedAppliesTo = (appliesTo && validAppliesTo.includes(appliesTo)) ? appliesTo : 'ALL';

        // ── Create ────────────────────────────────────────────────────
        const rule = await EarningRule.create({
            id:          uuidv4(),
            name:        name.trim(),
            description: description?.trim() || null,
            type,
            value:       parsedValue,
            appliesTo:   resolvedAppliesTo,
            priority:    parseInt(priority || 0, 10),
            conditions:  conditions || {},
            validFrom:   validFrom   || null,
            validTo:     validTo     || null,
            isActive:    true,
            createdBy:   req.user.id,
            updatedBy:   req.user.id,
        });

        // Invalidate Redis cache so the engine picks up the new rule immediately
        await earningsEngine.invalidateRulesCache();

        console.log(`✅ [ADMIN EARNINGS] Rule created: "${rule.name}" (${rule.id})`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(201).json({
            success: true,
            message: 'Earning rule created successfully.',
            data:    { rule },
        });

    } catch (error) {
        console.error('❌ [ADMIN EARNINGS] createRule error:', error);
        next(error);
    }
};

/**
 * PUT /api/admin/earnings/rules/:id
 * Update an existing earning rule
 */
exports.updateRule = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✏️  [ADMIN EARNINGS] updateRule:', req.params.id);
        console.log('   By:', req.user.id, `(${req.user.role})`);

        const rule = await EarningRule.findByPk(req.params.id);
        if (!rule) {
            return res.status(404).json({ success: false, message: 'Earning rule not found.' });
        }

        const {
            name, type, value, appliesTo, priority,
            conditions, validFrom, validTo, description, isActive,
        } = req.body;

        // Only update fields that were sent
        if (name        !== undefined) rule.name        = name.trim();
        if (description !== undefined) rule.description = description?.trim() || null;
        if (isActive    !== undefined) rule.isActive    = Boolean(isActive);
        if (priority    !== undefined) rule.priority    = parseInt(priority, 10);
        if (conditions  !== undefined) rule.conditions  = conditions;
        if (validFrom   !== undefined) rule.validFrom   = validFrom   || null;
        if (validTo     !== undefined) rule.validTo     = validTo     || null;
        if (appliesTo   !== undefined) rule.appliesTo   = appliesTo;

        if (type !== undefined) {
            const validTypes = ['COMMISSION_PERCENT', 'BONUS_FLAT', 'BONUS_MULTIPLIER', 'PENALTY'];
            if (!validTypes.includes(type)) {
                return res.status(400).json({ success: false, message: 'Invalid rule type.' });
            }
            rule.type = type;
        }

        if (value !== undefined) {
            const parsedValue = parseFloat(value);
            if (isNaN(parsedValue) || parsedValue < 0) {
                return res.status(400).json({ success: false, message: 'Value must be a positive number.' });
            }
            if ((rule.type === 'COMMISSION_PERCENT') && (parsedValue < 0 || parsedValue > 1)) {
                return res.status(400).json({
                    success: false,
                    message: 'Commission rate must be between 0 and 1.',
                });
            }
            rule.value = parsedValue;
        }

        rule.updatedBy = req.user.id;
        await rule.save();

        // Invalidate cache
        await earningsEngine.invalidateRulesCache();

        console.log(`✅ [ADMIN EARNINGS] Rule updated: "${rule.name}" (${rule.id})`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({
            success: true,
            message: 'Earning rule updated successfully.',
            data:    { rule },
        });

    } catch (error) {
        console.error('❌ [ADMIN EARNINGS] updateRule error:', error);
        next(error);
    }
};

/**
 * DELETE /api/admin/earnings/rules/:id
 * Soft-delete (deactivate) a rule — never hard delete for audit integrity
 */
exports.deleteRule = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🗑️  [ADMIN EARNINGS] deleteRule:', req.params.id);
        console.log('   By:', req.user.id, `(${req.user.role})`);

        const rule = await EarningRule.findByPk(req.params.id);
        if (!rule) {
            return res.status(404).json({ success: false, message: 'Earning rule not found.' });
        }

        rule.isActive  = false;
        rule.updatedBy = req.user.id;
        await rule.save();

        await earningsEngine.invalidateRulesCache();

        console.log(`✅ [ADMIN EARNINGS] Rule deactivated: "${rule.name}"`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({
            success: true,
            message: `Rule "${rule.name}" deactivated. It will no longer apply to new trips.`,
        });

    } catch (error) {
        console.error('❌ [ADMIN EARNINGS] deleteRule error:', error);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// ── BONUS PROGRAMS ─────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/earnings/programs
 * List all bonus programs
 */
exports.listPrograms = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📋 [ADMIN EARNINGS] listPrograms');

        const programs = await BonusProgram.findAll({
            order: [['displayOrder', 'ASC'], ['createdAt', 'DESC']],
            include: [
                { association: 'creator', attributes: ['id', 'firstName', 'lastName', 'email'] },
                { association: 'updater', attributes: ['id', 'firstName', 'lastName', 'email'] },
            ],
        });

        // For each program, attach award counts for current period
        const today = new Date().toISOString().split('T')[0];

        const programsWithStats = await Promise.all(programs.map(async (p) => {
            const periodKey    = BonusProgram.getPeriodKey(p.period);
            const awardsCount  = await BonusAward.count({ where: { programId: p.id, periodKey } });
            const totalAwarded = await BonusAward.sum('awardedAmount', { where: { programId: p.id } }) || 0;

            return {
                ...p.toJSON(),
                currentPeriodKey:       periodKey,
                currentPeriodAwards:    awardsCount,
                totalAmountAwarded:     totalAwarded,
            };
        }));

        console.log(`✅ [ADMIN EARNINGS] ${programs.length} programs returned`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({ success: true, data: { programs: programsWithStats } });

    } catch (error) {
        console.error('❌ [ADMIN EARNINGS] listPrograms error:', error);
        next(error);
    }
};

/**
 * POST /api/admin/earnings/programs
 * Create a new bonus program
 *
 * Body:
 *   name         string  required
 *   type         string  required  DAILY_TRIPS | WEEKLY_TRIPS | MONTHLY_TRIPS | DAILY_EARNINGS | ...
 *   period       string  required  DAILY | WEEKLY | MONTHLY | LIFETIME
 *   targetValue  number  required  e.g. 10 trips or 50000 XAF
 *   bonusAmount  number  required  XAF to award when target hit
 *   description  string  optional
 *   iconEmoji    string  optional  default 🏆
 *   displayOrder number  optional
 *   validFrom    string  optional
 *   validTo      string  optional
 */
exports.createProgram = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('➕ [ADMIN EARNINGS] createProgram');
        console.log('   By:', req.user.id, `(${req.user.role})`);

        const {
            name, type, period, targetValue, bonusAmount,
            description, iconEmoji, displayOrder, validFrom, validTo,
        } = req.body;

        // ── Validation ────────────────────────────────────────────────
        if (!name?.trim()) {
            return res.status(400).json({ success: false, message: 'Program name is required.' });
        }

        const validTypes = [
            'DAILY_TRIPS', 'WEEKLY_TRIPS', 'MONTHLY_TRIPS', 'LIFETIME_TRIPS',
            'DAILY_EARNINGS', 'WEEKLY_EARNINGS', 'MONTHLY_EARNINGS',
        ];
        if (!validTypes.includes(type)) {
            return res.status(400).json({
                success: false,
                message: `Invalid type. Must be one of: ${validTypes.join(', ')}`,
            });
        }

        const validPeriods = ['DAILY', 'WEEKLY', 'MONTHLY', 'LIFETIME'];
        if (!validPeriods.includes(period)) {
            return res.status(400).json({
                success: false,
                message: `Invalid period. Must be one of: ${validPeriods.join(', ')}`,
            });
        }

        const parsedTarget = parseInt(targetValue, 10);
        const parsedBonus  = parseInt(bonusAmount,  10);

        if (isNaN(parsedTarget) || parsedTarget <= 0) {
            return res.status(400).json({ success: false, message: 'targetValue must be a positive integer.' });
        }
        if (isNaN(parsedBonus) || parsedBonus <= 0) {
            return res.status(400).json({ success: false, message: 'bonusAmount must be a positive integer (XAF).' });
        }

        // ── Create ────────────────────────────────────────────────────
        const program = await BonusProgram.create({
            id:           uuidv4(),
            name:         name.trim(),
            description:  description?.trim() || null,
            type,
            period,
            targetValue:  parsedTarget,
            bonusAmount:  parsedBonus,
            iconEmoji:    iconEmoji    || '🏆',
            displayOrder: parseInt(displayOrder || 0, 10),
            validFrom:    validFrom    || null,
            validTo:      validTo      || null,
            isActive:     true,
            createdBy:    req.user.id,
            updatedBy:    req.user.id,
        });

        await earningsEngine.invalidateRulesCache();

        console.log(`✅ [ADMIN EARNINGS] Program created: "${program.name}" (${program.id})`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(201).json({
            success: true,
            message: 'Bonus program created successfully.',
            data:    { program },
        });

    } catch (error) {
        console.error('❌ [ADMIN EARNINGS] createProgram error:', error);
        next(error);
    }
};

/**
 * PUT /api/admin/earnings/programs/:id
 * Update a bonus program
 */
exports.updateProgram = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✏️  [ADMIN EARNINGS] updateProgram:', req.params.id);
        console.log('   By:', req.user.id, `(${req.user.role})`);

        const program = await BonusProgram.findByPk(req.params.id);
        if (!program) {
            return res.status(404).json({ success: false, message: 'Bonus program not found.' });
        }

        const {
            name, description, targetValue, bonusAmount,
            iconEmoji, displayOrder, validFrom, validTo, isActive,
        } = req.body;

        if (name         !== undefined) program.name         = name.trim();
        if (description  !== undefined) program.description  = description?.trim() || null;
        if (iconEmoji    !== undefined) program.iconEmoji    = iconEmoji;
        if (displayOrder !== undefined) program.displayOrder = parseInt(displayOrder, 10);
        if (validFrom    !== undefined) program.validFrom    = validFrom || null;
        if (validTo      !== undefined) program.validTo      = validTo   || null;
        if (isActive     !== undefined) program.isActive     = Boolean(isActive);

        if (targetValue !== undefined) {
            const v = parseInt(targetValue, 10);
            if (isNaN(v) || v <= 0) {
                return res.status(400).json({ success: false, message: 'targetValue must be a positive integer.' });
            }
            program.targetValue = v;
        }

        if (bonusAmount !== undefined) {
            const v = parseInt(bonusAmount, 10);
            if (isNaN(v) || v <= 0) {
                return res.status(400).json({ success: false, message: 'bonusAmount must be a positive integer (XAF).' });
            }
            program.bonusAmount = v;
        }

        program.updatedBy = req.user.id;
        await program.save();

        await earningsEngine.invalidateRulesCache();

        console.log(`✅ [ADMIN EARNINGS] Program updated: "${program.name}"`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({
            success: true,
            message: 'Bonus program updated successfully.',
            data:    { program },
        });

    } catch (error) {
        console.error('❌ [ADMIN EARNINGS] updateProgram error:', error);
        next(error);
    }
};

/**
 * DELETE /api/admin/earnings/programs/:id
 * Soft-delete (deactivate) — no hard delete, preserves award history
 */
exports.deleteProgram = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🗑️  [ADMIN EARNINGS] deleteProgram:', req.params.id);

        const program = await BonusProgram.findByPk(req.params.id);
        if (!program) {
            return res.status(404).json({ success: false, message: 'Bonus program not found.' });
        }

        program.isActive  = false;
        program.updatedBy = req.user.id;
        await program.save();

        await earningsEngine.invalidateRulesCache();

        console.log(`✅ [ADMIN EARNINGS] Program deactivated: "${program.name}"`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({
            success: true,
            message: `Program "${program.name}" deactivated.`,
        });

    } catch (error) {
        console.error('❌ [ADMIN EARNINGS] deleteProgram error:', error);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// ── DRIVER EARNINGS (READ-ONLY for admin) ──────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/earnings/drivers
 * List all drivers with their wallet summary
 * Query: page, limit, search (name/phone), status (wallet status)
 */
exports.listDriverWallets = async (req, res, next) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📋 [ADMIN EARNINGS] listDriverWallets');

        const page   = Math.max(parseInt(req.query.page  || '1',  10), 1);
        const limit  = Math.min(parseInt(req.query.limit || '20', 10), 100);
        const offset = (page - 1) * limit;
        const search = req.query.search?.trim() || null;

        const walletWhere = {};
        if (req.query.status) walletWhere.status = req.query.status.toUpperCase();

        const accountWhere = { userType: 'driver' };
        if (search) {
            accountWhere[Op.or] = [
                { firstName: { [Op.like]: `%${search}%` } },
                { lastName:  { [Op.like]: `%${search}%` } },
                { phone:     { [Op.like]: `%${search}%` } },
            ];
        }

        const { count, rows: wallets } = await DriverWallet.findAndCountAll({
            where: walletWhere,
            include: [
                {
                    model:      Account,
                    as:         'driver',
                    attributes: ['uuid', 'firstName', 'lastName', 'phone', 'profilePhotoUrl', 'status'],
                    where:      accountWhere,
                    required:   true,
                    include: [
                        {
                            model:      DriverProfile,
                            as:         'driver_profile',
                            attributes: ['ratingAvg', 'totalTrips', 'isOnline', 'vehicleMake', 'vehicleModel'],
                            required:   false,
                        },
                    ],
                },
            ],
            order:  [['balance', 'DESC']],
            limit,
            offset,
        });

        const formatted = wallets.map(w => ({
            walletId:        w.id,
            walletStatus:    w.status,
            balance:         w.balance,
            totalEarned:     w.totalEarned,
            totalCommission: w.totalCommission,
            totalBonuses:    w.totalBonuses,
            totalPayouts:    w.totalPayouts,
            lastPayoutAt:    w.lastPayoutAt,
            currency:        w.currency,
            driver: {
                uuid:        w.driver.uuid,
                name:        `${w.driver.firstName} ${w.driver.lastName}`,
                phone:       w.driver.phone,
                photo:       w.driver.profilePhotoUrl,
                status:      w.driver.status,
                rating:      w.driver.driver_profile?.ratingAvg || 0,
                totalTrips:  w.driver.driver_profile?.totalTrips || 0,
                isOnline:    w.driver.driver_profile?.isOnline || false,
                vehicle:     w.driver.driver_profile
                    ? `${w.driver.driver_profile.vehicleMake || ''} ${w.driver.driver_profile.vehicleModel || ''}`.trim()
                    : null,
            },
        }));

        console.log(`✅ [ADMIN EARNINGS] ${count} driver wallets found`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({
            success: true,
            data: {
                wallets: formatted,
                pagination: { total: count, page, limit, totalPages: Math.ceil(count / limit) },
            },
        });

    } catch (error) {
        console.error('❌ [ADMIN EARNINGS] listDriverWallets error:', error);
        next(error);
    }
};

/**
 * GET /api/admin/earnings/drivers/:uuid
 * Full earnings detail for one driver — wallet + receipts + transactions
 * Query: period (today | week | month | all — default: month)
 */
exports.getDriverEarningsDetail = async (req, res, next) => {
    try {
        const { uuid }   = req.params;
        const period     = req.query.period || 'month';

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`🔍 [ADMIN EARNINGS] getDriverEarningsDetail: ${uuid}`);

        const wallet = await DriverWallet.findOne({
            where:   { driverId: uuid },
            include: [
                {
                    model:      Account,
                    as:         'driver',
                    attributes: ['uuid', 'firstName', 'lastName', 'phone', 'profilePhotoUrl'],
                    include: [
                        {
                            model:    DriverProfile,
                            as:       'driver_profile',
                            attributes: ['ratingAvg', 'totalTrips', 'vehicleMake', 'vehicleModel', 'vehiclePlate'],
                            required: false,
                        },
                    ],
                },
            ],
        });

        if (!wallet) {
            return res.status(404).json({ success: false, message: 'Driver wallet not found.' });
        }

        // Period receipts
        const dateFilter  = _buildDateFilter(period);
        const receiptWhere = { driverId: uuid };
        if (dateFilter) receiptWhere.createdAt = dateFilter;

        const receipts    = await TripReceipt.findAll({
            where: receiptWhere,
            order: [['createdAt', 'DESC']],
            limit: 50,
        });

        // Period transactions
        const txWhere = { driverId: uuid };
        if (dateFilter) txWhere.createdAt = dateFilter;

        const transactions = await DriverWalletTransaction.findAll({
            where: txWhere,
            order: [['createdAt', 'DESC']],
            limit: 100,
        });

        // Period aggregates
        const periodGross      = receipts.reduce((s, r) => s + r.grossFare,       0);
        const periodCommission = receipts.reduce((s, r) => s + r.commissionAmount, 0);
        const periodBonuses    = receipts.reduce((s, r) => s + r.bonusTotal,       0);
        const periodNet        = receipts.reduce((s, r) => s + r.driverNet,        0);

        console.log(`✅ [ADMIN EARNINGS] Detail loaded: ${receipts.length} receipts`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({
            success: true,
            data: {
                wallet: {
                    id:              wallet.id,
                    balance:         wallet.balance,
                    totalEarned:     wallet.totalEarned,
                    totalCommission: wallet.totalCommission,
                    totalBonuses:    wallet.totalBonuses,
                    totalPayouts:    wallet.totalPayouts,
                    status:          wallet.status,
                    currency:        wallet.currency,
                    lastPayoutAt:    wallet.lastPayoutAt,
                    frozenReason:    wallet.frozenReason || null,
                },
                driver: {
                    uuid:       wallet.driver.uuid,
                    name:       `${wallet.driver.firstName} ${wallet.driver.lastName}`,
                    phone:      wallet.driver.phone,
                    photo:      wallet.driver.profilePhotoUrl,
                    rating:     wallet.driver.driver_profile?.ratingAvg  || 0,
                    totalTrips: wallet.driver.driver_profile?.totalTrips || 0,
                    vehicle:    wallet.driver.driver_profile
                        ? `${wallet.driver.driver_profile.vehicleMake || ''} ${wallet.driver.driver_profile.vehicleModel || ''} (${wallet.driver.driver_profile.vehiclePlate || ''})`.trim()
                        : null,
                },
                period,
                periodSummary: {
                    trips:      receipts.length,
                    grossFare:  periodGross,
                    commission: periodCommission,
                    bonuses:    periodBonuses,
                    net:        periodNet,
                },
                receipts:     receipts.map(r => ({
                    id:              r.id,
                    tripId:          r.tripId,
                    grossFare:       r.grossFare,
                    commissionRate:  r.commissionRate,
                    commissionAmount:r.commissionAmount,
                    bonusTotal:      r.bonusTotal,
                    driverNet:       r.driverNet,
                    paymentMethod:   r.paymentMethod,
                    status:          r.status,
                    createdAt:       r.createdAt,
                })),
                transactions: transactions.map(tx => ({
                    id:           tx.id,
                    type:         tx.type,
                    amount:       tx.amount,
                    balanceAfter: tx.balanceAfter,
                    description:  tx.description,
                    createdAt:    tx.createdAt,
                })),
            },
        });

    } catch (error) {
        console.error('❌ [ADMIN EARNINGS] getDriverEarningsDetail error:', error);
        next(error);
    }
};

/**
 * GET /api/admin/earnings/overview
 * Platform-wide revenue stats — total commission earned, bonuses paid, etc.
 * Query: period (today | week | month | all — default: month)
 */
exports.getOverview = async (req, res, next) => {
    try {
        const period = req.query.period || 'month';

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`📊 [ADMIN EARNINGS] getOverview — period: ${period}`);

        const dateFilter   = _buildDateFilter(period);
        const receiptWhere = { status: 'SETTLED' };
        if (dateFilter) receiptWhere.createdAt = dateFilter;

        const [
            totalTrips,
            totalGrossFare,
            totalCommission,
            totalBonuses,
            totalDriverNet,
            activeWallets,
            frozenWallets,
        ] = await Promise.all([
            TripReceipt.count({ where: receiptWhere }),
            TripReceipt.sum('grossFare',       { where: receiptWhere }),
            TripReceipt.sum('commissionAmount',{ where: receiptWhere }),
            TripReceipt.sum('bonusTotal',      { where: receiptWhere }),
            TripReceipt.sum('driverNet',       { where: receiptWhere }),
            DriverWallet.count({ where: { status: 'ACTIVE'  } }),
            DriverWallet.count({ where: { status: 'FROZEN'  } }),
        ]);

        // Top 5 earners for the period
        const topEarners = await TripReceipt.findAll({
            where:      receiptWhere,
            attributes: [
                'driverId',
                [require('sequelize').fn('SUM', require('sequelize').col('driver_net')), 'periodNet'],
                [require('sequelize').fn('COUNT', require('sequelize').col('id')),       'tripCount'],
            ],
            include: [
                {
                    model:      Account,
                    as:         'driver',
                    attributes: ['firstName', 'lastName', 'profilePhotoUrl'],
                    required:   true,
                },
            ],
            group:   ['driverId', 'driver.uuid', 'driver.first_name', 'driver.last_name', 'driver.profile_photo_url'],
            order:   [[require('sequelize').literal('periodNet'), 'DESC']],
            limit:   5,
            subQuery: false,
        });

        console.log(`✅ [ADMIN EARNINGS] Overview: ${totalTrips} trips, ${Math.round(totalCommission || 0)} XAF commission`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(200).json({
            success: true,
            data: {
                period,
                revenue: {
                    totalTrips:      totalTrips      || 0,
                    totalGrossFare:  Math.round(totalGrossFare  || 0),
                    totalCommission: Math.round(totalCommission || 0),  // WEGO revenue
                    totalBonuses:    Math.round(totalBonuses    || 0),  // WEGO cost
                    totalDriverNet:  Math.round(totalDriverNet  || 0),
                    netWegoRevenue:  Math.round((totalCommission || 0) - (totalBonuses || 0)),
                },
                wallets: {
                    active: activeWallets,
                    frozen: frozenWallets,
                    total:  activeWallets + frozenWallets,
                },
                topEarners: topEarners.map(e => ({
                    driverId:   e.driverId,
                    name:       `${e.driver.firstName} ${e.driver.lastName}`,
                    photo:      e.driver.profilePhotoUrl,
                    periodNet:  Math.round(parseFloat(e.getDataValue('periodNet')  || 0)),
                    tripCount:  parseInt(e.getDataValue('tripCount') || 0, 10),
                })),
            },
        });

    } catch (error) {
        console.error('❌ [ADMIN EARNINGS] getOverview error:', error);
        next(error);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// PRIVATE HELPERS
// ═══════════════════════════════════════════════════════════════════════

function _buildDateFilter(period) {
    const now       = new Date();
    const today     = new Date(now); today.setUTCHours(0, 0, 0, 0);
    const tomorrow  = new Date(today); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

    const weekStart = new Date(today);
    const day       = weekStart.getUTCDay() || 7;
    weekStart.setUTCDate(weekStart.getUTCDate() - day + 1);

    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    switch (period) {
        case 'today': return { [Op.gte]: today, [Op.lt]: tomorrow };
        case 'week':  return { [Op.gte]: weekStart  };
        case 'month': return { [Op.gte]: monthStart };
        default:      return null;
    }
}