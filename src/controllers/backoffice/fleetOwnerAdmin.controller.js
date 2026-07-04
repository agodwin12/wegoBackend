// src/controllers/backoffice/fleetOwnerAdmin.controller.js
//
// ═══════════════════════════════════════════════════════════════════════════
// FLEET OWNERS (ride-hailing) — backoffice admin
// ═══════════════════════════════════════════════════════════════════════════
//
// WeGo staff onboard a Fleet Owner: a company/person who runs a fleet of
// ride-hailing drivers. KYC is mandatory (ID card front+back, NIU number +
// document). The created FLEET_OWNER account then logs into the separate
// WeGo Fleet dashboard to manage its own drivers.
//
// This is DISTINCT from the vehicle-rental "Partner" concept.
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const { Op, fn, col } = require('sequelize');
const { Account, FleetOwnerProfile } = require('../../models');
const sequelize = require('../../config/database');

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/backoffice/fleet-owners — create a fleet owner (with KYC)
// ═══════════════════════════════════════════════════════════════════════════
exports.createFleetOwner = async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const {
            companyName, contactName, phoneNumber, email, password, address,
            profilePhoto,
            idCardFront, idCardBack, niuNumber, niuDocument,
        } = req.body;

        // Basic fields
        if (!companyName || !phoneNumber || !email || !password) {
            await t.rollback();
            return res.status(400).json({ success: false, message: 'Company name, phone, email and password are required.' });
        }
        if (String(password).length < 8) {
            await t.rollback();
            return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
        }

        // KYC is mandatory — the fleet owner must produce ID (front+back) and NIU.
        const missing = [];
        if (!idCardFront) missing.push('ID card (front)');
        if (!idCardBack)  missing.push('ID card (back)');
        if (!niuNumber || !String(niuNumber).trim()) missing.push('NIU number');
        if (!niuDocument) missing.push('NIU document');
        if (missing.length) {
            await t.rollback();
            return res.status(400).json({ success: false, message: `The following are required: ${missing.join(', ')}.` });
        }

        // Uniqueness
        const emailTaken = await Account.findOne({ where: { email: email.toLowerCase() } });
        if (emailTaken) { await t.rollback(); return res.status(409).json({ success: false, message: 'This email is already registered.' }); }
        const phoneTaken = await Account.findOne({ where: { phone_e164: phoneNumber.trim() } });
        if (phoneTaken) { await t.rollback(); return res.status(409).json({ success: false, message: 'This phone number is already registered.' }); }

        const accountUuid = uuidv4();
        const password_hash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);

        await Account.create({
            uuid:           accountUuid,
            user_type:      'FLEET_OWNER',
            email:          email.toLowerCase(),
            phone_e164:     phoneNumber.trim(),
            first_name:     companyName.trim(),
            last_name:      '',
            password_hash,
            password_algo:  'bcrypt',
            status:         'ACTIVE',
            email_verified: true,
            phone_verified: true,
        }, { transaction: t });

        const profile = await FleetOwnerProfile.create({
            id:             uuidv4(),
            accountId:      accountUuid,
            companyName:    companyName.trim(),
            contactName:    contactName?.trim() || null,
            phoneNumber:    phoneNumber.trim(),
            email:          email.toLowerCase(),
            address:        address?.trim() || null,
            profilePhoto:   profilePhoto || null,
            idCardFrontUrl: idCardFront,
            idCardBackUrl:  idCardBack,
            niuNumber:      String(niuNumber).trim(),
            niuDocumentUrl: niuDocument,
            createdByEmployeeId: req.user?.id || req.user?.uuid || null,
        }, { transaction: t });

        await t.commit();
        console.log(`✅ [FLEET-OWNER] Created ${accountUuid} (${companyName})`);

        return res.status(201).json({
            success: true,
            message: 'Fleet owner created. Share the login credentials — they sign in to the WeGo Fleet dashboard.',
            data: {
                id: profile.id,
                account_uuid: accountUuid,
                company_name: profile.companyName,
                email: profile.email,
                login: { identifier: profile.email },
            },
        });
    } catch (error) {
        if (!t.finished) await t.rollback();
        console.error('❌ [FLEET-OWNER] create error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to create fleet owner.', error: error.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/backoffice/fleet-owners — list (with driver counts)
// ═══════════════════════════════════════════════════════════════════════════
exports.listFleetOwners = async (req, res) => {
    try {
        const page   = Math.max(1, parseInt(req.query.page || '1', 10));
        const limit  = Math.min(100, Math.max(5, parseInt(req.query.limit || '20', 10)));
        const offset = (page - 1) * limit;
        const search = (req.query.search || '').trim();

        const where = {};
        if (search) {
            where[Op.or] = [
                { companyName: { [Op.like]: `%${search}%` } },
                { email: { [Op.like]: `%${search}%` } },
                { phoneNumber: { [Op.like]: `%${search}%` } },
            ];
        }

        const { count, rows } = await FleetOwnerProfile.findAndCountAll({
            where, limit, offset, order: [['created_at', 'DESC']],
            include: [{ model: Account, as: 'account', attributes: ['uuid', 'status', 'created_at'] }],
        });

        // driver counts per owner (non-deleted)
        const ownerUuids = rows.map(r => r.accountId);
        let countsByOwner = new Map();
        if (ownerUuids.length) {
            const grouped = await Account.findAll({
                where: { user_type: 'DRIVER', fleet_owner_id: { [Op.in]: ownerUuids }, status: { [Op.ne]: 'DELETED' } },
                attributes: ['fleet_owner_id', [fn('COUNT', col('uuid')), 'n']],
                group: ['fleet_owner_id'], raw: true,
            });
            countsByOwner = new Map(grouped.map(g => [g.fleet_owner_id, parseInt(g.n, 10)]));
        }

        return res.json({
            success: true,
            data: rows.map(r => ({
                id: r.id,
                account_uuid: r.accountId,
                company_name: r.companyName,
                contact_name: r.contactName,
                email: r.email,
                phone_number: r.phoneNumber,
                address: r.address,
                profile_photo: r.profilePhoto,
                status: r.account?.status || 'ACTIVE',
                driver_count: countsByOwner.get(r.accountId) || 0,
                created_at: r.createdAt,
            })),
            pagination: { total: count, page, limit, totalPages: Math.ceil(count / limit) },
        });
    } catch (error) {
        console.error('❌ [FLEET-OWNER] list error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to load fleet owners.', error: error.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/backoffice/fleet-owners/:id — detail (incl. KYC documents)
// ═══════════════════════════════════════════════════════════════════════════
exports.getFleetOwner = async (req, res) => {
    try {
        const owner = await FleetOwnerProfile.findByPk(req.params.id, {
            include: [{ model: Account, as: 'account', attributes: ['uuid', 'status', 'email', 'phone_e164', 'created_at'] }],
        });
        if (!owner) return res.status(404).json({ success: false, message: 'Fleet owner not found.' });

        const driverCount = await Account.count({
            where: { user_type: 'DRIVER', fleet_owner_id: owner.accountId, status: { [Op.ne]: 'DELETED' } },
        });

        return res.json({
            success: true,
            data: {
                id: owner.id,
                account_uuid: owner.accountId,
                company_name: owner.companyName,
                contact_name: owner.contactName,
                email: owner.email,
                phone_number: owner.phoneNumber,
                address: owner.address,
                profile_photo: owner.profilePhoto,
                status: owner.account?.status || 'ACTIVE',
                driver_count: driverCount,
                documents: {
                    id_card_front: owner.idCardFrontUrl,
                    id_card_back: owner.idCardBackUrl,
                    niu_number: owner.niuNumber,
                    niu_document: owner.niuDocumentUrl,
                },
                created_at: owner.createdAt,
            },
        });
    } catch (error) {
        console.error('❌ [FLEET-OWNER] get error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to load fleet owner.', error: error.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// PATCH /:id/suspend | /reactivate — toggles the account (blocks login)
// ═══════════════════════════════════════════════════════════════════════════
async function setStatus(req, res, status, label) {
    try {
        const owner = await FleetOwnerProfile.findByPk(req.params.id);
        if (!owner) return res.status(404).json({ success: false, message: 'Fleet owner not found.' });
        await Account.update({ status }, { where: { uuid: owner.accountId } });
        console.log(`🔁 [FLEET-OWNER] ${owner.accountId} → ${status}`);
        return res.json({ success: true, message: `Fleet owner ${label}.`, data: { id: owner.id, status } });
    } catch (error) {
        console.error(`❌ [FLEET-OWNER] ${label} error:`, error.message);
        return res.status(500).json({ success: false, message: `Failed to ${label} fleet owner.` });
    }
}
exports.suspendFleetOwner    = (req, res) => setStatus(req, res, 'SUSPENDED', 'suspended');
exports.reactivateFleetOwner = (req, res) => setStatus(req, res, 'ACTIVE', 'reactivated');

// ═══════════════════════════════════════════════════════════════════════════
// DELETE /:id — remove a fleet owner (blocked while they still own drivers)
// ═══════════════════════════════════════════════════════════════════════════
exports.deleteFleetOwner = async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const owner = await FleetOwnerProfile.findByPk(req.params.id);
        if (!owner) { await t.rollback(); return res.status(404).json({ success: false, message: 'Fleet owner not found.' }); }

        const drivers = await Account.count({
            where: { user_type: 'DRIVER', fleet_owner_id: owner.accountId, status: { [Op.ne]: 'DELETED' } },
        });
        if (drivers > 0) {
            await t.rollback();
            return res.status(409).json({
                success: false,
                message: `This fleet owner still has ${drivers} driver(s). Remove or reassign them before deleting.`,
                code: 'HAS_DRIVERS',
            });
        }

        await FleetOwnerProfile.destroy({ where: { id: owner.id }, transaction: t });
        await Account.destroy({ where: { uuid: owner.accountId }, transaction: t });
        await t.commit();
        console.log(`🗑️  [FLEET-OWNER] deleted ${owner.accountId}`);
        return res.json({ success: true, message: 'Fleet owner deleted.', data: { id: owner.id } });
    } catch (error) {
        if (!t.finished) await t.rollback();
        console.error('❌ [FLEET-OWNER] delete error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to delete fleet owner.' });
    }
};
