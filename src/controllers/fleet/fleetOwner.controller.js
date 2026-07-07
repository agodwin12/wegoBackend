// src/controllers/fleet/fleetOwner.controller.js
//
// ═══════════════════════════════════════════════════════════════════════════
// FLEET-OWNER API
// ═══════════════════════════════════════════════════════════════════════════
//
// A FLEET_OWNER account (created by the company in the backoffice) manages a
// fleet of drivers it fully owns:
//
//   • create driver accounts (no OTP — the fleet owner vouches; the driver gets
//     credentials and behaves EXACTLY like a self-registered driver after:
//     same app, same matching, same tier rules, same wallet)
//   • suspend / reactivate (suspended drivers cannot log in)
//   • delete a driver
//   • top up a driver's wallet (same direct-credit flow drivers use today,
//     ledger marked initiatedBy: 'fleet_owner')
//   • per-driver stats + fleet-level KPIs
//
// SECURITY: every driver-scoped endpoint verifies the driver belongs to the
// requesting fleet owner (accounts.fleet_owner_id === req.user.uuid). A fleet owner can
// never see or touch another fleet owner's — or an independent — driver.
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
const campayService = require('../../services/campay/campayService');
const { uploadFileToR2 } = require('../../middleware/upload');

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
// Min is 25 XAF so the CamPay DEMO sandbox (which caps transactions at 25 XAF)
// can be exercised end-to-end. Raise back to 500 for production.
const MIN_TOPUP_XAF = parseInt(process.env.MIN_TOPUP_XAF || '25', 10);
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

// ── Ownership guard: load a driver THIS fleet owner owns, or 404 ─────────────────
async function loadOwnedDriver(ownerUuid, driverUuid) {
    return Account.findOne({
        where: {
            uuid:       driverUuid,
            user_type:  'DRIVER',
            fleet_owner_id: ownerUuid,
            status:     { [Op.ne]: 'DELETED' },  // soft-deleted = gone
        },
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/fleet/drivers — create a fleet driver
// ═══════════════════════════════════════════════════════════════════════════
exports.createDriver = async (req, res) => {
    const ownerUuid = req.user.uuid;

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
                status:         'ACTIVE',       // fleet owner is company-vetted → driver active immediately
                email_verified: true,
                phone_verified: true,
                fleet_owner_id:     ownerUuid,    // fleet ownership
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
                verification_state: 'VERIFIED',      // vetted by the fleet owner
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

            console.log(`✅ [FLEET] Driver created: ${driverUuid} (fleet owner ${ownerUuid})`);

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
        console.error('❌ [FLEET] createDriver error:', error.message);
        return res.status(500).json({ success: false, message: 'Unable to create the driver. Please try again.', code: 'DRIVER_CREATE_FAILED' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/fleet/drivers — fleet list (with per-driver quick stats)
// ═══════════════════════════════════════════════════════════════════════════
exports.listDrivers = async (req, res) => {
    try {
        const ownerUuid = req.user.uuid;
        const page   = Math.max(1, parseInt(req.query.page  || '1', 10));
        const limit  = Math.min(100, Math.max(5, parseInt(req.query.limit || '25', 10)));
        const offset = (page - 1) * limit;

        const { count, rows } = await Account.findAndCountAll({
            where:      { fleet_owner_id: ownerUuid, user_type: 'DRIVER', status: { [Op.ne]: 'DELETED' } },
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
        console.error('❌ [FLEET] listDrivers error:', error.message);
        return res.status(500).json({ success: false, message: 'Unable to load your drivers.', code: 'FLEET_LIST_FAILED' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/fleet/drivers/:uuid — driver detail + full stats
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
        console.error('❌ [FLEET] getDriver error:', error.message);
        return res.status(500).json({ success: false, message: 'Unable to load this driver.', code: 'DRIVER_DETAIL_FAILED' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/fleet/drivers/:uuid/trips — paginated trip history for one driver
// Scoped to the owner's driver; the fleet owner sees every trip + its details.
// ═══════════════════════════════════════════════════════════════════════════
exports.getDriverTrips = async (req, res) => {
    try {
        const driver = await loadOwnedDriver(req.user.uuid, req.params.uuid);
        if (!driver) return res.status(404).json({ success: false, message: 'Driver not found in your fleet.', code: 'DRIVER_NOT_FOUND' });

        const page   = Math.max(1, parseInt(req.query.page)  || 1);
        const limit  = Math.min(50, parseInt(req.query.limit) || 20);
        const offset = (page - 1) * limit;

        const where = { driverId: driver.uuid };
        if (req.query.status) where.status = String(req.query.status).toUpperCase();

        const { count, rows } = await Trip.findAndCountAll({
            where,
            order:      [['createdAt', 'DESC']],
            limit,
            offset,
            attributes: [
                'id', 'status', 'pickupAddress', 'dropoffAddress',
                'fareFinal', 'paymentMethod', 'vehicleType',
                'distanceM', 'canceledBy', 'tripCompletedAt', 'createdAt',
            ],
        });

        return res.json({
            success: true,
            data: {
                trips: rows.map(t => ({
                    id:             t.id,
                    status:         t.status,
                    pickup:         t.pickupAddress,
                    dropoff:        t.dropoffAddress,
                    fare:           t.fareFinal != null ? parseInt(t.fareFinal, 10) : null,
                    payment_method: t.paymentMethod || null,
                    vehicle_type:   t.vehicleType || null,
                    distance_km:    t.distanceM != null ? Math.round(parseFloat(t.distanceM) / 100) / 10 : null,
                    canceled_by:    t.canceledBy || null,
                    completed_at:   t.tripCompletedAt,
                    created_at:     t.createdAt,
                })),
            },
            meta: { total: count, page, limit, totalPages: Math.ceil(count / limit) },
        });
    } catch (error) {
        console.error('❌ [FLEET] getDriverTrips error:', error.message);
        return res.status(500).json({ success: false, message: 'Unable to load trips for this driver.', code: 'DRIVER_TRIPS_FAILED' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/fleet/drivers/:uuid/avatar — upload a photo for a fleet driver
// multipart/form-data, field name "avatar". Stored in R2, set on accounts.avatar_url.
// ═══════════════════════════════════════════════════════════════════════════
exports.uploadDriverAvatar = async (req, res) => {
    try {
        const driver = await loadOwnedDriver(req.user.uuid, req.params.uuid);
        if (!driver) return res.status(404).json({ success: false, message: 'Driver not found in your fleet.', code: 'DRIVER_NOT_FOUND' });

        if (!req.file || !req.file.buffer) {
            return res.status(400).json({ success: false, message: 'An image file is required (field "avatar").', code: 'NO_FILE' });
        }

        const url = await uploadFileToR2(req.file, 'profiles');
        await Account.update({ avatar_url: url }, { where: { uuid: driver.uuid } });

        console.log(`🖼️  [FLEET] avatar updated for driver ${driver.uuid} by fleet owner ${req.user.uuid}`);
        return res.json({ success: true, message: 'Driver photo updated.', data: { avatar_url: url } });
    } catch (error) {
        console.error('❌ [FLEET] uploadDriverAvatar error:', error.message);
        return res.status(500).json({ success: false, message: 'Unable to upload the photo. Please try again.', code: 'AVATAR_UPLOAD_FAILED' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// PATCH /api/fleet/drivers/:uuid/suspend | /reactivate
// Suspended accounts are rejected by the login flow — driver cannot log in.
// ═══════════════════════════════════════════════════════════════════════════
exports.suspendDriver = async (req, res) => {
    try {
        const driver = await loadOwnedDriver(req.user.uuid, req.params.uuid);
        if (!driver) return res.status(404).json({ success: false, message: 'Driver not found in your fleet.', code: 'DRIVER_NOT_FOUND' });

        driver.status = 'SUSPENDED';
        await driver.save();
        console.log(`⛔ [FLEET] Driver ${driver.uuid} suspended by fleet owner ${req.user.uuid}`);
        return res.json({ success: true, message: 'Driver suspended — they can no longer log in or receive rides.', data: { uuid: driver.uuid, status: driver.status } });
    } catch (error) {
        console.error('❌ [FLEET] suspendDriver error:', error.message);
        return res.status(500).json({ success: false, message: 'Unable to suspend this driver.', code: 'SUSPEND_FAILED' });
    }
};

exports.reactivateDriver = async (req, res) => {
    try {
        const driver = await loadOwnedDriver(req.user.uuid, req.params.uuid);
        if (!driver) return res.status(404).json({ success: false, message: 'Driver not found in your fleet.', code: 'DRIVER_NOT_FOUND' });

        driver.status = 'ACTIVE';
        await driver.save();
        console.log(`✅ [FLEET] Driver ${driver.uuid} reactivated by fleet owner ${req.user.uuid}`);
        return res.json({ success: true, message: 'Driver reactivated — they can log in and receive rides again.', data: { uuid: driver.uuid, status: driver.status } });
    } catch (error) {
        console.error('❌ [FLEET] reactivateDriver error:', error.message);
        return res.status(500).json({ success: false, message: 'Unable to reactivate this driver.', code: 'REACTIVATE_FAILED' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// DELETE /api/fleet/drivers/:uuid
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
            console.log(`🗑️  [FLEET] Driver ${driver.uuid} soft-deleted (has ${tripCount} trips) by fleet owner ${req.user.uuid}`);
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

        console.log(`🗑️  [FLEET] Driver ${req.params.uuid} hard-deleted by fleet owner ${req.user.uuid}`);
        return res.json({ success: true, message: 'Driver account deleted.', data: { uuid: req.params.uuid, mode: 'hard' } });
    } catch (error) {
        console.error('❌ [FLEET] deleteDriver error:', error.message);
        return res.status(500).json({ success: false, message: 'Unable to delete this driver.', code: 'DELETE_FAILED' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/fleet/drivers/:uuid/topup — top up a driver's wallet via CamPay
//
// REAL MONEY FLOW. The fleet owner pays with their own MTN MoMo / Orange Money
// number; CamPay collects from that number, and the driver's wallet is credited
// ONLY when CamPay confirms the collection SUCCESSFUL (via webhook or status
// poll). If the collection fails or is cancelled, nothing is credited.
//
//   1. Validate amount + payer phone
//   2. Create a PENDING DriverWalletTransaction (type=TOP_UP, topUpStatus=PENDING).
//      The wallet balance is NOT touched yet.
//   3. Call campayService.initiateCollection(vertical='fleet_topup', verticalId=txn.id).
//   4. Return { pending, campayRef, ussdCode } — the UI polls the payment status.
//   5. _finalizeFleetTopUp (webhook/poll) credits the wallet on SUCCESSFUL,
//      or marks the transaction topUpStatus=FAILED on FAILED.
// ═══════════════════════════════════════════════════════════════════════════
exports.topupDriver = async (req, res) => {
    let pendingTxn = null;
    try {
        const ownerUuid = req.user.uuid;
        const driver = await loadOwnedDriver(ownerUuid, req.params.uuid);
        if (!driver) return res.status(404).json({ success: false, message: 'Driver not found in your fleet.', code: 'DRIVER_NOT_FOUND' });

        const { amount, method, phone, note } = req.body;

        // ── Payer phone (the MoMo/OM number CamPay will charge) ────────────────
        if (!phone || !String(phone).trim()) {
            return res.status(400).json({ success: false, message: 'A mobile money phone number to charge is required.', code: 'MISSING_PHONE' });
        }

        // topUpMethod records the channel for audit only. CamPay auto-detects the
        // operator from the number; we only accept the mobile-money channels here.
        const VALID_TOPUP_METHODS = ['MTN_MOMO', 'ORANGE_MONEY'];
        const topUpMethod = VALID_TOPUP_METHODS.includes(method) ? method : null;

        const parsedAmount = parseInt(amount, 10);
        if (!parsedAmount || parsedAmount <= 0) {
            return res.status(400).json({ success: false, message: 'amount is required and must be a positive integer.', code: 'INVALID_AMOUNT' });
        }
        if (parsedAmount < MIN_TOPUP_XAF) return res.status(400).json({ success: false, message: `Minimum top-up is ${MIN_TOPUP_XAF} XAF.`, code: 'AMOUNT_TOO_LOW' });
        if (parsedAmount > MAX_TOPUP_XAF) return res.status(400).json({ success: false, message: `Maximum top-up is ${MAX_TOPUP_XAF} XAF.`, code: 'AMOUNT_TOO_HIGH' });

        // ── Ensure the driver's wallet exists and is active ────────────────────
        const [wallet] = await DriverWallet.findOrCreate({
            where:    { driverId: driver.uuid },
            defaults: { driverId: driver.uuid, balance: 0, status: 'ACTIVE', currency: 'XAF' },
        });
        if (wallet.status !== 'ACTIVE') {
            return res.status(403).json({ success: false, message: 'This driver\'s wallet is not active. Contact support.', code: 'WALLET_INACTIVE' });
        }

        // ── Idempotency: reuse an existing pending fleet top-up for the same
        //    driver + amount created in the last 10 minutes (double-tap guard). ─
        const recentCutoff = new Date(Date.now() - 10 * 60 * 1000);
        const existing = await DriverWalletTransaction.findOne({
            where: {
                driverId:    driver.uuid,
                type:        'TOP_UP',
                topUpStatus: 'PENDING',
                amount:      parsedAmount,
                createdAt:   { [Op.gte]: recentCutoff },
            },
            order: [['createdAt', 'DESC']],
        });
        if (existing && existing.topUpRef) {
            return res.status(200).json({
                success: true,
                pending: true,
                resumed: true,
                message: 'A top-up is already awaiting confirmation for this driver. Check the phone.',
                data: { driver_uuid: driver.uuid, amount: parsedAmount, campay_ref: existing.topUpRef, transaction_id: existing.id },
            });
        }

        // ── Step 1: create the PENDING ledger row BEFORE calling CamPay ────────
        // balanceAfter is a placeholder (current balance); it is finalised to the
        // real post-credit balance only when the collection succeeds.
        const currentBalance = parseInt(wallet.balance, 10) || 0;
        pendingTxn = await DriverWalletTransaction.create({
            id:           uuidv4(),
            driverId:     driver.uuid,
            walletId:     wallet.id,
            type:         'TOP_UP',
            amount:       parsedAmount,
            balanceAfter: currentBalance,           // placeholder until credited
            description:  `Fleet top-up via CamPay — ${parsedAmount.toLocaleString()} XAF${note ? ` (${note})` : ''}`,
            reference:    `TOP_UP:FLEET:${uuidv4()}`,
            topUpMethod,
            topUpRef:     null,                     // set to campay_ref after initiation
            topUpStatus:  'PENDING',
            metadata: {
                initiatedBy: 'fleet_owner',
                partnerId:   ownerUuid,
                driverId:    driver.uuid,
                phone:       String(phone),
                note:        note || null,
            },
            createdAt: new Date(),
        });

        // ── Step 2: initiate the CamPay collection from the partner's number ───
        let campayResult;
        try {
            campayResult = await campayService.initiateCollection({
                vertical:    'fleet_topup',
                verticalId:  pendingTxn.id,
                phone,
                initiatedBy: ownerUuid,
            });
        } catch (campayErr) {
            // Collection could not even be started — mark FAILED, credit nothing.
            await pendingTxn.update({ topUpStatus: 'FAILED', description: `${pendingTxn.description} — CamPay init failed` }).catch(() => {});
            console.error('❌ [FLEET] topupDriver CamPay init failed:', campayErr.message);
            const clean = campayErr.message?.replace('[CAMPAY SERVICE] ', '') || 'Could not start the mobile money payment.';
            return res.status(502).json({ success: false, message: clean, code: 'CAMPAY_INIT_FAILED' });
        }

        // ── Step 3: store the campay_ref for webhook/poll correlation ──────────
        await pendingTxn.update({ topUpRef: campayResult.campayRef });

        console.log(`💳 [FLEET] Top-up initiated — ${parsedAmount} XAF for driver ${driver.uuid} by ${ownerUuid} | campay_ref ${campayResult.campayRef}`);

        return res.status(200).json({
            success: true,
            pending: true,
            message: 'Payment initiated. Approve the prompt on the phone to complete the top-up.',
            data: {
                driver_uuid:    driver.uuid,
                amount:         parsedAmount,
                campay_ref:     campayResult.campayRef,
                ussd_code:      campayResult.ussdCode || null,
                operator:       campayResult.operator || null,
                transaction_id: pendingTxn.id,
            },
        });
    } catch (error) {
        console.error('❌ [FLEET] topupDriver error:', error.message);
        if (pendingTxn) { await pendingTxn.update({ topUpStatus: 'FAILED' }).catch(() => {}); }
        return res.status(error.status || 500).json({ success: false, message: error.status ? error.message : 'Unable to start the top-up.', code: 'TOPUP_FAILED' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/fleet/dashboard — fleet KPIs
// ═══════════════════════════════════════════════════════════════════════════
exports.dashboard = async (req, res) => {
    try {
        const ownerUuid = req.user.uuid;

        const fleet = await Account.findAll({
            where:      { fleet_owner_id: ownerUuid, user_type: 'DRIVER', status: { [Op.ne]: 'DELETED' } },
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
                    series: [],
                },
            });
        }

        const now        = new Date();
        const dayStart   = new Date(now); dayStart.setHours(0, 0, 0, 0);
        const weekStart  = new Date(now); weekStart.setDate(now.getDate() - ((now.getDay() || 7) - 1)); weekStart.setHours(0, 0, 0, 0);
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

        const completed = (extra = {}) => ({ driverId: { [Op.in]: driverIds }, status: 'COMPLETED', ...extra });

        // 14-day window for the trend charts.
        const seriesStart = new Date(now); seriesStart.setHours(0, 0, 0, 0); seriesStart.setDate(seriesStart.getDate() - 13);

        const [profiles, wallets, allAgg, monthAgg, tToday, tWeek, commissionAgg, topAgg, tripsByDay, topupsByDay] = await Promise.all([
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
            // Trips per day (last 14 days)
            Trip.findAll({
                where:      completed({ tripCompletedAt: { [Op.gte]: seriesStart } }),
                attributes: [[fn('DATE', col('tripCompletedAt')), 'd'], [fn('COUNT', col('id')), 'n'], [fn('SUM', col('fareFinal')), 'gross']],
                group:      [literal('d')],
                raw:        true,
            }),
            // Top-ups credited per day (last 14 days)
            DriverWalletTransaction.findAll({
                where:      { driverId: { [Op.in]: driverIds }, type: 'TOP_UP', topUpStatus: 'COMPLETED', createdAt: { [Op.gte]: seriesStart } },
                attributes: [[fn('DATE', col('createdAt')), 'd'], [fn('SUM', col('amount')), 'amt']],
                group:      [literal('d')],
                raw:        true,
            }),
        ]);

        const onlineCount = profiles.filter(p => p.status === 'online').length;
        const nameByUuid  = new Map(fleet.map(d => [d.uuid, `${d.first_name} ${d.last_name}`.trim()]));
        const top         = topAgg[0] || null;

        // Build a contiguous 14-day series (zero-filled) for the charts.
        // Use LOCAL date components (not toISOString/UTC) so the keys line up with
        // MySQL DATE(createdAt) of DATETIME values and today's data isn't shifted.
        const fmt = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
        const tripsMap = new Map(tripsByDay.map(r => [String(r.d).slice(0, 10), r]));
        const topupMap = new Map(topupsByDay.map(r => [String(r.d).slice(0, 10), r]));
        const series = [];
        for (let i = 0; i < 14; i++) {
            const dt = new Date(seriesStart); dt.setDate(seriesStart.getDate() + i);
            const key = fmt(dt);
            series.push({
                date:     key,
                trips:    parseInt(tripsMap.get(key)?.n || 0, 10),
                gross:    parseInt(tripsMap.get(key)?.gross || 0, 10),
                topups:   parseInt(topupMap.get(key)?.amt || 0, 10),
            });
        }

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
                series,
            },
        });
    } catch (error) {
        console.error('❌ [FLEET] dashboard error:', error.message);
        return res.status(500).json({ success: false, message: 'Unable to load your dashboard.', code: 'DASHBOARD_FAILED' });
    }
};

// Helper: resolve the fleet owner's driver uuids + a name/avatar lookup map.
async function loadFleetIndex(ownerUuid) {
    const fleet = await Account.findAll({
        where:      { fleet_owner_id: ownerUuid, user_type: 'DRIVER', status: { [Op.ne]: 'DELETED' } },
        attributes: ['uuid', 'first_name', 'last_name', 'avatar_url'],
    });
    const ids     = fleet.map(d => d.uuid);
    const byUuid  = new Map(fleet.map(d => [d.uuid, { name: `${d.first_name} ${d.last_name}`.trim(), avatar_url: d.avatar_url }]));
    return { fleet, ids, byUuid };
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/fleet/trips — every trip across the whole fleet, with filters
// Query: driver_uuid, status, from (YYYY-MM-DD), to, page, limit
// ═══════════════════════════════════════════════════════════════════════════
exports.getFleetTrips = async (req, res) => {
    try {
        const { ids, byUuid } = await loadFleetIndex(req.user.uuid);
        if (ids.length === 0) return res.json({ success: true, data: { trips: [], drivers: [] }, meta: { total: 0, page: 1, limit: 20, totalPages: 0 } });

        const page   = Math.max(1, parseInt(req.query.page)  || 1);
        const limit  = Math.min(50, parseInt(req.query.limit) || 20);

        const where = { driverId: { [Op.in]: ids } };
        if (req.query.driver_uuid && byUuid.has(req.query.driver_uuid)) where.driverId = req.query.driver_uuid;
        if (req.query.status) where.status = String(req.query.status).toUpperCase();
        const dateFilter = {};
        if (req.query.from) dateFilter[Op.gte] = new Date(req.query.from);
        if (req.query.to)   { const t = new Date(req.query.to); t.setHours(23, 59, 59, 999); dateFilter[Op.lte] = t; }
        if (Object.getOwnPropertySymbols(dateFilter).length) where.createdAt = dateFilter;

        const { count, rows } = await Trip.findAndCountAll({
            where,
            order:      [['createdAt', 'DESC']],
            limit,
            offset:     (page - 1) * limit,
            attributes: ['id', 'driverId', 'status', 'pickupAddress', 'dropoffAddress', 'fareFinal', 'paymentMethod', 'vehicleType', 'distanceM', 'canceledBy', 'tripCompletedAt', 'createdAt'],
        });

        return res.json({
            success: true,
            data: {
                trips: rows.map(t => ({
                    id:             t.id,
                    driver_uuid:    t.driverId,
                    driver_name:    byUuid.get(t.driverId)?.name || 'Driver',
                    status:         t.status,
                    pickup:         t.pickupAddress,
                    dropoff:        t.dropoffAddress,
                    fare:           t.fareFinal != null ? parseInt(t.fareFinal, 10) : null,
                    payment_method: t.paymentMethod || null,
                    vehicle_type:   t.vehicleType || null,
                    distance_km:    t.distanceM != null ? Math.round(parseFloat(t.distanceM) / 100) / 10 : null,
                    completed_at:   t.tripCompletedAt,
                    created_at:     t.createdAt,
                })),
                // Driver list for the filter dropdown
                drivers: [...byUuid.entries()].map(([uuid, d]) => ({ uuid, name: d.name })),
            },
            meta: { total: count, page, limit, totalPages: Math.ceil(count / limit) },
        });
    } catch (error) {
        console.error('❌ [FLEET] getFleetTrips error:', error.message);
        return res.status(500).json({ success: false, message: 'Unable to load trips.', code: 'FLEET_TRIPS_FAILED' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/fleet/topups — every wallet top-up the fleet owner made, per driver
// Query: driver_uuid, status (PENDING|COMPLETED|FAILED), page, limit
// ═══════════════════════════════════════════════════════════════════════════
exports.getFleetTopups = async (req, res) => {
    try {
        const { ids, byUuid } = await loadFleetIndex(req.user.uuid);
        if (ids.length === 0) return res.json({ success: true, data: { topups: [], drivers: [], summary: { total_credited: 0, count: 0 } }, meta: { total: 0, page: 1, limit: 20, totalPages: 0 } });

        const page  = Math.max(1, parseInt(req.query.page)  || 1);
        const limit = Math.min(50, parseInt(req.query.limit) || 20);

        // Only top-ups initiated by the fleet owner (reference marks the source).
        const where = {
            driverId:  { [Op.in]: ids },
            type:      'TOP_UP',
            reference: { [Op.or]: [{ [Op.like]: 'TOP_UP:FLEET:%' }, { [Op.like]: 'TOP_UP:PARTNER:%' }] },
        };
        if (req.query.driver_uuid && byUuid.has(req.query.driver_uuid)) where.driverId = req.query.driver_uuid;
        if (req.query.status) where.topUpStatus = String(req.query.status).toUpperCase();

        const { count, rows } = await DriverWalletTransaction.findAndCountAll({
            where,
            order:      [['createdAt', 'DESC']],
            limit,
            offset:     (page - 1) * limit,
            attributes: ['id', 'driverId', 'amount', 'topUpMethod', 'topUpStatus', 'topUpRef', 'metadata', 'description', 'createdAt'],
        });

        // Summary: total successfully credited (all-time, this owner).
        const [summaryRow] = await DriverWalletTransaction.findAll({
            where:      { driverId: (where.driverId), type: 'TOP_UP', topUpStatus: 'COMPLETED', reference: where.reference },
            attributes: [[fn('SUM', col('amount')), 'total'], [fn('COUNT', col('id')), 'n']],
            raw: true,
        });

        return res.json({
            success: true,
            data: {
                topups: rows.map(t => ({
                    id:          t.id,
                    driver_uuid: t.driverId,
                    driver_name: byUuid.get(t.driverId)?.name || 'Driver',
                    amount:      parseInt(t.amount, 10),
                    method:      t.topUpMethod || null,
                    status:      t.topUpStatus || 'COMPLETED',
                    phone:       t.metadata?.phone || null,
                    campay_ref:  t.topUpRef || null,
                    created_at:  t.createdAt,
                })),
                drivers: [...byUuid.entries()].map(([uuid, d]) => ({ uuid, name: d.name })),
                summary: { total_credited: parseInt(summaryRow?.total || 0, 10), count: parseInt(summaryRow?.n || 0, 10) },
            },
            meta: { total: count, page, limit, totalPages: Math.ceil(count / limit) },
        });
    } catch (error) {
        console.error('❌ [FLEET] getFleetTopups error:', error.message);
        return res.status(500).json({ success: false, message: 'Unable to load top-ups.', code: 'FLEET_TOPUPS_FAILED' });
    }
};
