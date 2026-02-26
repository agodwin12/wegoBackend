// backend/src/models/ServiceDispute.js
// Service Dispute Model for Services Marketplace

const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class ServiceDispute extends Model {}

// ═══════════════════════════════════════════════════════════════════════
// MODEL DEFINITION
// ═══════════════════════════════════════════════════════════════════════

ServiceDispute.init(
    {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },

        dispute_id: {
            type: DataTypes.STRING(50),
            unique: true,
            allowNull: false,
            comment: 'Unique dispute identifier (e.g., DSP-20241218-001)',
        },

        // Request Reference
        request_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            comment: 'Service request ID',
        },

        // Parties Involved
        filed_by: {
            type: DataTypes.CHAR(36),
            allowNull: false,
            comment: 'Account UUID of person filing dispute',
        },

        filed_by_type: {
            type: DataTypes.ENUM('customer', 'provider'),
            allowNull: false,
            comment: 'Type of person filing dispute',
        },

        against_user: {
            type: DataTypes.CHAR(36),
            allowNull: false,
            comment: 'Account UUID of person dispute is against',
        },

        // Dispute Details
        dispute_type: {
            type: DataTypes.ENUM(
                'service_not_provided',
                'service_quality',
                'payment_issue',
                'behavior_conduct',
                'fraud_scam',
                'other'
            ),
            allowNull: false,
        },

        description: {
            type: DataTypes.TEXT,
            allowNull: false,
            comment: 'Detailed description of the dispute (min 50 chars)',
        },

        evidence_photos: {
            type: DataTypes.JSON,
            allowNull: true,
            comment: 'Array of evidence photo URLs (max 5)',
        },

        // Resolution Request
        resolution_requested: {
            type: DataTypes.ENUM(
                'full_refund',
                'partial_refund',
                'redo_service',
                'report_only'
            ),
            allowNull: false,
        },

        refund_amount: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: true,
            comment: 'Requested refund amount in FCFA',
        },

        // Status
        status: {
            type: DataTypes.ENUM(
                'open',
                'investigating',
                'awaiting_response',
                'resolved',
                'closed',
                'escalated'
            ),
            defaultValue: 'open',
            allowNull: false,
        },

        priority: {
            type: DataTypes.ENUM('low', 'medium', 'high', 'critical'),
            defaultValue: 'medium',
            allowNull: false,
        },

        // Other Party Response
        response_from_other_party: {
            type: DataTypes.TEXT,
            allowNull: true,
        },

        response_evidence: {
            type: DataTypes.JSON,
            allowNull: true,
            comment: 'Evidence from responding party',
        },

        responded_at: {
            type: DataTypes.DATE,
            allowNull: true,
        },

        // Admin Handling
        assigned_to: {
            type: DataTypes.INTEGER,
            allowNull: true,
            comment: 'Employee ID handling the dispute',
        },

        assigned_at: {
            type: DataTypes.DATE,
            allowNull: true,
        },

        investigation_notes: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'Admin notes during investigation',
        },

        // Resolution
        resolution_type: {
            type: DataTypes.ENUM(
                'favor_customer',
                'favor_provider',
                'mutual_agreement',
                'no_action',
                'partial_favor_customer',
                'partial_favor_provider'
            ),
            allowNull: true,
        },

        resolution_details: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'Details of how dispute was resolved',
        },

        refund_granted: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: true,
            comment: 'Actual refund amount granted',
        },

        resolved_by: {
            type: DataTypes.INTEGER,
            allowNull: true,
            comment: 'Employee ID who resolved dispute',
        },

        resolved_at: {
            type: DataTypes.DATE,
            allowNull: true,
        },

        // Financial Impact
        commission_released: {
            type: DataTypes.BOOLEAN,
            defaultValue: false,
            comment: 'Whether commission was released to provider',
        },

        commission_held: {
            type: DataTypes.BOOLEAN,
            defaultValue: false,
            comment: 'Whether commission is being held',
        },

        // Closure
        closed_at: {
            type: DataTypes.DATE,
            allowNull: true,
        },

        closed_reason: {
            type: DataTypes.TEXT,
            allowNull: true,
        },

        // Soft Delete
        deleted_at: {
            type: DataTypes.DATE,
            allowNull: true,
        },
    },
    {
        sequelize,
        modelName: 'ServiceDispute',
        tableName: 'service_disputes',
        timestamps: true,
        paranoid: true,
        underscored: true,
    }
);

module.exports = ServiceDispute;