// src/controllers/backoffice/driverController.js
'use strict';

const Account       = require('../../models/Account');
const DriverProfile = require('../../models/DriverProfile');
const Trip          = require('../../models/Trip');
const { DriverWallet } = require('../../models');
const { Op }        = require('sequelize');
const sequelize     = require('../../config/database');
const bcrypt        = require('bcrypt');
const { v4: uuidv4 } = require('uuid');

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
const RIDE_TIERS = { economy: 'Economy', comfort: 'Comfort', luxury: 'Luxury' };
function normalizeTier(raw) {
    return RIDE_TIERS[String(raw || '').toLowerCase()] || 'Economy';
}

// ── Notification service (lazy — avoids circular dep at startup) ──────────────
const getNotificationService = () => require('../../services/NotificationService');

// ═══════════════════════════════════════════════════════════════════════
// CREATE DRIVER — backoffice onboards a ride-hailing driver directly
// POST /api/backoffice/drivers
// ═══════════════════════════════════════════════════════════════════════
exports.createDriver = async (req, res) => {
    try {
        const {
            first_name, last_name, email, phone_e164, password,
            civility, birth_date,
            cni_number, license_number, license_expiry,
            insurance_number, insurance_expiry,
            vehicle_type, vehicle_make_model, vehicle_color, vehicle_year, vehicle_plate,
            fleet_owner_id,
        } = req.body || {};

        // ── Required fields ──────────────────────────────────────────────
        const required = { first_name, last_name, email, phone_e164, password, vehicle_plate };
        for (const [k, v] of Object.entries(required)) {
            if (!v || !String(v).trim()) {
                return res.status(400).json({ success: false, message: `${k.replace(/_/g, ' ')} is required`, code: 'MISSING_FIELD' });
            }
        }
        if (String(password).length < 8) {
            return res.status(400).json({ success: false, message: 'Password must be at least 8 characters', code: 'WEAK_PASSWORD' });
        }

        // ── Uniqueness ───────────────────────────────────────────────────
        if (await Account.findOne({ where: { email } }))            return res.status(409).json({ success: false, message: 'This email is already registered', code: 'EMAIL_EXISTS' });
        if (await Account.findOne({ where: { phone_e164 } }))       return res.status(409).json({ success: false, message: 'This phone number is already registered', code: 'PHONE_EXISTS' });
        if (await DriverProfile.findOne({ where: { vehicle_plate } })) return res.status(409).json({ success: false, message: 'This vehicle plate is already registered', code: 'PLATE_EXISTS' });

        // ── Optional fleet-owner assignment ──────────────────────────────
        let ownerId = null;
        if (fleet_owner_id) {
            const owner = await Account.findOne({ where: { uuid: fleet_owner_id, user_type: 'FLEET_OWNER' } });
            if (!owner) return res.status(400).json({ success: false, message: 'Selected fleet owner not found', code: 'FLEET_OWNER_NOT_FOUND' });
            ownerId = owner.uuid;
        }

        const password_hash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
        const driverUuid    = uuidv4();

        // ── Account + profile + wallet, atomically (mirrors the signup path) ─
        const t = await sequelize.transaction();
        try {
            await Account.create({
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
                status:         'ACTIVE',       // backoffice-vetted → active immediately
                email_verified: true,
                phone_verified: true,
                fleet_owner_id: ownerId,
            }, { transaction: t });

            await DriverProfile.create({
                account_id:         driverUuid,
                cni_number:         cni_number       || null,
                license_number:     license_number   || null,
                license_expiry:     license_expiry   || null,
                insurance_number:   insurance_number || null,
                insurance_expiry:   insurance_expiry || null,
                vehicle_type:       normalizeTier(vehicle_type),
                vehicle_make_model: vehicle_make_model || null,
                vehicle_color:      vehicle_color      || null,
                vehicle_year:       vehicle_year ? parseInt(vehicle_year, 10) : null,
                vehicle_plate,
                verification_state: 'VERIFIED',   // created by an admin → vetted
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
        } catch (e) {
            await t.rollback();
            throw e;
        }

        console.log(`✅ [DRIVER_ADMIN] Driver created: ${driverUuid} by employee ${req.user?.id}`);
        return res.status(201).json({
            success: true,
            message: 'Driver created. Share the login credentials — the driver can change the password in the app.',
            data: { driver: { uuid: driverUuid, first_name, last_name, email, phone_e164, status: 'ACTIVE' } },
        });

    } catch (error) {
        console.error('❌ [DRIVER_ADMIN] createDriver:', error);
        return res.status(500).json({ success: false, message: 'Unable to create driver. Please try again.', code: 'DRIVER_CREATE_FAILED' });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET ALL DRIVERS
// ═══════════════════════════════════════════════════════════════════════

exports.getAllDrivers = async (req, res) => {
    try {
        const {
            page = 1, limit = 10,
            search = '', status = '', verification_state = '',
            sortBy = 'created_at', sortOrder = 'DESC',
        } = req.query;

        const offset       = (parseInt(page) - 1) * parseInt(limit);
        const accountWhere = { user_type: 'DRIVER' };

        if (search) {
            accountWhere[Op.or] = [
                { first_name: { [Op.like]: `%${search}%` } },
                { last_name:  { [Op.like]: `%${search}%` } },
                { email:      { [Op.like]: `%${search}%` } },
                { phone_e164: { [Op.like]: `%${search}%` } },
            ];
        }

        if (status) accountWhere.status = status;

        const profileWhere = {};
        if (verification_state) profileWhere.verification_state = verification_state;

        const { count, rows: drivers } = await Account.findAndCountAll({
            where:   accountWhere,
            include: [
                {
                    model:      DriverProfile,
                    as:         'driver_profile',
                    where:      Object.keys(profileWhere).length > 0 ? profileWhere : undefined,
                    required:   true,
                    attributes: [
                        'verification_state', 'rating_avg', 'rating_count',
                        'vehicle_make_model', 'vehicle_plate', 'vehicle_color',
                        'status', 'license_number', 'vehicle_photo_url',
                    ],
                },
            ],
            order:  [[sortBy, sortOrder]],
            limit:  parseInt(limit),
            offset,
        });

        const driversWithStats = await Promise.all(
            drivers.map(async (driver) => {
                const [tripCount, completedTrips] = await Promise.all([
                    Trip.count({ where: { driverId: driver.uuid } }),
                    Trip.count({ where: { driverId: driver.uuid, status: 'COMPLETED' } }),
                ]);

                const d = driver.toJSON();
                return {
                    uuid:              d.uuid,
                    first_name:        d.first_name,
                    last_name:         d.last_name,
                    email:             d.email,
                    phone_e164:        d.phone_e164,
                    phone_verified:    d.phone_verified,
                    email_verified:    d.email_verified,
                    avatar_url:        d.avatar_url,
                    status:            d.status,
                    created_at:        d.created_at,
                    updated_at:        d.updated_at,
                    verification_state: d.driver_profile.verification_state,
                    rating_avg:         d.driver_profile.rating_avg,
                    rating_count:       d.driver_profile.rating_count,
                    vehicle_make_model: d.driver_profile.vehicle_make_model,
                    vehicle_plate:      d.driver_profile.vehicle_plate,
                    vehicle_color:      d.driver_profile.vehicle_color,
                    driver_status:      d.driver_profile.status,
                    trip_count:         tripCount,
                    completed_trips:    completedTrips,
                };
            })
        );

        console.log(`✅ Fetched ${drivers.length} drivers`);

        return res.status(200).json({
            success:    true,
            data:       driversWithStats,
            pagination: { total: count, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(count / parseInt(limit)) },
        });

    } catch (error) {
        console.error('❌ Error fetching drivers:', error);
        return res.status(500).json({ success: false, message: 'Failed to fetch drivers', error: error.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET SINGLE DRIVER
// ═══════════════════════════════════════════════════════════════════════

exports.getDriverById = async (req, res) => {
    try {
        const { id } = req.params;

        const driver = await Account.findOne({
            where:   { uuid: id, user_type: 'DRIVER' },
            include: [{ model: DriverProfile, as: 'driver_profile', required: true }],
        });

        if (!driver) return res.status(404).json({ success: false, message: 'Driver not found' });

        const tripStats = await Trip.findAll({
            where:      { driverId: id },
            attributes: [
                [sequelize.fn('COUNT', sequelize.col('id')), 'total_trips'],
                [sequelize.fn('SUM', sequelize.literal("CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END")), 'completed_trips'],
                [sequelize.fn('SUM', sequelize.literal("CASE WHEN status = 'CANCELED' THEN 1 ELSE 0 END")),  'canceled_trips'],
                [sequelize.fn('SUM', sequelize.col('fareFinal')), 'total_earned'],
            ],
            raw: true,
        });

        const d = driver.toJSON();
        const p = d.driver_profile;

        console.log(`✅ Fetched driver: ${driver.uuid}`);

        return res.status(200).json({
            success: true,
            driver: {
                uuid: d.uuid, first_name: d.first_name, last_name: d.last_name,
                email: d.email, phone_e164: d.phone_e164, phone_verified: d.phone_verified,
                email_verified: d.email_verified, avatar_url: d.avatar_url, status: d.status,
                civility: d.civility, birth_date: d.birth_date, created_at: d.created_at, updated_at: d.updated_at,
                profile: {
                    cni_number: p.cni_number, license_number: p.license_number,
                    license_expiry: p.license_expiry, license_document_url: p.license_document_url,
                    insurance_number: p.insurance_number, insurance_expiry: p.insurance_expiry,
                    insurance_document_url: p.insurance_document_url, verification_state: p.verification_state,
                    vehicle_type: p.vehicle_type, vehicle_make_model: p.vehicle_make_model,
                    vehicle_color: p.vehicle_color, vehicle_year: p.vehicle_year,
                    vehicle_plate: p.vehicle_plate, vehicle_photo_url: p.vehicle_photo_url,
                    driver_status: p.status, rating_avg: p.rating_avg, rating_count: p.rating_count,
                    current_lat: p.current_lat, current_lng: p.current_lng,
                },
                stats: tripStats[0] || { total_trips: 0, completed_trips: 0, canceled_trips: 0, total_earned: 0 },
            },
        });

    } catch (error) {
        console.error('❌ Error fetching driver:', error);
        return res.status(500).json({ success: false, message: 'Failed to fetch driver details', error: error.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET DRIVER TRIPS
// ═══════════════════════════════════════════════════════════════════════

exports.getDriverTrips = async (req, res) => {
    try {
        const { id }                              = req.params;
        const { page = 1, limit = 10, status = '' } = req.query;
        const offset      = (parseInt(page) - 1) * parseInt(limit);
        const whereClause = { driverId: id };
        if (status) whereClause.status = status;

        const { count, rows: trips } = await Trip.findAndCountAll({
            where:  whereClause,
            order:  [['createdAt', 'DESC']],
            limit:  parseInt(limit),
            offset,
        });

        return res.status(200).json({
            success:    true,
            data:       trips,
            pagination: { total: count, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(count / parseInt(limit)) },
        });

    } catch (error) {
        console.error('❌ Error fetching driver trips:', error);
        return res.status(500).json({ success: false, message: 'Failed to fetch driver trips', error: error.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// APPROVE DRIVER (PENDING → ACTIVE)
// ═══════════════════════════════════════════════════════════════════════

exports.approveDriver = async (req, res) => {
    try {
        const { id } = req.params;

        const driver = await Account.findOne({
            where:   { uuid: id, user_type: 'DRIVER' },
            include: [{ model: DriverProfile, as: 'driver_profile', required: true }],
        });

        if (!driver) return res.status(404).json({ success: false, message: 'Driver not found' });

        await driver.update({ status: 'ACTIVE' });
        await driver.driver_profile.update({ verification_state: 'VERIFIED' });

        console.log(`✅ Approved driver: ${id}`);

        // ── 🔔 NOTIFICATION: Account approved → driver ────────────────────────
        getNotificationService().send({
            accountUuid: id,
            type:        'ACCOUNT_APPROVED',
            title:       '🎉 Your account has been approved!',
            body:        'Congratulations! Your driver account has been verified and activated. You can now go online and start accepting trips.',
            data: { screen: 'home' },
        }).catch(e => console.warn('⚠️  [DRIVER] Approval push failed:', e.message));

        return res.status(200).json({ success: true, message: 'Driver approved and activated successfully' });

    } catch (error) {
        console.error('❌ Error approving driver:', error);
        return res.status(500).json({ success: false, message: 'Failed to approve driver', error: error.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// REJECT DRIVER VERIFICATION
// ═══════════════════════════════════════════════════════════════════════

exports.rejectDriver = async (req, res) => {
    try {
        const { id }     = req.params;
        const { reason } = req.body;

        const driver = await Account.findOne({
            where:   { uuid: id, user_type: 'DRIVER' },
            include: [{ model: DriverProfile, as: 'driver_profile', required: true }],
        });

        if (!driver) return res.status(404).json({ success: false, message: 'Driver not found' });

        await driver.driver_profile.update({ verification_state: 'REJECTED' });

        console.log(`❌ Rejected driver: ${id} | Reason: ${reason || 'Not provided'}`);

        return res.status(200).json({ success: true, message: 'Driver verification rejected' });

    } catch (error) {
        console.error('❌ Error rejecting driver:', error);
        return res.status(500).json({ success: false, message: 'Failed to reject driver', error: error.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// BLOCK DRIVER (ACTIVE → SUSPENDED)
// ═══════════════════════════════════════════════════════════════════════

exports.blockDriver = async (req, res) => {
    try {
        const { id }     = req.params;
        const { reason } = req.body;

        const driver = await Account.findOne({ where: { uuid: id, user_type: 'DRIVER' } });
        if (!driver) return res.status(404).json({ success: false, message: 'Driver not found' });

        await driver.update({ status: 'SUSPENDED' });

        console.log(`🚫 Blocked driver: ${id}`);

        // ── 🔔 NOTIFICATION: Account suspended → driver ───────────────────────
        getNotificationService().send({
            accountUuid: id,
            type:        'ACCOUNT_SUSPENDED',
            title:       'Account suspended',
            body:        reason
                ? `Your account has been suspended. Reason: ${reason}. Please contact support for assistance.`
                : 'Your account has been suspended. Please contact support for assistance.',
            data: { screen: 'support' },
        }).catch(e => console.warn('⚠️  [DRIVER] Suspension push failed:', e.message));

        return res.status(200).json({ success: true, message: 'Driver blocked successfully' });

    } catch (error) {
        console.error('❌ Error blocking driver:', error);
        return res.status(500).json({ success: false, message: 'Failed to block driver', error: error.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// UNBLOCK DRIVER (SUSPENDED → ACTIVE)
// ═══════════════════════════════════════════════════════════════════════

exports.unblockDriver = async (req, res) => {
    try {
        const { id } = req.params;

        const driver = await Account.findOne({ where: { uuid: id, user_type: 'DRIVER' } });
        if (!driver) return res.status(404).json({ success: false, message: 'Driver not found' });

        await driver.update({ status: 'ACTIVE' });

        console.log(`✅ Unblocked driver: ${id}`);

        // ── 🔔 NOTIFICATION: Account reactivated → driver ─────────────────────
        getNotificationService().send({
            accountUuid: id,
            type:        'ACCOUNT_APPROVED',
            title:       '✅ Account reactivated',
            body:        'Your driver account has been reactivated. You can now go online and accept trips again.',
            data: { screen: 'home' },
        }).catch(e => console.warn('⚠️  [DRIVER] Reactivation push failed:', e.message));

        return res.status(200).json({ success: true, message: 'Driver unblocked successfully' });

    } catch (error) {
        console.error('❌ Error unblocking driver:', error);
        return res.status(500).json({ success: false, message: 'Failed to unblock driver', error: error.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// DELETE DRIVER (soft delete)
// ═══════════════════════════════════════════════════════════════════════

exports.deleteDriver = async (req, res) => {
    try {
        const { id } = req.params;

        const driver = await Account.findOne({ where: { uuid: id, user_type: 'DRIVER' } });
        if (!driver) return res.status(404).json({ success: false, message: 'Driver not found' });

        await driver.update({ status: 'DELETED' });

        console.log(`🗑️ Deleted driver: ${id}`);

        return res.status(200).json({ success: true, message: 'Driver deleted successfully' });

    } catch (error) {
        console.error('❌ Error deleting driver:', error);
        return res.status(500).json({ success: false, message: 'Failed to delete driver', error: error.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// DRIVER STATS
// ═══════════════════════════════════════════════════════════════════════

exports.getDriverStats = async (req, res) => {
    try {
        const [
            totalDrivers, activeDrivers, pendingDrivers,
            suspendedDrivers, verifiedDrivers, onlineDrivers,
        ] = await Promise.all([
            Account.count({ where: { user_type: 'DRIVER' } }),
            Account.count({ where: { user_type: 'DRIVER', status: 'ACTIVE' } }),
            Account.count({ where: { user_type: 'DRIVER', status: 'PENDING' } }),
            Account.count({ where: { user_type: 'DRIVER', status: 'SUSPENDED' } }),
            DriverProfile.count({ where: { verification_state: 'VERIFIED' } }),
            DriverProfile.count({ where: { status: 'online' } }),
        ]);

        console.log('✅ Fetched driver statistics');

        return res.status(200).json({
            success: true,
            stats: {
                total:     totalDrivers,
                active:    activeDrivers,
                pending:   pendingDrivers,
                suspended: suspendedDrivers,
                verified:  verifiedDrivers,
                online:    onlineDrivers,
            },
        });

    } catch (error) {
        console.error('❌ Error fetching driver stats:', error);
        return res.status(500).json({ success: false, message: 'Failed to fetch statistics', error: error.message });
    }
};