 
'use strict';

const { Account, Driver, DriverProfile, Delivery, sequelize } = require('../../models');

async function resolveDriver(accountUuid) {
    return Driver.findOne({
        where:      { userId: accountUuid },
        attributes: ['id', 'userId', 'status', 'current_mode', 'phone', 'rating', 'vehicle_make_model'],
    });
}

// ── GET ────────────────────────────────────────────────────────────────────────

exports.getProfile = async (req, res) => {
    try {
        const accountUuid = req.user.uuid;

        const account = await Account.findByPk(accountUuid, {
            attributes: [
                'uuid', 'user_type', 'first_name', 'last_name',
                'email', 'phone_e164', 'avatar_url',
                'phone_verified', 'email_verified', 'status', 'created_at',
            ],
        });
        if (!account) {
            return res.status(404).json({ success: false, message: 'Account not found' });
        }

        const driver = await resolveDriver(accountUuid);

        let driverProfile = null;
        if (driver) {
            driverProfile = await DriverProfile.findOne({
                where:      { account_id: accountUuid },
                attributes: [
                    'rating_avg', 'rating_count', 'verification_state',
                    'vehicle_type', 'vehicle_make_model', 'vehicle_color',
                    'vehicle_year', 'vehicle_plate', 'vehicle_photo_url',
                    'license_number', 'license_expiry',
                    'insurance_number', 'insurance_expiry',
                ],
            });
        }

        let stats = { totalDeliveries: 0, completedDeliveries: 0, cancelledDeliveries: 0 };
        if (driver) {
            const [total, completed, cancelled] = await Promise.all([
                Delivery.count({ where: { driver_id: driver.id } }),
                Delivery.count({ where: { driver_id: driver.id, status: 'delivered' } }),
                Delivery.count({ where: { driver_id: driver.id, status: 'cancelled' } }),
            ]);
            stats = { totalDeliveries: total, completedDeliveries: completed, cancelledDeliveries: cancelled };
        }

        return res.json({
            success: true,
            profile: {
                uuid:          account.uuid,
                userType:      account.user_type,
                firstName:     account.first_name  || '',
                lastName:      account.last_name   || '',
                fullName:      `${account.first_name || ''} ${account.last_name || ''}`.trim(),
                email:         account.email       || null,
                phone:         account.phone_e164  || null,
                avatarUrl:     account.avatar_url  || null,
                phoneVerified: account.phone_verified,
                emailVerified: account.email_verified,
                accountStatus: account.status,
                memberSince:   account.created_at,

                driverStatus:  driver?.status       || 'offline',
                currentMode:   driver?.current_mode || 'delivery',
                driverRating:  parseFloat(driver?.rating ?? 5.0),
                canSwitchMode: account.user_type === 'DRIVER',

                vehicle: {
                    makeModel: driverProfile?.vehicle_make_model || driver?.vehicle_make_model || null,
                    color:     driverProfile?.vehicle_color      || null,
                    year:      driverProfile?.vehicle_year       || null,
                    plate:     driverProfile?.vehicle_plate      || null,
                    type:      driverProfile?.vehicle_type       || null,
                    photoUrl:  driverProfile?.vehicle_photo_url  || null,
                },

                verification: driverProfile ? {
                    state:           driverProfile.verification_state || 'PENDING',
                    licenseNumber:   driverProfile.license_number     || null,
                    licenseExpiry:   driverProfile.license_expiry     || null,
                    insuranceNumber: driverProfile.insurance_number   || null,
                    insuranceExpiry: driverProfile.insurance_expiry   || null,
                } : null,

                rating: {
                    average: parseFloat(driverProfile?.rating_avg ?? driver?.rating ?? 5.0),
                    count:   driverProfile?.rating_count ?? 0,
                },

                stats,
            },
        });

    } catch (error) {
        console.error('❌ [AGENT PROFILE] getProfile error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch profile' });
    }
};

// ── PUT ────────────────────────────────────────────────────────────────────────

exports.updateProfile = async (req, res) => {
    try {
        const accountUuid = req.user.uuid;
        const {
            first_name, last_name, email, phone,
            vehicle_make_model, vehicle_color, vehicle_year, vehicle_plate,
        } = req.body;

        const accountUpdates = {};
        const driverUpdates  = {};
        const profileUpdates = {};

        if (first_name !== undefined) accountUpdates.first_name = first_name.trim();
        if (last_name  !== undefined) accountUpdates.last_name  = last_name.trim();
        if (email      !== undefined) {
            accountUpdates.email          = email.trim().toLowerCase();
            accountUpdates.email_verified = false;
        }
        if (phone              !== undefined) driverUpdates.phone              = phone.trim();
        if (vehicle_make_model !== undefined) {
            driverUpdates.vehicle_make_model  = vehicle_make_model.trim();
            profileUpdates.vehicle_make_model = vehicle_make_model.trim();
        }
        if (vehicle_color !== undefined) profileUpdates.vehicle_color = vehicle_color.trim();
        if (vehicle_year  !== undefined) profileUpdates.vehicle_year  = parseInt(vehicle_year);
        if (vehicle_plate !== undefined) profileUpdates.vehicle_plate = vehicle_plate.toUpperCase().trim();

        if (!Object.keys(accountUpdates).length &&
            !Object.keys(driverUpdates).length  &&
            !Object.keys(profileUpdates).length) {
            return res.status(400).json({ success: false, message: 'No updatable fields provided' });
        }

        const t = await sequelize.transaction();
        try {
            if (Object.keys(accountUpdates).length) {
                await Account.update(accountUpdates, { where: { uuid: accountUuid }, transaction: t });
            }
            const driver = await resolveDriver(accountUuid);
            if (driver) {
                if (Object.keys(driverUpdates).length) {
                    await Driver.update(driverUpdates, { where: { id: driver.id }, transaction: t });
                }
                if (Object.keys(profileUpdates).length) {
                    await DriverProfile.update(profileUpdates, { where: { account_id: accountUuid }, transaction: t });
                }
            }
            await t.commit();
        } catch (err) {
            await t.rollback();
            throw err;
        }

        return exports.getProfile(req, res);

    } catch (error) {
        console.error('❌ [AGENT PROFILE] updateProfile error:', error.message);
        if (error.name === 'SequelizeUniqueConstraintError') {
            return res.status(409).json({
                success: false,
                message: 'This vehicle plate is already registered to another account',
            });
        }
        return res.status(500).json({ success: false, message: 'Failed to update profile' });
    }
};