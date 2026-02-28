// src/models/TripReceipt.js
//
// ═══════════════════════════════════════════════════════════════════════
// TRIP RECEIPT — Earnings Engine Idempotency Anchor
// ═══════════════════════════════════════════════════════════════════════
//
// One row per completed trip. This is the FIRST thing the earnings engine
// writes inside its transaction. If a row already exists for a tripId,
// the engine knows it already ran and returns early — preventing any
// double commission or double bonus posting.
//
// Think of it as the "receipt" WEGO issues internally when a trip ends.
//
// Lifecycle:
//   PENDING   → engine is currently processing (or crashed mid-way)
//   SETTLED   → all wallet entries written successfully
//   REFUNDED  → trip was disputed and refunded after the fact
//
// ═══════════════════════════════════════════════════════════════════════

const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class TripReceipt extends Model {}

TripReceipt.init(
    {
        // ── Primary Key ───────────────────────────────────────────────
        id: {
            type:         DataTypes.CHAR(36),
            primaryKey:   true,
            defaultValue: DataTypes.UUIDV4,
            comment:      'UUID primary key',
        },

        // ── Core references ───────────────────────────────────────────
        tripId: {
            type:       DataTypes.CHAR(36),
            allowNull:  false,
            unique:     true,        // ← THE idempotency guarantee
            field:      'tripId',
            references: { model: 'trips', key: 'id' },
            onDelete:   'RESTRICT',  // never delete a receipt if trip is deleted
            comment:    'FK → trips.id. UNIQUE enforces one receipt per trip.',
        },

        driverId: {
            type:       DataTypes.CHAR(36),
            allowNull:  false,
            field:      'driverId',
            references: { model: 'accounts', key: 'uuid' },
            comment:    'FK → accounts.uuid (the driver who earned)',
        },

        passengerId: {
            type:       DataTypes.CHAR(36),
            allowNull:  false,
            field:      'passengerId',
            references: { model: 'accounts', key: 'uuid' },
            comment:    'FK → accounts.uuid (the passenger who paid)',
        },

        // ── Fare breakdown ────────────────────────────────────────────
        grossFare: {
            type:      DataTypes.INTEGER,
            allowNull: false,
            field:     'grossFare',
            comment:   'Full fare the passenger paid (XAF, integer — no decimals in XAF)',
        },

        commissionRate: {
            type:         DataTypes.DECIMAL(5, 4),
            allowNull:    false,
            field:        'commissionRate',
            comment:      'Commission rate applied, e.g. 0.1000 = 10%. Stored for audit — rules may change over time.',
        },

        commissionAmount: {
            type:      DataTypes.INTEGER,
            allowNull: false,
            field:     'commissionAmount',
            comment:   'Amount taken by WEGO = grossFare * commissionRate, rounded to nearest XAF',
        },

        bonusTotal: {
            type:         DataTypes.INTEGER,
            allowNull:    false,
            defaultValue: 0,
            field:        'bonusTotal',
            comment:      'Sum of all per-trip bonuses credited to driver on this trip',
        },

        driverNet: {
            type:      DataTypes.INTEGER,
            allowNull: false,
            field:     'driverNet',
            comment:   'What driver actually earns = grossFare - commissionAmount + bonusTotal',
        },

        // ── Payment method (for payout routing later) ─────────────────
        paymentMethod: {
            type:         DataTypes.ENUM('CASH', 'MOMO', 'OM'),
            allowNull:    false,
            defaultValue: 'CASH',
            field:        'paymentMethod',
            comment:      'Payment method used on the trip — affects payout flow',
        },

        // ── Which earning rule was used for commission ─────────────────
        commissionRuleId: {
            type:      DataTypes.CHAR(36),
            allowNull: true,
            field:     'commissionRuleId',
            comment:   'FK → earning_rules.id — which rule was active at time of trip',
        },

        // ── Metadata for audit ────────────────────────────────────────
        appliedRules: {
            type:         DataTypes.JSON,
            allowNull:    true,
            field:        'appliedRules',
            comment:      'Snapshot of all rules evaluated + their result (applied/skipped). Never changes after write.',
            // Example:
            // [
            //   { ruleId: 'abc', type: 'COMMISSION_PERCENT', value: 0.10, applied: true },
            //   { ruleId: 'def', type: 'BONUS_FLAT',         value: 200,  applied: true,  label: 'Night bonus' },
            //   { ruleId: 'ghi', type: 'BONUS_FLAT',         value: 500,  applied: false, label: 'Airport bonus', reason: 'condition_not_met' }
            // ]
        },

        // ── Status ────────────────────────────────────────────────────
        status: {
            type:         DataTypes.ENUM('PENDING', 'SETTLED', 'REFUNDED'),
            allowNull:    false,
            defaultValue: 'PENDING',
            field:        'status',
            comment:      'PENDING while engine runs, SETTLED once all wallet entries exist, REFUNDED after dispute resolution',
        },

        // ── Timestamps ────────────────────────────────────────────────
        processedAt: {
            type:      DataTypes.DATE,
            allowNull: true,
            field:     'processedAt',
            comment:   'When the engine finished processing (status → SETTLED)',
        },

        createdAt: {
            type:      DataTypes.DATE,
            allowNull: false,
            field:     'createdAt',
        },

        updatedAt: {
            type:      DataTypes.DATE,
            allowNull: false,
            field:     'updatedAt',
        },
    },
    {
        sequelize,
        modelName:  'TripReceipt',
        tableName:  'trip_receipts',
        underscored: false,
        timestamps:  true,
        indexes: [
            // Primary lookup: "did this trip already get processed?"
            { unique: true, fields: ['tripId'],   name: 'trip_receipts_trip_id_unique' },

            // Driver earnings history (most common query)
            { fields: ['driverId', 'createdAt'],  name: 'trip_receipts_driver_date' },

            // Admin revenue reports by date
            { fields: ['createdAt'],              name: 'trip_receipts_created_at' },

            // Status filter (find PENDING = crashed mid-processing)
            { fields: ['status'],                 name: 'trip_receipts_status' },

            // Commission rule audit
            { fields: ['commissionRuleId'],       name: 'trip_receipts_rule' },
        ],
    }
);

module.exports = TripReceipt;