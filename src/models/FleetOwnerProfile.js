// src/models/FleetOwnerProfile.js
//
// KYC profile for a ride-hailing FLEET OWNER (created by WeGo staff in the
// backoffice). Completely separate from the vehicle-rental PartnerProfile.

const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class FleetOwnerProfile extends Model {}

FleetOwnerProfile.init({
    id: {
        type: DataTypes.CHAR(36),
        primaryKey: true,
        allowNull: false,
    },
    accountId: {
        type: DataTypes.CHAR(36),
        allowNull: false,
        unique: true,
        field: 'account_id',
        comment: 'Links to the FLEET_OWNER account (accounts.uuid)',
    },
    companyName:  { type: DataTypes.STRING(128), allowNull: false, field: 'company_name' },
    contactName:  { type: DataTypes.STRING(128), allowNull: true,  field: 'contact_name' },
    phoneNumber:  { type: DataTypes.STRING(20),  allowNull: false, field: 'phone_number' },
    email:        { type: DataTypes.STRING(128), allowNull: false },
    address:      { type: DataTypes.STRING(255), allowNull: true },
    profilePhoto: { type: DataTypes.STRING(512), allowNull: true,  field: 'profile_photo' },

    // KYC documents (R2 URLs)
    idCardFrontUrl: { type: DataTypes.STRING(512), allowNull: true, field: 'id_card_front_url' },
    idCardBackUrl:  { type: DataTypes.STRING(512), allowNull: true, field: 'id_card_back_url' },
    niuNumber:      { type: DataTypes.STRING(50),  allowNull: true, field: 'niu_number' },
    niuDocumentUrl: { type: DataTypes.STRING(512), allowNull: true, field: 'niu_document_url' },

    createdByEmployeeId: { type: DataTypes.CHAR(36), allowNull: true, field: 'created_by_employee_id' },
}, {
    sequelize,
    modelName: 'FleetOwnerProfile',
    tableName: 'fleet_owner_profiles',
    timestamps: true,
    underscored: true,
});

module.exports = FleetOwnerProfile;
