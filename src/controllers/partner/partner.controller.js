// src/controllers/partner/partner.controller.js
//
// ═══════════════════════════════════════════════════════════════════════════
// PARTNER FLEET API
// ═══════════════════════════════════════════════════════════════════════════
//
// A PARTNER account (created by the company in the backoffice) manages a
// fleet of drivers it fully owns:
//
//   • create driver accounts (no OTP — the partner vouches; the driver gets
//     credentials and behaves EXACTLY like a self-registered driver after:
//     same app, same matching, same tier rules, same wallet)
//   • suspend / reactivate (suspended drivers cannot log in)
//   • delete a driver
//   • top up a driver's wallet (same direct-credit flow drivers use today,
//     ledger marked initiatedBy: 'partner')
//   • per-driver stats + fleet-level KPIs
//
// SECURITY: every driver-scoped endpoint verifies the driver belongs to the
// requesting partner (accounts.partner_id === req.user.uuid). A partner can
// never see or touch another partner's — or an independent — driver.
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const { Op, fn, col, literal } = require('sequelize');
const {
    sequelize,
    Account,
    DriverProfile,
    DriverWallet,
    DriverWalletTransaction,
    Trip,
} = require('../../models');

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
const MIN_TOPUP_XAF = 500;
const MAX_TOPUP_XAF = 500000;

const RIDE_TIERS = { economy: 'Economy', comfort: 'Comfort', luxury: 'Luxury' };
function normalizeTier(raw) {
    const v = String(raw || '').trim().toLowerCase();
    const map = {
        economy: 'Economy', comfort: 'Comfort', luxury: 'Luxury',
        standard: 'Economy', business: 'Comfort', premium: 'Luxury',
        suv: 'Luxury', van: 'Comfort', moto: 'Economy',
    };
    return map[v] || 'Economy';
}

// ── Ownership guard: load a driver THIS partner owns, or 404 ─────────────────
async function loadOwnedDriver(partnerUuid, driverUuid) {
    return Account.findOne({
        where: {
            uuid:       driverUuid,
            user_type:  'DRIVER',
            partner_id: partnerUuid,
            status:     { [Op.ne]: 'DELETED' },  // soft-deleted = gone
        },
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/partner/drivers — create a fleet driver
// ═══════════════════════════════════════════════════════════════════════════
exports.createDriver = async (req, res) => {
    const partnerUuid = req.user.uuid;

    try {
        const {
            first_name, last_name, email, phone_e164, password,
            civility, birth_date,
            cni_number, license_number, license_expiry,
            insurance_number, insurance_expiry,
            vehicle_type, vehicle_make_model, vehicle_color,
            vehicle_year, vehicle_plate,
        } = req.body;

        // ── Required fields ────────────────────────────────────────────────
        const required = { first_name, last_name, email, phone_e164, password, cni_number, license_number, vehicle_plate };
        for (const [k, v] of Object.entries(required)) {
            if (!v || !String(v).trim()) {
                return res.status(400).json({ success: false, message: `${k} is required`, code: 'MISSING_FIELD' });
            }
        }
        if (String(password).length < 8) {
            return res.status(400).json({ success: false, message: 'Password must be at least 8 characters', code: 'WEAK_PASSWORD' });
        }

        // ── Uniqueness ─────────────────────────────────────────────────────
        const emailTaken = await Account.findOne({ where: { email } });
        if (emailTaken) return res.status(409).json({ success: false, message: 'This email is already registered', code: 'EMAIL_EXISTS' });
        const phoneTaken = await Account.findOne({ where: { phone_e164 } });
        if (phoneTaken) return res.status(409).json({ success: false, message: 'This phone number is already registered', code: 'PHONE_EXISTS' });
        const plateTaken = await DriverProfile.findOne({ where: { vehicle_plate } });
        if (plateTaken) return res.status(409).json({ success: false, message: 'This vehicle plate is already registered', code: 'PLATE_EXISTS' });

        const password_hash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
        const driverUuid    = uuidv4();

        // ── Create account + profile + wallet atomically (mirrors the OTP
        //    signup path exactly, so this driver is indistinguishable from a
        //    self-registered one) ────────────────────────────────────────────
        const t = await sequelize.transaction();
        try {
            const account = await Account.create({
                uuid:           driverUuid,
                user_type:      'DRIVER',
                email,
                phone_e164,
                password_hash,
                password_algo:  'bcrypt',
                first_name,
                last_name,
                civility:       civility   || null,
                birth_date:     birth_date || null,
                status:         'ACTIVE',       // partner is company-vetted → driver active immediately
                email_verified: true,
                phone_verified: true,
                partner_id:     partnerUuid,    // fleet ownership
            }, { transaction: t });

            await DriverProfile.create({
                account_id:         driverUuid,
                cni_number,
                license_number,
                license_expiry:     license_expiry   || null,
                insurance_number:   insurance_number || null,
                insurance_expiry:   insurance_expiry || null,
                vehicle_type:       normalizeTier(vehicle_type),
                vehicle_make_model: vehicle_make_model || null,
                vehicle_color:      vehicle_color      || null,
                vehicle_year:       vehicle_year ? parseInt(vehicle_year, 10) : null,
                vehicle_plate,
                verification_state: 'VERIFIED',      // vetted by the partner
                status:             'offline',
                rating_avg:         0.0,
                rating_count:       0,
            }, { transaction: t });

            await DriverWallet.create({
                driverId:        driverUuid,
                balance:         0,
                totalEarned:     0,
                totalCommission: 0,
                totalBonuses:    0,
                totalPayouts:    0,
                status:          'ACTIVE',
                currency:        'XAF',
            }, { transaction: t });

            await t.commit();

            console.log(`✅ [PARTNER] Driver created: ${driverUuid} (partner ${partnerUuid})`);

            return res.status(201).json({
                success: true,
                message: 'Driver account created. Share the login credentials with your driver — they can change the password in the app.',
                data: {
                    driver: {
                        uuid:         account.uuid,
                        first_name, last_name, email, phone_e164,
                        status:       account.status,
                        vehicle_type: normalizeTier(vehicle_type),
                        vehicle_plate,
                    },
                    login: { identifier: email, note: 'Driver logs into the WeGo app with this email/phone and the password you set.' },
                },
            });
        } catch (txErr) {
            await t.rollback();
            throw txErr;
        }
    } catch (error) {
        console.error('❌ [PARTNER] createDriver error:', error.message);
        return res.status(500).json({ success: false, message: 'Unable to create the driver. Please try again.', code: 'DRIVER_CREATE_FAILED' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/partner/drivers — fleet list (with per-driver quick stats)
// ═══════════════════════════════════════════════════════════════════════════
exports.listDrivers = async (req, res) => {
    try {
        const partnerUuid = req.user.uuid;
        const page   = Math.max(1, parseInt(req.query.page  || '1', 10));
        const limit  = Math.min(100, Math.max(5, parseInt(req.query.limit || '25', 10)));
        const offset = (page - 1) * limit;

        const { count, rows } = await Account.findAndCountAll({
            where:      { partner_id: partnerUuid, user_type: 'DRIVER', status: { [Op.ne]: 'DELETED' } },
            attributes: ['uuid', 'first_name', 'last_name', 'email', 'phone_e164', 'status', 'avatar_url', 'created_at'],
            order:      [['created_at', 'DESC']],
            limit, offset,
        });

        const driverIds = rows.map(r => r.uuid);

        // Batched enrichments (profiles, wallets, trip counts) — no N+1.
        const [profiles, wallets, tripAgg] = await Promise.all([
            DriverProfile.findAll({
                where:      { account_id: { [Op.in]: driverIds } },
                attributes: ['account_id', 'vehicle_type', 'vehicle_plate', 'vehicle_make_model', 'rating_avg', 'rating_count', 'status'],
            }),
            DriverWallet.findAll({
                where:      { driverId: { [Op.in]: driverIds } },
                attributes: ['driverId', 'balance', 'status'],
            }),
            driverIds.length ? Trip.findAll({
                where:      { driverId: { [Op.in]: driverIds }, status: 'COMPLETED' },
                attributes: ['driverId', [fn('COUNT', col('id')), 'trips'], [fn('SUM', col('fareFinal')), 'gross']],
                group:      ['driverId'],
                raw:        true,
            }) : [],
        ]);

        const profByDriver   = new Map(profiles.map(p => [p.account_id, p]));
        const walletByDriver = new Map(wallets.map(w => [w.driverId, w]));
        const tripsByDriver  = new Map(tripAgg.map(a => [a.driverId, a]));

        const drivers = rows.map(a => {
            const p = profByDriver.get(a.uuid);
            const w = walletByDriver.get(a.uuid);
            const s = tripsByDriver.get(a.uuid);
            return {
                uuid:           a.uuid,
                name:           `${a.first_name} ${a.last_name}`.trim(),
                first_name:     a.first_name,
                last_name:      a.last_name,
                email:          a.email,
                phone_e164:     a.phone_e164,
                account_status: a.status,
                avatar_url:     a.avatar_url,
                created_at:     a.created_at,
                vehicle: p ? {
                    type:       p.vehicle_type,
                    plate:      p.vehicle_plate,
                    make_model: p.vehicle_make_model,
                } : null,
                rating:         p ? { avg: parseFloat(p.rating_avg) || 0, count: p.rating_count } : null,
                online_status:  p?.status || 'offline',
                wallet: w ? { balance: parseFloat(w.balance), status: w.status } : null,
                stats: {
                    trips_completed: parseInt(s?.trips || 0, 10),
                    gross_earnings:  parseInt(s?.gross || 0, 10),
                },
            };
        });

        return res.json({
            success: true,
            data: { drivers },
            pagination: { total: count, page, limit, totalPages: Math.ceil(count / limit) },
        });
    } catch (error) {
        console.error('❌ [PARTNER] listDrivers error:', error.message);
        return res.status(500).json({ success: false, message: 'Unable to load your drivers.', code: 'FLEET_LIST_FAILED' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/partner/drivers/:uuid — driver detail + full stats
// ═══════════════════════════════════════════════════════════════════════════
exports.getDriver = async (req, res) => {
    try {
        const driver = await loadOwnedDriver(req.user.uuid, req.params.uuid);
        if (!driver) return res.status(404).json({ success: false, message: 'Driver not found in your fleet.', code: 'DRIVER_NOT_FOUND' });

        const now        = new Date();
        const dayStart   = new Date(now); dayStart.setHours(0, 0, 0, 0);
        const weekStart  = new Date(now); weekStart.setDate(now.getDate() - ((now.getDay() || 7) - 1)); weekStart.setHours(0, 0, 0, 0);
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

        const tripsWhere = (extra = {}) => ({ driverId: driver.uuid, status: 'COMPLETED', ...extra });

        const [profile, wallet, txnAgg, tripsAll, tripsToday, tripsWeek, tripsMonth, canceled] = await Promise.all([
            DriverProfile.findOne({ where: { account_id: driver.uuid } }),
            DriverWallet.findOne({ where: { driverId: driver.uuid } }),
            DriverWalletTransaction.findAll({
                where:      { driverId: driver.uuid, type: 'COMMISSION' },
                attributes: [[fn('SUM', col('amount')), 'commission']],
                raw: true,
            }),
            Trip.findAll({ where: tripsWhere(), attributes: [[fn('COUNT', col('id')), 'n'], [fn('SUM', col('fareFinal')), 'gross']], raw: true }),
            Trip.count({ where: tripsWhere({ tripCompletedAt: { [Op.gte]: dayStart } }) }),
            Trip.count({ where: tripsWhere({ tripCompletedAt: { [Op.gte]: weekStart } }) }),
            Trip.count({ where: tripsWhere({ tripCompletedAt: { [Op.gte]: monthStart } }) }),
            Trip.count({ where: { driverId: driver.uuid, status: 'CANCELED', canceledBy: 'DRIVER' } }),
        ]);

        return res.json({
            success: true,
            data: {
                driver: {
                    uuid:           driver.uuid,
                    first_name:     driver.first_name,
                    last_name:      driver.last_name,
                    email:          driver.email,
                    phone_e164:     driver.phone_e164,
                    account_status: driver.status,
                    avatar_url:     driver.avatar_url,
                    created_at:     driver.created_at,
                },
                vehicle: profile ? {
                    type:       profile.vehicle_type,
                    plate:      profile.vehicle_plate,
                    make_model: profile.vehicle_make_model,
                    color:      profile.vehicle_color,
                    year:       profile.vehicle_year,
                    photo:      profile.vehicle_photo_url,
                } : null,
                rating: profile ? { avg: parseFloat(profile.rating_avg) || 0, count: profile.rating_count } : null,
                online_status: profile?.status || 'offline',
                wallet: wallet ? {
                    balance:          parseFloat(wallet.balance),
                    status:           wallet.status,
                    total_topups:     parseFloat(wallet.totalTopUps || 0),
                    total_commission: parseFloat(wallet.totalCommission || 0),
                    total_bonuses:    parseFloat(wallet.totalBonuses || 0),
                } : null,
                stats: {
                    trips_completed:     parseInt(tripsAll[0]?.n || 0, 10),
                    gross_earnings:      parseInt(tripsAll[0]?.gross || 0, 10),
                    commission_paid:     Math.abs(parseInt(txnAgg[0]?.commission || 0, 10)),
                    trips_today:         tripsToday,
                    trips_this_week:     tripsWeek,
                    trips_this_month:    tripsMonth,
                    canceled_by_driver:  canceled,
                },
            },
        });
    } catch (error) {
        console.error('❌ [PARTNER] getDriver error:', error.message);
        return res.status(500).json({ success: false, message: 'Unable to load this driver.', code: 'DRIVER_DETAIL_FAILED' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// PATCH /api/partner/drivers/:uuid/suspend | /reactivate
// Suspended accounts are rejected by the login flow — driver cannot log in.
// ═══════════════════════════════════════════════════════════════════════════
exports.suspendDriver = async (req, res) => {
    try {
        const driver = await loadOwnedDriver(req.user.uuid, req.params.uuid);
        if (!driver) return res.status(404).json({ success: false, message: 'Driver not found in your fleet.', code: 'DRIVER_NOT_FOUND' });

        driver.status = 'SUSPENDED';
        await driver.save();
        console.log(`⛔ [PARTNER] Driver ${driver.uuid} suspended by partner ${req.user.uuid}`);
        return res.json({ success: true, message: 'Driver suspended — they can no longer log in or receive rides.', data: { uuid: driver.uuid, status: driver.status } });
    } catch (error) {
        console.error('❌ [PARTNER] suspendDriver error:', error.message);
        return res.status(500).json({ success: false, message: 'Unable to suspend this driver.', code: 'SUSPEND_FAILED' });
    }
};

exports.reactivateDriver = async (req, res) => {
    try {
        const driver = await loadOwnedDriver(req.user.uuid, req.params.uuid);
        if (!driver) return res.status(404).json({ success: false, message: 'Driver not found in your fleet.', code: 'DRIVER_NOT_FOUND' });

        driver.status = 'ACTIVE';
        await driver.save();
        console.log(`✅ [PARTNER] Driver ${driver.uuid} reactivated by partner ${req.user.uuid}`);
        return res.json({ success: true, message: 'Driver reactivated — they can log in and receive rides again.', data: { uuid: driver.uuid, status: driver.status } });
    } catch (error) {
        console.error('❌ [PARTNER] reactivateDriver error:', error.message);
        return res.status(500).json({ success: false, message: 'Unable to reactivate this driver.', code: 'REACTIVATE_FAILED' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// DELETE /api/partner/drivers/:uuid
// ═══════════════════════════════════════════════════════════════════════════
exports.deleteDriver = async (req, res) => {
    try {
        const driver = await loadOwnedDriver(req.user.uuid, req.params.uuid);
        if (!driver) return res.status(404).json({ success: false, message: 'Driver not found in your fleet.', code: 'DRIVER_NOT_FOUND' });

        // Never delete a driver mid-trip.
        const activeTrip = await Trip.findOne({
            where: {
                driverId: driver.uuid,
                status:   { [Op.in]: ['MATCHED', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS'] },
            },
        });
        if (activeTrip) {
            return res.status(409).json({ success: false, message: 'This driver has an active trip. Wait until it finishes before deleting the account.', code: 'DRIVER_ON_TRIP' });
        }

        const tripCount = await Trip.count({ where: { driverId: driver.uuid } });

        if (tripCount > 0) {
            // History exists — soft delete. Status DELETED blocks login and the
            // driver disappears from the fleet, but ride records stay intact.
            driver.status = 'DELETED';
            await driver.save();
            console.log(`🗑️  [PARTNER] Driver ${driver.uuid} soft-deleted (has ${tripCount} trips) by partner ${req.user.uuid}`);
            return res.json({
                success: true,
                message: 'Driver account deleted. They can no longer log in; their trip history is kept for your records.',
                data: { uuid: driver.uuid, mode: 'soft' },
            });
        }

        // No history — remove the account and its dependents completely.
        // (driver_wallets has no ON DELETE CASCADE, so clear dependents first.)
        const { Driver: DriverRow } = require('../../models');
        const t = await sequelize.transaction();
        try {
            await DriverWalletTransaction.destroy({ where: { driverId: driver.uuid }, transaction: t });
            await DriverWallet.destroy({ where: { driverId: driver.uuid }, transaction: t });
            await DriverProfile.destroy({ where: { account_id: driver.uuid }, transaction: t });
            if (DriverRow) await DriverRow.destroy({ where: { userId: driver.uuid }, transaction: t });
            await driver.destroy({ transaction: t });
            await t.commit();
        } catch (txErr) {
            await t.rollback();
            throw txErr;
        }

        console.log(`🗑️  [PARTNER] Driver ${req.params.uuid} hard-deleted by partner ${req.user.uuid}`);
        return res.json({ success: true, message: 'Driver account deleted.', data: { uuid: req.params.uuid, mode: 'hard' } });
    } catch (error) {
        console.error('❌ [PARTNER] deleteDriver error:', error.message);
        return res.status(500).json({ success: false, message: 'Unable to delete this driver.', code: 'DELETE_FAILED' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/partner/drivers/:uuid/topup — credit the driver's wallet
// Same direct-credit flow drivers use themselves; ledger marks the partner.
// ═══════════════════════════════════════════════════════════════════════════
exports.topupDriver = async (req, res) => {
    try {
        const partnerUuid = req.user.uuid;
        const driver = await loadOwnedDriver(partnerUuid, req.params.uuid);
        if (!driver) return res.status(404).json({ success: false, message: 'Driver not found in your fleet.', code: 'DRIVER_NOT_FOUND' });

        const { amount, method, reference: externalRef, note } = req.body;
        const parsedAmount = parseInt(amount, 10);
        if (!parsedAmount || parsedAmount <= 0) {
            return res.status(400).json({ success: false, message: 'amount is required and must be a positive integer.', code: 'INVALID_AMOUNT' });
        }
        if (parsedAmount < MIN_TOPUP_XAF) return res.status(400).json({ success: false, message: `Minimum top-up is ${MIN_TOPUP_XAF} XAF.`, code: 'AMOUNT_TOO_LOW' });
        if (parsedAmount > MAX_TOPUP_XAF) return res.status(400).json({ success: false, message: `Maximum top-up is ${MAX_TOPUP_XAF} XAF.`, code: 'AMOUNT_TOO_HIGH' });

        const reference = externalRef
            ? `TOP_UP:PARTNER:${externalRef}`
            : `TOP_UP:PARTNER:${uuidv4()}`;

        // Idempotency on partner-supplied references
        if (externalRef) {
            const dup = await DriverWalletTransaction.findOne({ where: { reference } });
            if (dup) {
                return res.status(200).json({ success: true, duplicate: true, message: 'This top-up was already processed.' });
            }
        }

        const result = await sequelize.transaction(async (t) => {
            const [wallet] = await DriverWallet.findOrCreate({
                where:    { driverId: driver.uuid },
                defaults: { driverId: driver.uuid, balance: 0, status: 'ACTIVE', currency: 'XAF' },
                transaction: t,
                lock: true,
            });
            if (wallet.status !== 'ACTIVE') {
                const err = new Error('This driver\'s wallet is not active. Contact support.');
                err.status = 403;
                throw err;
            }

            const newBalance = parseFloat(wallet.balance) + parsedAmount;

            const txn = await DriverWalletTransaction.create({
                id:           uuidv4(),
                driverId:     driver.uuid,
                walletId:     wallet.id,
                type:         'TOP_UP',
                amount:       parsedAmount,
                balanceAfter: newBalance,
                description:  `Fleet top-up by partner — ${parsedAmount.toLocaleString()} XAF${note ? ` (${note})` : ''}`,
                reference,
                topUpMethod:  method || 'PARTNER',
                topUpRef:     externalRef || null,
                metadata: {
                    initiatedBy: 'partner',
                    partnerId:   partnerUuid,
                    driverId:    driver.uuid,
                    note:        note || null,
                },
                createdAt: new Date(),
            }, { transaction: t });

            await DriverWallet.update(
                {
                    balance:     literal(`balance + ${parsedAmount}`),
                    totalTopUps: literal(`totalTopUps + ${parsedAmount}`),
                    lastTopUpAt: new Date(),
                },
                { where: { id: wallet.id }, transaction: t }
            );

            return { txn, newBalance };
        });

        console.log(`💰 [PARTNER] ${parsedAmount} XAF → driver ${driver.uuid} by partner ${partnerUuid}`);

        return res.json({
            success: true,
            message: `Wallet credited with ${parsedAmount.toLocaleString()} XAF.`,
            data: {
                driver_uuid: driver.uuid,
                amount:      parsedAmount,
                new_balance: result.newBalance,
                reference,
            },
        });
    } catch (error) {
        console.error('❌ [PARTNER] topupDriver error:', error.message);
        return res.status(error.status || 500).json({ success: false, message: error.status ? error.message : 'Unable to top up this driver.', code: 'TOPUP_FAILED' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/partner/dashboard — fleet KPIs
// ═══════════════════════════════════════════════════════════════════════════
exports.dashboard = async (req, res) => {
    try {
        const partnerUuid = req.user.uuid;

        const fleet = await Account.findAll({
            where:      { partner_id: partnerUuid, user_type: 'DRIVER', status: { [Op.ne]: 'DELETED' } },
            attributes: ['uuid', 'status', 'first_name', 'last_name'],
        });
        const driverIds = fleet.map(d => d.uuid);

        if (driverIds.length === 0) {
            return res.json({
                success: true,
                data: {
                    fleet: { total: 0, active: 0, suspended: 0, online: 0 },
                    trips: { today: 0, this_week: 0, this_month: 0, all_time: 0 },
                    earnings: { gross_all_time: 0, gross_this_month: 0, commission_paid: 0 },
                    wallets: { total_balance: 0 },
                    top_driver: null,
                },
            });
        }

        const now        = new Date();
        const dayStart   = new Date(now); dayStart.setHours(0, 0, 0, 0);
        const weekStart  = new Date(now); weekStart.setDate(now.getDate() - ((now.getDay() || 7) - 1)); weekStart.setHours(0, 0, 0, 0);
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

        const completed = (extra = {}) => ({ driverId: { [Op.in]: driverIds }, status: 'COMPLETED', ...extra });

        const [profiles, wallets, allAgg, monthAgg, tToday, tWeek, commissionAgg, topAgg] = await Promise.all([
            DriverProfile.findAll({ where: { account_id: { [Op.in]: driverIds } }, attributes: ['account_id', 'status'] }),
            DriverWallet.findAll({ where: { driverId: { [Op.in]: driverIds } }, attributes: [[fn('SUM', col('balance')), 'total']], raw: true }),
            Trip.findAll({ where: completed(), attributes: [[fn('COUNT', col('id')), 'n'], [fn('SUM', col('fareFinal')), 'gross']], raw: true }),
            Trip.findAll({ where: completed({ tripCompletedAt: { [Op.gte]: monthStart } }), attributes: [[fn('COUNT', col('id')), 'n'], [fn('SUM', col('fareFinal')), 'gross']], raw: true }),
            Trip.count({ where: completed({ tripCompletedAt: { [Op.gte]: dayStart } }) }),
            Trip.count({ where: completed({ tripCompletedAt: { [Op.gte]: weekStart } }) }),
            DriverWalletTransaction.findAll({
                where:      { driverId: { [Op.in]: driverIds }, type: 'COMMISSION' },
                attributes: [[fn('SUM', col('amount')), 'commission']],
                raw: true,
            }),
            Trip.findAll({
                where:      completed({ tripCompletedAt: { [Op.gte]: monthStart } }),
                attributes: ['driverId', [fn('COUNT', col('id')), 'trips']],
                group:      ['driverId'],
                order:      [[literal('trips'), 'DESC']],
                limit:      1,
                raw:        true,
            }),
        ]);

        const onlineCount = profiles.filter(p => p.status === 'online').length;
        const nameByUuid  = new Map(fleet.map(d => [d.uuid, `${d.first_name} ${d.last_name}`.trim()]));
        const top         = topAgg[0] || null;

        return res.json({
            success: true,
            data: {
                fleet: {
                    total:     fleet.length,
                    active:    fleet.filter(d => d.status === 'ACTIVE').length,
                    suspended: fleet.filter(d => d.status === 'SUSPENDED').length,
                    online:    onlineCount,
                },
                trips: {
                    today:      tToday,
                    this_week:  tWeek,
                    this_month: parseInt(monthAgg[0]?.n || 0, 10),
                    all_time:   parseInt(allAgg[0]?.n || 0, 10),
                },
                earnings: {
                    gross_all_time:   parseInt(allAgg[0]?.gross || 0, 10),
                    gross_this_month: parseInt(monthAgg[0]?.gross || 0, 10),
                    commission_paid:  Math.abs(parseInt(commissionAgg[0]?.commission || 0, 10)),
                },
                wallets: { total_balance: parseFloat(wallets[0]?.total || 0) },
                top_driver: top ? {
                    uuid:  top.driverId,
                    name:  nameByUuid.get(top.driverId) || 'Driver',
                    trips_this_month: parseInt(top.trips, 10),
                } : null,
            },
        });
    } catch (error) {
        console.error('❌ [PARTNER] dashboard error:', error.message);
        return res.status(500).json({ success: false, message: 'Unable to load your dashboard.', code: 'DASHBOARD_FAILED' });
    }
};
