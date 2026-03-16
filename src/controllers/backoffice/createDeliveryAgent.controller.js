// src/controllers/backoffice/createDeliveryAgent.controller.js

const bcrypt         = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const { Account, Driver, sequelize } = require('../../models');
const { DeliveryWallet } = require('../../models');
const { uploadProfileToR2, uploadDocumentToR2 } = require('../../middleware/upload');
const { sendSmsNotification } = require('../../services/comm/sms.service');

// ─── Generate a temporary password ────────────────────────────────────────────
function generateTempPassword() {
    const upper   = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const lower   = 'abcdefghjkmnpqrstuvwxyz';
    const digits  = '23456789';
    const special = '@#$%!';

    const pick = (set) => set[Math.floor(Math.random() * set.length)];

    let password = pick(upper) + pick(lower) + pick(digits) + pick(special);
    const all    = upper + lower + digits + special;
    for (let i = 0; i < 4; i++) password += pick(all);

    return password.split('').sort(() => Math.random() - 0.5).join('');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CREATE DELIVERY AGENT
// POST /api/backoffice/delivery/agents/create
// multipart/form-data:
//   fields: first_name, last_name, phone, email (optional), vehicle_make_model
//   files:  profile_photo (optional), driver_license (required)
// ═══════════════════════════════════════════════════════════════════════════════
exports.createAgent = async (req, res) => {
    const transaction = await sequelize.transaction();

    try {
        const {
            first_name,
            last_name,
            phone,
            email,
            vehicle_make_model,
        } = req.body;

        // ── Validate required fields ─────────────────────────────────────────
        if (!first_name || !last_name || !phone) {
            await transaction.rollback();
            return res.status(400).json({
                success: false,
                message: 'first_name, last_name, and phone are required',
            });
        }

        const licenseFile      = req.files && req.files.driver_license && req.files.driver_license[0];
        const profilePhotoFile = req.files && req.files.profile_photo  && req.files.profile_photo[0];

        if (!licenseFile) {
            await transaction.rollback();
            return res.status(400).json({
                success: false,
                message: 'driver_license document is required',
            });
        }

        // ── Check uniqueness ─────────────────────────────────────────────────
        const existingPhone = await Account.findOne({ where: { phone_e164: phone } });
        if (existingPhone) {
            await transaction.rollback();
            return res.status(409).json({ success: false, message: 'A user with this phone number already exists' });
        }

        if (email) {
            const existingEmail = await Account.findOne({ where: { email } });
            if (existingEmail) {
                await transaction.rollback();
                return res.status(409).json({ success: false, message: 'A user with this email already exists' });
            }
        }

        // ── Upload to Cloudflare R2 ──────────────────────────────────────────
        let profilePhotoUrl = null;
        let licenseUrl      = null;

        // Profile photo — optional, non-fatal if fails
        if (profilePhotoFile) {
            try {
                profilePhotoUrl = await uploadProfileToR2(profilePhotoFile);
                console.log('✅ [DELIVERY AGENT] Profile photo uploaded:', profilePhotoUrl);
            } catch (err) {
                console.error('❌ [DELIVERY AGENT] Profile photo upload failed:', err.message);
                // Continue — agent can be created without a photo
            }
        }

        // Driver license — required, fatal if fails
        try {
            licenseUrl = await uploadDocumentToR2(licenseFile);
            console.log('✅ [DELIVERY AGENT] License uploaded:', licenseUrl);
        } catch (err) {
            await transaction.rollback();
            return res.status(500).json({
                success: false,
                message: 'Failed to upload driver license. Please try again.',
            });
        }

        // ── Generate credentials ──────────────────────────────────────────────
        const tempPassword = generateTempPassword();
        const passwordHash = await bcrypt.hash(tempPassword, 12);
        const accountUuid  = uuidv4();
        const driverId     = uuidv4();

        // ── Create Account ────────────────────────────────────────────────────
        const account = await Account.create({
            uuid:           accountUuid,
            user_type:      'DELIVERY_AGENT',
            first_name:     first_name.trim(),
            last_name:      last_name.trim(),
            phone_e164:     phone.trim(),
            email:          email ? email.trim() : null,
            avatar_url:     profilePhotoUrl,   // ✅ R2 URL stored here
            password_hash:  passwordHash,
            password_algo:  'bcrypt',
            phone_verified: true,
            email_verified: false,
            status:         'ACTIVE',
        }, { transaction });

        // ── Create Driver record ──────────────────────────────────────────────
        // ✅ vehicle_make_model saved directly on Driver row
        await Driver.create({
            id:                 driverId,
            userId:             accountUuid,
            status:             'offline',
            current_mode:       'delivery',
            phone:              phone.trim(),
            rating:             0.0,
            vehicleId:          null,
            vehicle_make_model: vehicle_make_model ? vehicle_make_model.trim() : null,
        }, { transaction });

        await DeliveryWallet.create({
                driver_id: driverId,
                balance: 0.00, total_earned: 0.00, total_cash_collected: 0.00,
                total_commission_owed: 0.00, total_commission_paid: 0.00,
                total_withdrawn: 0.00, pending_withdrawal: 0.00, status: 'active',
            }, {transaction});

        // ── Commit ────────────────────────────────────────────────────────────
        await transaction.commit();

        console.log('✅ [DELIVERY AGENT] Created:', first_name, last_name, '|', phone);
        console.log('   Account UUID:', accountUuid);
        console.log('   Driver ID:   ', driverId);
        console.log('   Vehicle:     ', vehicle_make_model || 'not provided');
        console.log('   Avatar:      ', profilePhotoUrl   || 'none');
        console.log('   License:     ', licenseUrl);

        // ── Send SMS credentials (after commit — agent exists even if SMS fails) ──
        const smsMessage =
            'Welcome to WEGO Delivery!\n\n' +
            'Your login credentials:\n' +
            'Phone: ' + phone + '\n' +
            'Password: ' + tempPassword + '\n\n' +
            'Download the WEGO Driver app and log in.';

        let smsSent = false;
        try {
            await sendSmsNotification(phone.trim(), smsMessage);
            smsSent = true;
        } catch (smsErr) {
            console.error('❌ [DELIVERY AGENT] SMS failed:', smsErr.message);
        }

        return res.status(201).json({
            success: true,
            message: 'Delivery agent created successfully',
            smsSent,
            agent: {
                accountUuid,
                driverId,
                firstName:        account.first_name,
                lastName:         account.last_name,
                phone:            account.phone_e164,
                email:            account.email,
                profilePhotoUrl,  // shown in success banner
                licenseUrl,       // shown in success banner
                vehicleMakeModel: vehicle_make_model || null,
                currentMode:      'delivery',
                status:           'ACTIVE',
                tempPassword,     // shown ONCE in backoffice — also sent via SMS
            },
        });

    } catch (error) {
        await transaction.rollback();
        console.error('❌ [DELIVERY AGENT] createAgent error:', error.message);
        console.error(error.stack);
        return res.status(500).json({ success: false, message: 'Failed to create delivery agent' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// UPDATE DELIVERY AGENT
// PUT /api/backoffice/delivery/agents/:driverId/update
// ═══════════════════════════════════════════════════════════════════════════════
exports.updateAgent = async (req, res) => {
    try {
        const { driverId } = req.params;
        const { first_name, last_name, email, vehicle_make_model, status } = req.body;

        const driver = await Driver.findByPk(driverId);
        if (!driver) {
            return res.status(404).json({ success: false, message: 'Delivery agent not found' });
        }

        const account = await Account.findOne({ where: { uuid: driver.userId } });
        if (!account || account.user_type !== 'DELIVERY_AGENT') {
            return res.status(404).json({ success: false, message: 'Delivery agent account not found' });
        }

        const profilePhotoFile = req.files && req.files.profile_photo && req.files.profile_photo[0];
        const licenseFile      = req.files && req.files.driver_license && req.files.driver_license[0];

        // ── Update Account fields ─────────────────────────────────────────────
        const accountUpdates = {};
        if (first_name) accountUpdates.first_name = first_name.trim();
        if (last_name)  accountUpdates.last_name  = last_name.trim();
        if (email)      accountUpdates.email       = email.trim();
        if (status)     accountUpdates.status      = status;

        if (profilePhotoFile) {
            accountUpdates.avatar_url = await uploadProfileToR2(profilePhotoFile);
            console.log('✅ [DELIVERY AGENT] New profile photo:', accountUpdates.avatar_url);
        }

        if (Object.keys(accountUpdates).length > 0) {
            await account.update(accountUpdates);
        }

        // ── Update Driver fields ──────────────────────────────────────────────
        const driverUpdates = {};
        if (req.body.phone)    driverUpdates.phone              = req.body.phone.trim();
        if (vehicle_make_model !== undefined) {
            driverUpdates.vehicle_make_model = vehicle_make_model ? vehicle_make_model.trim() : null;
        }

        let newLicenseUrl = null;
        if (licenseFile) {
            newLicenseUrl = await uploadDocumentToR2(licenseFile);
            console.log('✅ [DELIVERY AGENT] New license:', newLicenseUrl);
        }

        if (Object.keys(driverUpdates).length > 0) {
            await driver.update(driverUpdates);
        }

        // Sync phone on account too
        if (req.body.phone) {
            await account.update({ phone_e164: req.body.phone.trim() });
        }

        return res.json({
            success: true,
            message: 'Delivery agent updated',
            agent: {
                driverId,
                accountUuid:      account.uuid,
                firstName:        account.first_name,
                lastName:         account.last_name,
                phone:            account.phone_e164,
                email:            account.email,
                avatarUrl:        account.avatar_url,
                vehicleMakeModel: driver.vehicle_make_model,
                status:           account.status,
                ...(newLicenseUrl && { newLicenseUrl }),
            },
        });

    } catch (error) {
        console.error('❌ [DELIVERY AGENT] updateAgent error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to update delivery agent' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// RESEND CREDENTIALS
// POST /api/backoffice/delivery/agents/:driverId/resend-credentials
// ═══════════════════════════════════════════════════════════════════════════════
exports.resendCredentials = async (req, res) => {
    try {
        const { driverId } = req.params;

        const driver = await Driver.findByPk(driverId);
        if (!driver) return res.status(404).json({ success: false, message: 'Agent not found' });

        const account = await Account.findOne({ where: { uuid: driver.userId } });
        if (!account || account.user_type !== 'DELIVERY_AGENT') {
            return res.status(404).json({ success: false, message: 'Delivery agent not found' });
        }

        const tempPassword = generateTempPassword();
        const passwordHash = await bcrypt.hash(tempPassword, 12);
        await account.update({ password_hash: passwordHash });

        const smsMessage =
            'WEGO Delivery - New credentials for ' + account.first_name + ':\n' +
            'Phone: '    + account.phone_e164 + '\n' +
            'Password: ' + tempPassword + '\n\n' +
            'Log in to the WEGO Driver app.';

        await sendSmsNotification(account.phone_e164, smsMessage);
        console.log('📱 [DELIVERY AGENT] Credentials resent to', account.phone_e164);

        return res.json({
            success:     true,
            message:     'New credentials sent via SMS to ' + account.phone_e164,
            tempPassword,
        });

    } catch (error) {
        console.error('❌ [DELIVERY AGENT] resendCredentials error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to resend credentials' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// SUSPEND / REACTIVATE AGENT
// PATCH /api/backoffice/delivery/agents/:driverId/status
// ═══════════════════════════════════════════════════════════════════════════════
exports.updateStatus = async (req, res) => {
    try {
        const { driverId } = req.params;
        const { status }   = req.body;

        if (!['ACTIVE', 'SUSPENDED'].includes(status)) {
            return res.status(400).json({ success: false, message: 'status must be ACTIVE or SUSPENDED' });
        }

        const driver = await Driver.findByPk(driverId);
        if (!driver) return res.status(404).json({ success: false, message: 'Agent not found' });

        const account = await Account.findOne({ where: { uuid: driver.userId } });
        if (!account || account.user_type !== 'DELIVERY_AGENT') {
            return res.status(404).json({ success: false, message: 'Delivery agent not found' });
        }

        await account.update({ status });

        // Force offline when suspended
        if (status === 'SUSPENDED') {
            await driver.update({ status: 'offline' });
        }

        return res.json({
            success: true,
            message: 'Agent ' + (status === 'ACTIVE' ? 'reactivated' : 'suspended'),
            status,
        });

    } catch (error) {
        console.error('❌ [DELIVERY AGENT] updateStatus error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to update status' });
    }
};