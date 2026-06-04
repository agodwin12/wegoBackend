// models/ServiceListing.js
// Service Listing Model for Services Marketplace
//
// CHANGELOG:
//   v2 — Classifieds/ads model. WeGo no longer intermediates payments between
//        customer and provider. Instead WeGo monetizes via listing plans (ad
//        duration). Added plan, expiry, hero, and boost fields.
//        Status ENUM extended: added 'pending_review', 'expired', 'hero_pending'.
//        Nothing removed — all original fields kept for backward compatibility.

const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class ServiceListing extends Model {

    // ── Computed: is this listing currently live and not expired? ─────────────
    get isLive() {
        if (this.status !== 'active') return false;
        if (!this.plan_expires_at) return false;
        return new Date(this.plan_expires_at) > new Date();
    }

    // ── Computed: days until plan expires (0 if already expired) ─────────────
    get daysUntilExpiry() {
        if (!this.plan_expires_at) return 0;
        const diff = new Date(this.plan_expires_at) - new Date();
        return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
    }

    // ── Associations ──────────────────────────────────────────────────────────
    static associate(models) {
        // Category
        ServiceListing.belongsTo(models.ServiceCategory, {
            foreignKey: 'category_id',
            as: 'category',
        });

        // Provider (Account)
        ServiceListing.belongsTo(models.Account, {
            foreignKey: 'provider_id',
            targetKey:  'uuid',
            as:         'provider',
        });

        // Employee who approved the listing content
        ServiceListing.belongsTo(models.Employee, {
            foreignKey:  'approved_by',
            as:          'approver',
            constraints: false,
        });

        // Employee who rejected the listing content
        ServiceListing.belongsTo(models.Employee, {
            foreignKey:  'rejected_by',
            as:          'rejecter',
            constraints: false,
        });

        // Ratings for this listing
        ServiceListing.hasMany(models.ServiceRating, {
            foreignKey: 'listing_id',
            as:         'ratings',
        });

        // All ad payment records for this listing (full history)
        ServiceListing.hasMany(models.ServiceAdPayment, {
            foreignKey: 'listing_id',
            as:         'adPayments',
        });

        // Active plan reference (convenience — latest active ServiceAdPayment)
        ServiceListing.hasOne(models.ServiceAdPayment, {
            foreignKey: 'listing_id',
            as:         'activePlan',
            scope:      { status: 'active' },
        });

        // The plan tier currently applied
        ServiceListing.belongsTo(models.ServiceListingPlan, {
            foreignKey:  'current_plan_id',
            as:          'currentPlan',
            constraints: false,
        });
    }
}

// ═══════════════════════════════════════════════════════════════════════
// MODEL DEFINITION
// ═══════════════════════════════════════════════════════════════════════

ServiceListing.init(
    {
        id: {
            type:          DataTypes.INTEGER,
            primaryKey:    true,
            autoIncrement: true,
        },

        listing_id: {
            type:      DataTypes.STRING(50),
            unique:    true,
            allowNull: false,
            comment:   'Unique listing identifier (e.g., LIST-20241218-12345)',
        },

        // ── Provider ──────────────────────────────────────────────────────────
        provider_id: {
            type:      DataTypes.CHAR(36),
            allowNull: false,
            comment:   'Account UUID of service provider',
        },

        // ── Category ──────────────────────────────────────────────────────────
        category_id: {
            type:      DataTypes.INTEGER,
            allowNull: false,
            comment:   'Service category ID',
        },

        // ── Service Details ───────────────────────────────────────────────────
        title: {
            type:      DataTypes.STRING(200),
            allowNull: false,
            comment:   'Service title (min 10, max 200 chars)',
        },

        description: {
            type:      DataTypes.TEXT,
            allowNull: false,
            comment:   'Service description (min 50, max 2000 chars)',
        },

        // ── Pricing (provider's own rates — WeGo does not touch this money) ──
        pricing_type: {
            type:         DataTypes.ENUM('hourly', 'fixed', 'negotiable'),
            allowNull:    false,
            defaultValue: 'fixed',
        },

        hourly_rate: {
            type:      DataTypes.DECIMAL(10, 2),
            allowNull: true,
            comment:   'Hourly rate in XAF',
        },

        minimum_charge: {
            type:      DataTypes.DECIMAL(10, 2),
            allowNull: true,
            comment:   'Minimum charge for hourly services',
        },

        fixed_price: {
            type:      DataTypes.DECIMAL(10, 2),
            allowNull: true,
            comment:   'Fixed price in XAF',
        },

        // ── Location ──────────────────────────────────────────────────────────
        city: {
            type:      DataTypes.STRING(100),
            allowNull: false,
        },

        neighborhoods: {
            type:      DataTypes.JSON,
            allowNull: true,
            comment:   'Array of neighborhoods served',
        },

        service_radius_km: {
            type:      DataTypes.INTEGER,
            allowNull: true,
            comment:   'Service radius in kilometers',
        },

        // ── Photos ────────────────────────────────────────────────────────────
        // Max photos is enforced by the active plan's max_photos field.
        // Controller checks ServiceListingPlan.max_photos at upload time.
        photos: {
            type:      DataTypes.JSON,
            allowNull: true,
            comment:   'Array of photo URLs. Limit enforced by active plan.',
        },

        // ── Availability ──────────────────────────────────────────────────────
        available_days: {
            type:      DataTypes.JSON,
            allowNull: true,
            comment:   'Array of available days',
        },

        available_hours: {
            type:      DataTypes.STRING(100),
            allowNull: true,
            comment:   'Available hours (e.g., "08:00-18:00")',
        },

        emergency_service: {
            type:         DataTypes.BOOLEAN,
            defaultValue: false,
            comment:      'Offers 24/7 emergency service',
        },

        // ── Experience & Portfolio ────────────────────────────────────────────
        years_experience: {
            type:      DataTypes.INTEGER,
            allowNull: true,
        },

        certifications: {
            type:      DataTypes.TEXT,
            allowNull: true,
        },

        portfolio_links: {
            type:      DataTypes.JSON,
            allowNull: true,
            comment:   'Array of portfolio URLs',
        },

        // ── Status ────────────────────────────────────────────────────────────
        // 6182

        //
        //   draft          → saved but not yet submitted for review
        //   pending_review → submitted, awaiting admin content moderation
        //   active         → live in marketplace, plan running
        //   expired        → plan period ended, hidden from marketplace
        //   rejected       → content rejected by admin (provider can edit & resubmit)
        //   inactive       → manually hidden by provider or admin
        //   hero_pending   → paid hero plan confirmed, awaiting admin hero approval
        //   suspended      → admin suspended (policy violation etc.)
        //
        // NOTE: 'approved' and 'deleted' kept in ENUM for backward compat with
        //       existing rows and the admin listing controller.
        //
        status: {
            type: DataTypes.ENUM(
                'draft',
                'pending_review',
                'approved',       // kept for backward compat
                'active',
                'expired',
                'rejected',
                'inactive',
                'hero_pending',
                'suspended',
                'deleted'         // kept for backward compat
            ),
            defaultValue: 'draft',
            allowNull:    false,
        },

        rejection_reason: {
            type:      DataTypes.TEXT,
            allowNull: true,
            comment:   'Reason for rejection (if rejected by admin)',
        },

        approved_by: {
            type:      DataTypes.INTEGER,
            allowNull: true,
            comment:   'Employee ID who approved the listing content',
        },

        approved_at: {
            type:      DataTypes.DATE,
            allowNull: true,
        },

        rejected_by: {
            type:      DataTypes.INTEGER,
            allowNull: true,
            comment:   'Employee ID who rejected the listing content',
        },

        rejected_at: {
            type:      DataTypes.DATE,
            allowNull: true,
        },

        // ── Ad Plan & Expiry (NEW) ────────────────────────────────────────────
        // current_plan_id: FK to ServiceListingPlan — which tier is active
        // plan_expires_at: when this listing auto-expires (set on activation)
        // plan_activated_at: when the current plan period started
        //
        // These three fields are the source of truth for whether a listing is
        // live. The cron job reads plan_expires_at to expire listings daily.
        current_plan_id: {
            type:      DataTypes.INTEGER,
            allowNull: true,
            comment:   'FK to ServiceListingPlan — which plan tier is currently active',
        },

        plan_expires_at: {
            type:      DataTypes.DATE,
            allowNull: true,
            comment:   'When the current plan period ends. Cron job expires listing after this.',
        },

        plan_activated_at: {
            type:      DataTypes.DATE,
            allowNull: true,
            comment:   'When the current active plan period started',
        },

        // ── Hero / Featured Placement (NEW) ───────────────────────────────────
        // is_hero: true means listing appears in the hero carousel
        // hero_approved_at: when admin approved the hero placement
        // hero_expires_at: hero placement can expire independently of the base plan
        //   (e.g. hero boost lasts 30 days even if annual plan runs longer)
        is_hero: {
            type:         DataTypes.BOOLEAN,
            allowNull:    false,
            defaultValue: false,
            comment:      'Shows in hero/featured carousel. Set by admin after hero plan payment.',
        },

        hero_approved_at: {
            type:      DataTypes.DATE,
            allowNull: true,
            comment:   'When admin approved the hero placement',
        },

        hero_expires_at: {
            type:      DataTypes.DATE,
            allowNull: true,
            comment:   'When the hero placement period ends (may differ from plan_expires_at)',
        },

        // ── Search Boost (NEW) ────────────────────────────────────────────────
        // Copied from the plan's boost_priority at activation time.
        // Allows admin to manually override boost for editorial picks.
        boost_priority: {
            type:         DataTypes.INTEGER,
            allowNull:    false,
            defaultValue: 0,
            comment:      '0 = no boost | 1 = standard | 2 = premium. Used for search ranking.',
        },

        // ── Statistics ────────────────────────────────────────────────────────
        view_count: {
            type:         DataTypes.INTEGER,
            defaultValue: 0,
        },

        contact_count: {
            type:         DataTypes.INTEGER,
            defaultValue: 0,
            comment:      'Number of times a customer sent a request for this listing',
        },

        booking_count: {
            type:         DataTypes.INTEGER,
            defaultValue: 0,
            comment:      'Number of completed service requests linked to this listing',
        },

        // ── Rating ────────────────────────────────────────────────────────────
        average_rating: {
            type:      DataTypes.DECIMAL(3, 2),
            allowNull: true,
            comment:   'Average rating (0.00 - 5.00)',
        },

        total_reviews: {
            type:         DataTypes.INTEGER,
            defaultValue: 0,
        },

        // ── Soft Delete ───────────────────────────────────────────────────────
        deleted_at: {
            type:      DataTypes.DATE,
            allowNull: true,
        },
    },
    {
        sequelize,
        modelName:   'ServiceListing',
        tableName:   'service_listings',
        timestamps:  true,
        paranoid:    true,
        underscored: true,

        indexes: [
            // Marketplace browse: active listings by city
            {
                fields: ['status', 'city'],
                name:   'sl_status_city',
            },
            // Hero carousel query
            {
                fields: ['is_hero', 'status', 'hero_expires_at'],
                name:   'sl_hero_active',
            },
            // Cron expiry job: find active listings whose plan has run out
            {
                fields: ['status', 'plan_expires_at'],
                name:   'sl_expiry_cron',
            },
            // Provider's own listings dashboard
            {
                fields: ['provider_id', 'status'],
                name:   'sl_provider_status',
            },
            // Search ranking: active + boosted
            {
                fields: ['status', 'boost_priority', 'average_rating'],
                name:   'sl_search_rank',
            },
            // Category browse
            {
                fields: ['category_id', 'status'],
                name:   'sl_category_status',
            },
        ],
    }
);

module.exports = ServiceListing;