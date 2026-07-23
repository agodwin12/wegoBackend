// wegobackend/src/controllers/backoffice/partnerController.js

const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { Account, PartnerProfile, Vehicle, Employee, VehicleRental } = require('../../models');
const { Op } = require('sequelize');
const sequelize = require('../../config/database');
const { sendSms } = require('../../services/comm/sms.service');
const { sendEmail } = require('../../services/comm/email.service');

// ─────────────────────────────────────────────────────────────────────────────
// Temporary partner credentials
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Readable one-time password, e.g. "WG-K7KQ-9DF4". The alphabet drops the
 * lookalikes (0/O, 1/I/L) because the partner retypes this from an SMS.
 */
function generateTempPassword() {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const pick = (n) =>
        Array.from(crypto.randomBytes(n), (b) => alphabet[b % alphabet.length]).join('');
    return `WG-${pick(4)}-${pick(4)}`;
}

/** Techsoft needs the full international number without '+'. */
function toInternationalPhone(raw) {
    const digits = String(raw || '').replace(/\D/g, '');
    if (!digits) return null;
    if (digits.startsWith('237')) return digits;
    if (digits.length === 9) return `237${digits}`;
    return digits;
}

/**
 * Delivers the temporary credentials over both channels. Never throws — the
 * partner account already exists at this point, so delivery problems are
 * reported back to the backoffice instead of failing the creation.
 */
async function deliverTempPassword({ partnerName, email, phoneNumber, tempPassword }) {
    const delivery = { sms_sent: false, email_sent: false };

    const smsTo = toInternationalPhone(phoneNumber);
    if (smsTo) {
        try {
            await sendSms(
                smsTo,
                `WEGO — Bienvenue ${partnerName}. Votre acces partenaire: ` +
                `identifiant ${email}, mot de passe provisoire ${tempPassword}. ` +
                `Il devra etre change a la premiere connexion.`
            );
            delivery.sms_sent = true;
        } catch (err) {
            console.error('⚠️ [PARTNER] SMS delivery failed:', err.message);
        }
    }

    try {
        await sendEmail(
            email,
            'Vos accès partenaire WEGO',
            `Bienvenue ${partnerName},\n\n` +
                `Votre compte partenaire WEGO a été créé.\n\n` +
                `Identifiant : ${email}\n` +
                `Mot de passe provisoire : ${tempPassword}\n\n` +
                `Ce mot de passe devra être changé lors de votre première connexion ` +
                `au portail partenaire.\n\n— L'équipe WEGO`,
            `<p>Bienvenue <b>${partnerName}</b>,</p>` +
                `<p>Votre compte partenaire WEGO a été créé.</p>` +
                `<p>Identifiant : <b>${email}</b><br/>` +
                `Mot de passe provisoire : <b style="font-size:16px">${tempPassword}</b></p>` +
                `<p>Ce mot de passe devra être changé lors de votre première connexion ` +
                `au portail partenaire.</p><p>— L'équipe WEGO</p>`
        );
        delivery.email_sent = true;
    } catch (err) {
        console.error('⚠️ [PARTNER] Email delivery failed:', err.message);
    }

    return delivery;
}

/**
 * 🎯 CREATE PARTNER
 */
exports.createPartner = async (req, res) => {
    const transaction = await sequelize.transaction();

    try {
        const {
            partnerName,
            address,
            phoneNumber,
            email,
            profilePhoto
        } = req.body;

        const employeeId = req.user?.id;

        console.log('🆕 Creating partner:', { partnerName, email, employeeId });

        // The password is no longer chosen by the admin: it is generated here,
        // delivered to the partner by SMS/email, and must be changed at first
        // login (accounts.must_change_password).
        if (!partnerName || !phoneNumber || !email) {
            await transaction.rollback();
            return res.status(400).json({
                success: false,
                message: 'Partner name, phone number and email are required'
            });
        }

        const tempPassword = generateTempPassword();

        const existingAccount = await Account.findOne({
            where: { email: email.toLowerCase() }
        });

        if (existingAccount) {
            await transaction.rollback();
            return res.status(409).json({
                success: false,
                message: 'Email already exists'
            });
        }

        const existingPhone = await PartnerProfile.findOne({
            where: { phoneNumber }
        });

        if (existingPhone) {
            await transaction.rollback();
            return res.status(409).json({
                success: false,
                message: 'Phone number already exists'
            });
        }

        const accountUuid = uuidv4();
        const hashedPassword = await bcrypt.hash(tempPassword, 10);

        await Account.create({
            uuid: accountUuid,
            email: email.toLowerCase(),
            password_hash: hashedPassword,
            must_change_password: true,
            user_type: 'PARTNER',
            phone_verified: true,
            status: 'ACTIVE'
        }, { transaction });

        console.log('✅ Account created:', accountUuid);

        const partnerProfile = await PartnerProfile.create({
            id: uuidv4(),
            accountId: accountUuid,
            partnerName: partnerName.trim(),
            address: address?.trim() || null,
            phoneNumber: phoneNumber.trim(),
            email: email.toLowerCase(),
            profilePhoto: profilePhoto || null,
            isBlocked: false,
            createdByEmployeeId: null
        }, { transaction });

        console.log('✅ Partner profile created:', partnerProfile.id);

        await transaction.commit();

        // Delivery happens AFTER the commit: the account exists either way,
        // and a provider outage must not roll back the partner.
        const delivery = await deliverTempPassword({
            partnerName: partnerName.trim(),
            email: email.toLowerCase(),
            phoneNumber,
            tempPassword,
        });

        console.log('📨 [PARTNER] Credential delivery:', delivery);

        const completePartner = await PartnerProfile.findByPk(partnerProfile.id, {
            include: [
                {
                    model: Account,
                    as: 'account',
                    attributes: ['uuid', 'email', 'user_type', 'status', 'createdAt']
                }
            ]
        });

        return res.status(201).json({
            success: true,
            message: 'Partner created successfully',
            data: completePartner,
            credential_delivery: {
                ...delivery,
                // Safety valve: when NEITHER channel reached the partner, the
                // admin is the only remaining path — show the password once so
                // it can be passed on by hand. Never returned otherwise.
                ...(!delivery.sms_sent && !delivery.email_sent
                    ? { temp_password: tempPassword }
                    : {}),
            },
        });

    } catch (error) {
        if (!transaction.finished) {
            await transaction.rollback();
        }
        console.error('❌ Error creating partner:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to create partner',
            error: error.message
        });
    }
};

/**
 * 📋 GET ALL PARTNERS
 */
exports.getAllPartners = async (req, res) => {
    try {
        const {
            page = 1,
            limit = 10,
            search = '',
            isBlocked = '',
            sortBy = 'createdAt',
            sortOrder = 'DESC'
        } = req.query;

        const offset = (parseInt(page) - 1) * parseInt(limit);

        console.log('📋 Fetching partners:', { page, limit, search, isBlocked });

        const whereClause = {};

        if (search) {
            whereClause[Op.or] = [
                { partnerName: { [Op.like]: `%${search}%` } },
                { email: { [Op.like]: `%${search}%` } },
                { phoneNumber: { [Op.like]: `%${search}%` } }
            ];
        }

        if (isBlocked !== '') {
            whereClause.isBlocked = isBlocked === 'true';
        }

        const { count, rows: partners } = await PartnerProfile.findAndCountAll({
            where: whereClause,
            limit: parseInt(limit),
            offset: offset,
            order: [[sortBy, sortOrder.toUpperCase()]],
            include: [
                {
                    model: Account,
                    as: 'account',
                    attributes: ['uuid', 'email', 'user_type', 'status', 'createdAt']
                },
                {
                    model: Vehicle,
                    as: 'vehicles',
                    attributes: ['id', 'plate', 'makeModel', 'availableForRent'],
                    required: false
                }
            ],
            distinct: true
        });

        return res.status(200).json({
            success: true,
            data: partners,
            pagination: {
                total: count,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(count / parseInt(limit))
            }
        });

    } catch (error) {
        console.error('❌ Error fetching partners:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch partners',
            error: error.message
        });
    }
};

/**
 * 🔍 GET SINGLE PARTNER BY ID
 */
exports.getPartnerById = async (req, res) => {
    try {
        const { id } = req.params;

        console.log('🔍 Fetching partner:', id);

        const partner = await PartnerProfile.findByPk(id, {
            include: [
                {
                    model: Account,
                    as: 'account',
                    attributes: ['uuid', 'email', 'user_type', 'status', 'createdAt', 'updatedAt']
                },
                {
                    model: Vehicle,
                    as: 'vehicles',
                    include: [
                        {
                            association: 'category',
                            attributes: ['id', 'name', 'slug']
                        }
                    ]
                }
            ]
        });

        if (!partner) {
            return res.status(404).json({
                success: false,
                message: 'Partner not found'
            });
        }

        const vehicleStats = {
            total: partner.vehicles?.length || 0,
            availableForRent: partner.vehicles?.filter(v => v.availableForRent).length || 0,
            unavailable: partner.vehicles?.filter(v => !v.availableForRent).length || 0
        };

        return res.status(200).json({
            success: true,
            data: {
                ...partner.toJSON(),
                vehicleStats
            }
        });

    } catch (error) {
        console.error('❌ Error fetching partner:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch partner',
            error: error.message
        });
    }
};

/**
 * ✏️ UPDATE PARTNER
 */
exports.updatePartner = async (req, res) => {
    const transaction = await sequelize.transaction();

    try {
        const { id } = req.params;
        const {
            partnerName,
            address,
            phoneNumber,
            email,
            profilePhoto
        } = req.body;

        console.log('✏️ Updating partner:', id);

        const partner = await PartnerProfile.findByPk(id, {
            include: [{ model: Account, as: 'account' }],
            transaction
        });

        if (!partner) {
            await transaction.rollback();
            return res.status(404).json({
                success: false,
                message: 'Partner not found'
            });
        }

        if (email && email.toLowerCase() !== partner.email) {
            const existingEmail = await PartnerProfile.findOne({
                where: {
                    email: email.toLowerCase(),
                    id: { [Op.ne]: id }
                },
                transaction
            });

            if (existingEmail) {
                await transaction.rollback();
                return res.status(409).json({
                    success: false,
                    message: 'Email already exists'
                });
            }

            await Account.update(
                { email: email.toLowerCase() },
                {
                    where: { uuid: partner.accountId },
                    transaction
                }
            );
        }

        if (phoneNumber && phoneNumber !== partner.phoneNumber) {
            const existingPhone = await PartnerProfile.findOne({
                where: {
                    phoneNumber: phoneNumber,
                    id: { [Op.ne]: id }
                },
                transaction
            });

            if (existingPhone) {
                await transaction.rollback();
                return res.status(409).json({
                    success: false,
                    message: 'Phone number already exists'
                });
            }
        }

        await partner.update({
            partnerName: partnerName?.trim() || partner.partnerName,
            address: address?.trim() || partner.address,
            phoneNumber: phoneNumber?.trim() || partner.phoneNumber,
            email: email?.toLowerCase() || partner.email,
            profilePhoto: profilePhoto !== undefined ? profilePhoto : partner.profilePhoto
        }, { transaction });

        await transaction.commit();

        console.log('✅ Partner updated successfully');

        const updatedPartner = await PartnerProfile.findByPk(id, {
            include: [
                {
                    model: Account,
                    as: 'account',
                    attributes: ['uuid', 'email', 'user_type', 'status']
                }
            ]
        });

        return res.status(200).json({
            success: true,
            message: 'Partner updated successfully',
            data: updatedPartner
        });

    } catch (error) {
        if (!transaction.finished) {
            await transaction.rollback();
        }
        console.error('❌ Error updating partner:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to update partner',
            error: error.message
        });
    }
};

/**
 * 🗑️ DELETE PARTNER
 */
exports.deletePartner = async (req, res) => {
    const transaction = await sequelize.transaction();

    try {
        const { id } = req.params;

        console.log('🗑️ Deleting partner:', id);

        const partner = await PartnerProfile.findByPk(id, {
            include: [{ model: Vehicle, as: 'vehicles' }],
            transaction
        });

        if (!partner) {
            await transaction.rollback();
            return res.status(404).json({
                success: false,
                message: 'Partner not found'
            });
        }

        if (partner.vehicles && partner.vehicles.length > 0) {
            await transaction.rollback();
            return res.status(400).json({
                success: false,
                message: 'Cannot delete partner with existing vehicles. Please remove or reassign vehicles first.',
                vehicleCount: partner.vehicles.length
            });
        }

        await partner.destroy({ transaction });

        await Account.destroy({
            where: { uuid: partner.accountId },
            transaction
        });

        await transaction.commit();

        console.log('✅ Partner deleted successfully');

        return res.status(200).json({
            success: true,
            message: 'Partner deleted successfully'
        });

    } catch (error) {
        if (!transaction.finished) {
            await transaction.rollback();
        }
        console.error('❌ Error deleting partner:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to delete partner',
            error: error.message
        });
    }
};

/**
 * 🚫 BLOCK PARTNER
 */
exports.blockPartner = async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;

        console.log('🚫 Blocking partner:', { id, reason });

        const partner = await PartnerProfile.findByPk(id);

        if (!partner) {
            return res.status(404).json({
                success: false,
                message: 'Partner not found'
            });
        }

        if (partner.isBlocked) {
            return res.status(400).json({
                success: false,
                message: 'Partner is already blocked'
            });
        }

        await partner.update({
            isBlocked: true,
            blockedBy: null,
            blockReason: reason || null,
            blockedAt: new Date()
        });

        await Account.update(
            { status: 'SUSPENDED' },
            { where: { uuid: partner.accountId } }
        );

        console.log('✅ Partner blocked successfully');

        const blockedPartner = await PartnerProfile.findByPk(id, {
            include: [
                {
                    model: Account,
                    as: 'account',
                    attributes: ['uuid', 'email', 'user_type', 'status']
                }
            ]
        });

        return res.status(200).json({
            success: true,
            message: 'Partner blocked successfully',
            data: blockedPartner
        });

    } catch (error) {
        console.error('❌ Error blocking partner:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to block partner',
            error: error.message
        });
    }
};

/**
 * ✅ UNBLOCK PARTNER
 */
exports.unblockPartner = async (req, res) => {
    try {
        const { id } = req.params;

        console.log('✅ Unblocking partner:', id);

        const partner = await PartnerProfile.findByPk(id);

        if (!partner) {
            return res.status(404).json({
                success: false,
                message: 'Partner not found'
            });
        }

        if (!partner.isBlocked) {
            return res.status(400).json({
                success: false,
                message: 'Partner is not blocked'
            });
        }

        await partner.update({
            isBlocked: false,
            blockedBy: null,
            blockReason: null,
            blockedAt: null
        });

        await Account.update(
            { status: 'ACTIVE' },
            { where: { uuid: partner.accountId } }
        );

        console.log('✅ Partner unblocked successfully');

        const unblockedPartner = await PartnerProfile.findByPk(id, {
            include: [
                {
                    model: Account,
                    as: 'account',
                    attributes: ['uuid', 'email', 'user_type', 'status']
                }
            ]
        });

        return res.status(200).json({
            success: true,
            message: 'Partner unblocked successfully',
            data: unblockedPartner
        });

    } catch (error) {
        console.error('❌ Error unblocking partner:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to unblock partner',
            error: error.message
        });
    }
};

/**
 * 📊 GET PARTNER STATISTICS
 */
exports.getPartnerStats = async (req, res) => {
    try {
        console.log('📊 Fetching partner statistics');

        const [totalPartners, activePartners, blockedPartners] = await Promise.all([
            PartnerProfile.count(),
            PartnerProfile.count({ where: { isBlocked: false } }),
            PartnerProfile.count({ where: { isBlocked: true } })
        ]);

        return res.status(200).json({
            success: true,
            data: {
                total: totalPartners,
                active: activePartners,
                blocked: blockedPartners
            }
        });

    } catch (error) {
        console.error('❌ Error fetching partner stats:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch partner statistics',
            error: error.message
        });
    }
};

/**
 * 📋 GET PARTNER RENTALS
 */
exports.getPartnerRentals = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            page = 1,
            limit = 50,
            status = '',
            paymentStatus = '',
            sortBy = 'createdAt',
            sortOrder = 'DESC'
        } = req.query;

        const offset = (parseInt(page) - 1) * parseInt(limit);

        console.log('📊 Fetching rentals for partner:', id);

        const partner = await PartnerProfile.findByPk(id);

        if (!partner) {
            return res.status(404).json({
                success: false,
                message: 'Partner not found'
            });
        }

        const partnerVehicles = await Vehicle.findAll({
            where: { partnerId: partner.accountId },
            attributes: ['id']
        });

        const vehicleIds = partnerVehicles.map(v => v.id);

        if (vehicleIds.length === 0) {
            return res.status(200).json({
                success: true,
                data: [],
                pagination: {
                    total: 0,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    totalPages: 0
                },
                stats: {
                    totalRentals: 0,
                    totalRevenue: 0,
                    paidRentals: 0,
                    unpaidRentals: 0,
                    activeRentals: 0,
                    completedRentals: 0
                }
            });
        }

        const whereClause = {
            vehicleId: { [Op.in]: vehicleIds }
        };

        if (status) {
            whereClause.status = status;
        }

        if (paymentStatus) {
            whereClause.paymentStatus = paymentStatus;
        }

        const { count, rows: rentals } = await VehicleRental.findAndCountAll({
            where: whereClause,
            limit: parseInt(limit),
            offset: offset,
            order: [[sortBy, sortOrder.toUpperCase()]],
            include: [
                {
                    model: Vehicle,
                    as: 'vehicle',
                    attributes: ['id', 'plate', 'makeModel', 'color', 'seats'],
                    include: [
                        {
                            association: 'category',
                            attributes: ['id', 'name', 'slug']
                        }
                    ]
                },
                {
                    model: Account,
                    as: 'user',
                    attributes: ['uuid', 'email', 'first_name', 'last_name', 'phone_e164'],
                }
            ],
            distinct: true
        });

        const allRentals = await VehicleRental.findAll({
            where: { vehicleId: { [Op.in]: vehicleIds } },
            attributes: ['id', 'status', 'paymentStatus', 'totalPrice']
        });

        const stats = {
            totalRentals: allRentals.length,
            totalRevenue: allRentals
                .filter(r => r.paymentStatus === 'paid')
                .reduce((sum, r) => sum + parseFloat(r.totalPrice || 0), 0),
            paidRentals: allRentals.filter(r => r.paymentStatus === 'paid').length,
            unpaidRentals: allRentals.filter(r => r.paymentStatus === 'unpaid').length,
            refundedRentals: allRentals.filter(r => r.paymentStatus === 'refunded').length,
            activeRentals: allRentals.filter(r => r.status === 'CONFIRMED').length,
            completedRentals: allRentals.filter(r => r.status === 'COMPLETED').length,
            cancelledRentals: allRentals.filter(r => r.status === 'CANCELLED').length,
            pendingRentals: allRentals.filter(r => r.status === 'PENDING').length
        };

        console.log('✅ Found rentals:', count, 'Stats:', stats);

        const formattedRentals = rentals.map(rental => {
            const user = rental.user;

            return {
                id: rental.id,
                rentalType: rental.rentalType,
                startDate: rental.startDate,
                endDate: rental.endDate,
                status: rental.status,
                totalPrice: rental.totalPrice,
                paymentStatus: rental.paymentStatus,
                createdAt: rental.createdAt,
                updatedAt: rental.updatedAt,
                vehicle: rental.vehicle,
                user: {
                    uuid: user?.uuid,
                    email: user?.email,
                    firstName: user?.first_name,
                    lastName: user?.last_name,
                    phoneNumber: user?.phone_e164,
                },
            };
        });

        return res.status(200).json({
            success: true,
            data: formattedRentals,
            pagination: {
                total: count,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(count / parseInt(limit))
            },
            stats
        });

    } catch (error) {
        console.error('❌ Error fetching partner rentals:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch partner rentals',
            error: error.message
        });
    }
};