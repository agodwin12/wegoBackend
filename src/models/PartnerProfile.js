// wegobackend/src/models/PartnerProfile.js
const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class PartnerProfile extends Model {}

PartnerProfile.init({
    id: {
        type: DataTypes.STRING(36),
        primaryKey: true,
        allowNull: false,
    },
    accountId: {
        type: DataTypes.CHAR(36),
        allowNull: false,
        unique: true,
        references: {
            model: 'accounts',
            key: 'uuid'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
        comment: 'Links to the partner account'
    },
    partnerName: {
        type: DataTypes.STRING(128),
        allowNull: false,
        validate: {
            notEmpty: {
                msg: 'Partner name cannot be empty'
            },
            len: {
                args: [2, 128],
                msg: 'Partner name must be between 2 and 128 characters'
            }
        }
    },
    address: {
        type: DataTypes.STRING(255),
        allowNull: true,
        validate: {
            len: {
                args: [0, 255],
                msg: 'Address cannot exceed 255 characters'
            }
        }
    },
    phoneNumber: {
        type: DataTypes.STRING(20),
        allowNull: false,
        validate: {
            notEmpty: {
                msg: 'Phone number cannot be empty'
            },
            is: {
                args: /^\+?[0-9\s\-()]+$/,
                msg: 'Invalid phone number format'
            }
        }
    },
    email: {
        type: DataTypes.STRING(128),
        allowNull: false,
        unique: true,
        validate: {
            isEmail: {
                msg: 'Must be a valid email address'
            }
        }
    },
    profilePhoto: {
        type: DataTypes.STRING(512),
        allowNull: true,
        comment: 'R2 bucket URL for profile photo'
    },
    isBlocked: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'Whether this partner is blocked from the system'
    },
    blockedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'Timestamp when partner was blocked'
    },
    blockedBy: {
        type: DataTypes.CHAR(36),
        allowNull: true,
        references: {
            model: 'accounts',
            key: 'uuid'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
        comment: 'Employee who blocked this partner'
    },
    blockedReason: {
        type: DataTypes.STRING(500),
        allowNull: true,
        comment: 'Reason for blocking the partner'
    },
    createdByEmployeeId: {
        type: DataTypes.CHAR(36),
        allowNull: true,
        references: {
            model: 'accounts',
            key: 'uuid'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
        comment: 'Employee who created this partner profile'
    }
}, {
    sequelize,
    modelName: 'PartnerProfile',
    tableName: 'partner_profiles',
    timestamps: true,
    underscored: true,
    indexes: [
        {
            unique: true,
            fields: ['account_id'],
            name: 'unique_partner_account'
        },
        {
            unique: true,
            fields: ['email'],
            name: 'unique_partner_email'
        },
        {
            fields: ['is_blocked'],
            name: 'idx_partner_is_blocked'
        },
        {
            fields: ['phone_number'],
            name: 'idx_partner_phone'
        }
    ],
    hooks: {
        beforeValidate: (partner, options) => {
            // Trim whitespace from string fields
            if (partner.partnerName) {
                partner.partnerName = partner.partnerName.trim();
            }
            if (partner.email) {
                partner.email = partner.email.trim().toLowerCase();
            }
            if (partner.phoneNumber) {
                partner.phoneNumber = partner.phoneNumber.trim();
            }
        }
    }
});

/**
 * Instance Methods
 */

// Block partner
PartnerProfile.prototype.block = async function(employeeId, reason) {
    this.isBlocked = true;
    this.blockedAt = new Date();
    this.blockedBy = employeeId;
    this.blockedReason = reason || 'No reason provided';
    return await this.save();
};

// Unblock partner
PartnerProfile.prototype.unblock = async function() {
    this.isBlocked = false;
    this.blockedAt = null;
    this.blockedBy = null;
    this.blockedReason = null;
    return await this.save();
};

// Update profile photo
PartnerProfile.prototype.updateProfilePhoto = async function(photoUrl) {
    this.profilePhoto = photoUrl;
    return await this.save();
};

/**
 * Class Methods
 */

// Get all active (non-blocked) partners
PartnerProfile.getActivePartners = async function() {
    return await PartnerProfile.findAll({
        where: { isBlocked: false },
        order: [['created_at', 'DESC']],
        include: [{
            association: 'account',
            attributes: ['uuid', 'role']
        }]
    });
};

// Get all blocked partners
PartnerProfile.getBlockedPartners = async function() {
    return await PartnerProfile.findAll({
        where: { isBlocked: true },
        order: [['blocked_at', 'DESC']],
        include: [
            {
                association: 'account',
                attributes: ['uuid', 'role']
            },
            {
                association: 'blockedByEmployee',
                attributes: ['uuid', 'firstName', 'lastName']
            }
        ]
    });
};

// Find partner by account ID
PartnerProfile.findByAccountId = async function(accountId) {
    return await PartnerProfile.findOne({
        where: { accountId },
        include: [{
            association: 'account',
            attributes: ['uuid', 'role', 'createdAt']
        }]
    });
};

// Find partner by email
PartnerProfile.findByEmail = async function(email) {
    return await PartnerProfile.findOne({
        where: { email: email.toLowerCase() }
    });
};

// Get partner with vehicle count
PartnerProfile.getPartnerWithVehicleCount = async function(partnerId) {
    const { Vehicle } = require('./index');
    return await PartnerProfile.findByPk(partnerId, {
        include: [
            {
                association: 'account',
                attributes: ['uuid', 'role']
            },
            {
                model: Vehicle,
                as: 'vehicles',
                attributes: [],
                required: false
            }
        ],
        attributes: {
            include: [
                [
                    sequelize.fn('COUNT', sequelize.col('vehicles.id')),
                    'vehicleCount'
                ]
            ]
        },
        group: ['PartnerProfile.id', 'account.uuid']
    });
};

module.exports = PartnerProfile;