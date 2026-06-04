// models/ServiceRequest.js
// Service Request Model for Services Marketplace
//
// CHANGELOG:
//   v2 — WeGo no longer intermediates payment between customer and provider.
//        A service request is now purely a contact/booking thread.
//        Customer reaches out → provider responds → they execute and settle
//        payment directly between themselves (cash, mobile money, whatever).
//        WeGo has no visibility into the payment and takes no commission.
//
//        STATUS ENUM simplified:
//          REMOVED: payment_pending, payment_confirmation_pending,
//                   payment_confirmed
//          KEPT:    pending, accepted, rejected, in_progress,
//                   completed, cancelled, disputed
//
//        PAYMENT COLUMNS: kept in the table as nullable/dead columns so the
//        DB migration is non-destructive (no data loss on existing rows).
//        They are no longer written by any controller. Marked [DEPRECATED].
//
//        COMMISSION COLUMNS: same — kept, never written, marked [DEPRECATED].

const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class ServiceRequest extends Model {

    // ── Associations ──────────────────────────────────────────────────────────
    static associate(models) {
        // Which listing this request is for
        ServiceRequest.belongsTo(models.ServiceListing, {
            foreignKey: 'listing_id',
            as:         'listing',
        });

        // The provider (owner of the listing)
        ServiceRequest.belongsTo(models.Account, {
            foreignKey: 'provider_id',
            targetKey:  'uuid',
            as:         'provider',
        });

        // The customer who sent the request
        ServiceRequest.belongsTo(models.Account, {
            foreignKey: 'customer_id',
            targetKey:  'uuid',
            as:         'customer',
        });

        // Rating left after completion
        ServiceRequest.hasOne(models.ServiceRating, {
            foreignKey: 'request_id',
            as:         'rating',
        });

        // Dispute filed against this request
        ServiceRequest.hasOne(models.ServiceDispute, {
            foreignKey: 'request_id',
            as:         'dispute',
        });
    }
}

// ═══════════════════════════════════════════════════════════════════════
// MODEL DEFINITION
// ═══════════════════════════════════════════════════════════════════════

ServiceRequest.init(
    {
        id: {
            type:          DataTypes.INTEGER,
            primaryKey:    true,
            autoIncrement: true,
        },

        request_id: {
            type:      DataTypes.STRING(50),
            unique:    true,
            allowNull: false,
            comment:   'Unique request identifier (e.g., SRV-20241218-12345)',
        },

        // ── Listing & Provider ────────────────────────────────────────────────
        listing_id: {
            type:      DataTypes.INTEGER,
            allowNull: false,
            comment:   'Service listing ID',
        },

        provider_id: {
            type:      DataTypes.CHAR(36),
            allowNull: false,
            comment:   'Account UUID of service provider',
        },

        // ── Customer ──────────────────────────────────────────────────────────
        customer_id: {
            type:      DataTypes.CHAR(36),
            allowNull: false,
            comment:   'Account UUID of customer',
        },

        // ── Request Details ───────────────────────────────────────────────────
        description: {
            type:      DataTypes.TEXT,
            allowNull: false,
            comment:   'Customer description of need (min 20 chars)',
        },

        photos: {
            type:      DataTypes.JSON,
            allowNull: true,
            comment:   'Array of photo URLs submitted by customer (max 3)',
        },

        // ── Scheduling ────────────────────────────────────────────────────────
        needed_when: {
            type:         DataTypes.ENUM('asap', 'today', 'tomorrow', 'scheduled'),
            defaultValue: 'asap',
            allowNull:    false,
        },

        scheduled_date: {
            type:      DataTypes.DATEONLY,
            allowNull: true,
        },

        scheduled_time: {
            type:      DataTypes.TIME,
            allowNull: true,
        },

        // ── Location ──────────────────────────────────────────────────────────
        service_location: {
            type:      DataTypes.STRING(255),
            allowNull: false,
            comment:   'Address/location where service is needed',
        },

        latitude: {
            type:      DataTypes.DECIMAL(10, 7),
            allowNull: true,
        },

        longitude: {
            type:      DataTypes.DECIMAL(10, 7),
            allowNull: true,
        },

        // ── Budget ────────────────────────────────────────────────────────────
        customer_budget: {
            type:      DataTypes.DECIMAL(10, 2),
            allowNull: true,
            comment:   'Customer estimated budget in XAF (informational only)',
        },

        // ── Status ────────────────────────────────────────────────────────────
        //
        // LIFECYCLE:
        //
        //   pending      → customer sent request, waiting for provider response
        //   accepted     → provider accepted, coordinating with customer
        //   rejected     → provider declined the request
        //   in_progress  → provider marked service as started
        //   completed    → provider marked service as done
        //   cancelled    → either party cancelled before completion
        //   disputed     → customer or provider filed a dispute
        //
        // Payment is settled directly between customer and provider.
        // WeGo has no payment states in this flow.
        //
        status: {
            type: DataTypes.ENUM(
                'pending',
                'accepted',
                'rejected',
                'in_progress',
                'completed',
                'cancelled',
                'disputed'
            ),
            defaultValue: 'pending',
            allowNull:    false,
        },

        // ── Provider Response ─────────────────────────────────────────────────
        provider_response: {
            type:      DataTypes.TEXT,
            allowNull: true,
            comment:   'Provider message when accepting or negotiating',
        },

        accepted_at: {
            type:      DataTypes.DATE,
            allowNull: true,
        },

        rejected_at: {
            type:      DataTypes.DATE,
            allowNull: true,
        },

        rejection_reason: {
            type:      DataTypes.TEXT,
            allowNull: true,
        },

        // ── Service Execution ─────────────────────────────────────────────────
        started_at: {
            type:      DataTypes.DATE,
            allowNull: true,
            comment:   'When provider marked service as started / on the way',
        },

        completed_at: {
            type:      DataTypes.DATE,
            allowNull: true,
        },

        // ── Work Summary ──────────────────────────────────────────────────────
        work_summary: {
            type:      DataTypes.TEXT,
            allowNull: true,
            comment:   'Provider summary of work done',
        },

        hours_worked: {
            type:      DataTypes.DECIMAL(5, 2),
            allowNull: true,
        },

        materials_cost: {
            type:      DataTypes.DECIMAL(10, 2),
            allowNull: true,
            comment:   'Materials cost in XAF (informational, filled by provider)',
        },

        // final_amount: what provider tells customer the job cost.
        // WeGo does not collect or verify this — purely informational for
        // both parties and for dispute resolution context.
        final_amount: {
            type:      DataTypes.DECIMAL(10, 2),
            allowNull: true,
            comment:   'Final agreed amount in XAF. Informational only — settled directly.',
        },

        after_photos: {
            type:      DataTypes.JSON,
            allowNull: true,
            comment:   'Array of after-work photo URLs uploaded by provider',
        },

        // ── Cancellation ──────────────────────────────────────────────────────
        cancelled_by: {
            type:      DataTypes.CHAR(36),
            allowNull: true,
            comment:   'Account UUID of whoever cancelled',
        },

        cancelled_at: {
            type:      DataTypes.DATE,
            allowNull: true,
        },

        cancellation_reason: {
            type:      DataTypes.TEXT,
            allowNull: true,
        },

        // ── Request Expiry ────────────────────────────────────────────────────
        expires_at: {
            type:      DataTypes.DATE,
            allowNull: true,
            comment:   'Auto-expire if provider does not respond (asap/today requests)',
        },

        // ─────────────────────────────────────────────────────────────────────
        // [DEPRECATED] — kept as dead nullable columns for non-destructive migration.
        // No controller writes to these anymore. Will be dropped in a future
        // migration once confirmed safe.
        // ─────────────────────────────────────────────────────────────────────

        payment_method: {
            type:      DataTypes.ENUM('mtn_momo', 'orange_money', 'cash'),
            allowNull: true,
            comment:   '[DEPRECATED] Payment now settled directly between parties.',
        },

        payment_proof_url: {
            type:      DataTypes.TEXT,
            allowNull: true,
            comment:   '[DEPRECATED]',
        },

        payment_reference: {
            type:      DataTypes.STRING(100),
            allowNull: true,
            comment:   '[DEPRECATED]',
        },

        payment_marked_at: {
            type:      DataTypes.DATE,
            allowNull: true,
            comment:   '[DEPRECATED]',
        },

        payment_confirmed_at: {
            type:      DataTypes.DATE,
            allowNull: true,
            comment:   '[DEPRECATED]',
        },

        commission_percentage: {
            type:         DataTypes.DECIMAL(5, 2),
            defaultValue: 0,
            comment:      '[DEPRECATED] WeGo no longer takes commission on service requests.',
        },

        commission_amount: {
            type:      DataTypes.DECIMAL(10, 2),
            allowNull: true,
            comment:   '[DEPRECATED]',
        },

        provider_net_amount: {
            type:      DataTypes.DECIMAL(10, 2),
            allowNull: true,
            comment:   '[DEPRECATED]',
        },

        // ── Soft Delete ───────────────────────────────────────────────────────
        deleted_at: {
            type:      DataTypes.DATE,
            allowNull: true,
        },
    },
    {
        sequelize,
        modelName:   'ServiceRequest',
        tableName:   'service_requests',
        timestamps:  true,
        paranoid:    true,
        underscored: true,

        indexes: [
            // Provider inbox: all incoming requests
            {
                fields: ['provider_id', 'status'],
                name:   'sr_provider_status',
            },
            // Customer: my requests
            {
                fields: ['customer_id', 'status'],
                name:   'sr_customer_status',
            },
            // Duplicate request guard (customer + listing + active statuses)
            {
                fields: ['listing_id', 'customer_id', 'status'],
                name:   'sr_listing_customer_status',
            },
            // Expiry cron: find pending requests past expires_at
            {
                fields: ['status', 'expires_at'],
                name:   'sr_expiry_cron',
            },
        ],
    }
);

module.exports = ServiceRequest;