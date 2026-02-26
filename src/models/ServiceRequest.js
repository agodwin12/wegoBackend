// backend/src/models/ServiceRequest.js
// Service Request Model for Services Marketplace

const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class ServiceRequest extends Model {}

// ═══════════════════════════════════════════════════════════════════════
// MODEL DEFINITION
// ═══════════════════════════════════════════════════════════════════════

ServiceRequest.init(
    {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },

        request_id: {
            type: DataTypes.STRING(50),
            unique: true,
            allowNull: false,
            comment: 'Unique request identifier (e.g., SRV-20241218-12345)',
        },

        // Listing & Provider
        listing_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            comment: 'Service listing ID',
        },

        provider_id: {
            type: DataTypes.CHAR(36),
            allowNull: false,
            comment: 'Account UUID of service provider',
        },

        // Customer
        customer_id: {
            type: DataTypes.CHAR(36),
            allowNull: false,
            comment: 'Account UUID of customer',
        },

        // Request Details
        description: {
            type: DataTypes.TEXT,
            allowNull: false,
            comment: 'Customer description of need (min 20 chars)',
        },

        photos: {
            type: DataTypes.JSON,
            allowNull: true,
            comment: 'Array of photo URLs (max 3)',
        },

        // Scheduling
        needed_when: {
            type: DataTypes.ENUM('asap', 'today', 'tomorrow', 'scheduled'),
            defaultValue: 'asap',
            allowNull: false,
        },

        scheduled_date: {
            type: DataTypes.DATEONLY,
            allowNull: true,
        },

        scheduled_time: {
            type: DataTypes.TIME,
            allowNull: true,
        },

        // Location
        service_location: {
            type: DataTypes.STRING(255),
            allowNull: false,
            comment: 'Address/location for service',
        },

        latitude: {
            type: DataTypes.DECIMAL(10, 7),
            allowNull: true,
        },

        longitude: {
            type: DataTypes.DECIMAL(10, 7),
            allowNull: true,
        },

        // Budget
        customer_budget: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: true,
            comment: 'Customer estimated budget in FCFA',
        },

        // Status
        status: {
            type: DataTypes.ENUM(
                'pending',
                'accepted',
                'rejected',
                'in_progress',
                'payment_pending',
                'payment_confirmation_pending',
                'payment_confirmed',
                'completed',
                'cancelled',
                'disputed'
            ),
            defaultValue: 'pending',
            allowNull: false,
        },

        // Provider Response
        provider_response: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'Provider response message',
        },

        accepted_at: {
            type: DataTypes.DATE,
            allowNull: true,
        },

        rejected_at: {
            type: DataTypes.DATE,
            allowNull: true,
        },

        rejection_reason: {
            type: DataTypes.TEXT,
            allowNull: true,
        },

        // Service Execution
        started_at: {
            type: DataTypes.DATE,
            allowNull: true,
            comment: 'When provider marked "On My Way" or "Started"',
        },

        completed_at: {
            type: DataTypes.DATE,
            allowNull: true,
        },

        // Work Summary
        work_summary: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'Provider work summary',
        },

        hours_worked: {
            type: DataTypes.DECIMAL(5, 2),
            allowNull: true,
        },

        materials_cost: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: true,
        },

        final_amount: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: true,
            comment: 'Final service amount in FCFA',
        },

        after_photos: {
            type: DataTypes.JSON,
            allowNull: true,
            comment: 'Array of after-work photo URLs',
        },

        // Payment
        payment_method: {
            type: DataTypes.ENUM('mtn_momo', 'orange_money', 'cash'),
            allowNull: true,
        },

        payment_proof_url: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'Customer payment proof screenshot',
        },

        payment_reference: {
            type: DataTypes.STRING(100),
            allowNull: true,
        },

        payment_marked_at: {
            type: DataTypes.DATE,
            allowNull: true,
            comment: 'When customer marked payment as paid',
        },

        payment_confirmed_at: {
            type: DataTypes.DATE,
            allowNull: true,
            comment: 'When provider confirmed payment received',
        },

        // Commission
        commission_percentage: {
            type: DataTypes.DECIMAL(5, 2),
            defaultValue: 15.00,
            comment: 'Platform commission percentage',
        },

        commission_amount: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: true,
            comment: 'Platform commission in FCFA',
        },

        provider_net_amount: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: true,
            comment: 'Provider net earnings after commission',
        },

        // Cancellation
        cancelled_by: {
            type: DataTypes.CHAR(36),
            allowNull: true,
            comment: 'Account UUID of who cancelled',
        },

        cancelled_at: {
            type: DataTypes.DATE,
            allowNull: true,
        },

        cancellation_reason: {
            type: DataTypes.TEXT,
            allowNull: true,
        },

        // Expiry
        expires_at: {
            type: DataTypes.DATE,
            allowNull: true,
            comment: 'Request expiry time if not accepted',
        },

        // Soft Delete
        deleted_at: {
            type: DataTypes.DATE,
            allowNull: true,
        },
    },
    {
        sequelize,
        modelName: 'ServiceRequest',
        tableName: 'service_requests',
        timestamps: true,
        paranoid: true,
        underscored: true,
    }
);

module.exports = ServiceRequest;