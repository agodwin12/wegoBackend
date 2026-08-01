// backend/src/models/ServiceListingReport.js
// User reports of a service listing (fraud / scam / spam / wrong info etc.).
// Powers the trust/safety loop: a customer flags a live listing, it surfaces in
// the backoffice reports queue, and an admin actions it (deactivate/suspend).

const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class ServiceListingReport extends Model {}

ServiceListingReport.init(
    {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },

        listing_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            comment: 'Reported ServiceListing.id',
        },

        reporter_id: {
            type: DataTypes.CHAR(36),
            allowNull: false,
            comment: 'Account UUID of the user who filed the report',
        },

        reason_category: {
            type: DataTypes.ENUM('scam', 'spam', 'inappropriate', 'wrong_info', 'impersonation', 'other'),
            allowNull: false,
        },

        reason_text: {
            type: DataTypes.STRING(500),
            allowNull: true,
        },

        status: {
            type: DataTypes.ENUM('open', 'reviewing', 'actioned', 'dismissed'),
            allowNull: false,
            defaultValue: 'open',
        },

        resolution_note: {
            type: DataTypes.STRING(500),
            allowNull: true,
        },

        resolved_by: {
            type: DataTypes.INTEGER,
            allowNull: true,
            comment: 'Employee id who resolved the report',
        },

        resolved_at: {
            type: DataTypes.DATE,
            allowNull: true,
        },
    },
    {
        sequelize,
        modelName: 'ServiceListingReport',
        tableName: 'service_listing_reports',
        timestamps: true,
        underscored: true,
        indexes: [
            { name: 'idx_slr_status_created', fields: ['status', 'created_at'] },
            { name: 'idx_slr_listing',        fields: ['listing_id'] },
            // One open report per user per listing — prevents a single user
            // spamming the queue for the same listing.
            { name: 'uq_slr_reporter_listing', unique: true, fields: ['listing_id', 'reporter_id'] },
        ],
    }
);

module.exports = ServiceListingReport;
