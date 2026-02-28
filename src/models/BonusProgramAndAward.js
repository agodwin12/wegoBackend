// backend/models/BonusProgramAndAward.js
'use strict';

const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

// ═══════════════════════════════════════════════════════════════════════
// BONUS PROGRAM
// Quest / milestone definitions. Each program defines a target metric
// (e.g. complete 10 trips today) and the XAF bonus to award when hit.
// ═══════════════════════════════════════════════════════════════════════

class BonusProgram extends Model {

    // Returns the period key string used to detect if a driver already
    // earned this program in the current period.
    // Examples: "2026-02-28" (daily), "2026-W09" (weekly), "2026-02" (monthly)
    static getPeriodKey(period, date = new Date()) {
        switch (period) {
            case 'DAILY': {
                return date.toISOString().split('T')[0]; // "2026-02-28"
            }
            case 'WEEKLY': {
                // ISO week number
                const d    = new Date(date);
                const day  = d.getUTCDay() || 7;
                d.setUTCDate(d.getUTCDate() + 4 - day);
                const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
                const week      = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
                return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
            }
            case 'MONTHLY': {
                return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
            }
            case 'LIFETIME':
            default:
                return 'lifetime';
        }
    }
}

BonusProgram.init(
    {
        id: {
            type:         DataTypes.CHAR(36),
            primaryKey:   true,
            defaultValue: DataTypes.UUIDV4,
        },
        name: {
            type:      DataTypes.STRING(150),
            allowNull: false,
        },
        description: {
            type:      DataTypes.TEXT,
            allowNull: true,
        },

        // Type determines what metric is measured
        type: {
            type: DataTypes.ENUM(
                'DAILY_TRIPS',
                'WEEKLY_TRIPS',
                'MONTHLY_TRIPS',
                'LIFETIME_TRIPS',
                'DAILY_EARNINGS',
                'WEEKLY_EARNINGS',
                'MONTHLY_EARNINGS'
            ),
            allowNull: false,
        },

        // Period for resetting progress
        period: {
            type:      DataTypes.ENUM('DAILY', 'WEEKLY', 'MONTHLY', 'LIFETIME'),
            allowNull: false,
        },

        // The threshold to reach (trips or XAF)
        targetValue: {
            type:      DataTypes.INTEGER,
            allowNull: false,
            comment:   'Number of trips OR XAF earnings to hit',
        },

        // The XAF bonus awarded when target is reached
        bonusAmount: {
            type:      DataTypes.INTEGER,
            allowNull: false,
            comment:   'XAF credited to driver wallet when target is hit',
        },

        // Optional JSON conditions (e.g. city restriction)
        conditions: {
            type:         DataTypes.JSON,
            allowNull:    false,
            defaultValue: {},
        },

        // Display
        iconEmoji: {
            type:         DataTypes.STRING(10),
            allowNull:    true,
            defaultValue: '🏆',
        },
        displayOrder: {
            type:         DataTypes.INTEGER,
            allowNull:    false,
            defaultValue: 0,
        },

        // Date range validity
        validFrom: {
            type:      DataTypes.DATEONLY,
            allowNull: true,
        },
        validTo: {
            type:      DataTypes.DATEONLY,
            allowNull: true,
        },

        isActive: {
            type:         DataTypes.BOOLEAN,
            allowNull:    false,
            defaultValue: true,
        },

        // ─────────────────────────────────────────────────────────────
        // ⚠️  INTEGER — matches employees.id (auto-increment int PK)
        // ─────────────────────────────────────────────────────────────
        createdBy: {
            type:      DataTypes.INTEGER,
            allowNull: true,
        },
        updatedBy: {
            type:      DataTypes.INTEGER,
            allowNull: true,
        },

        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
    },
    {
        sequelize,
        modelName:   'BonusProgram',
        tableName:   'bonus_programs',
        underscored: false,
        timestamps:  true,
        indexes: [
            { fields: ['isActive'],                       name: 'bonus_programs_active'      },
            { fields: ['type'],                           name: 'bonus_programs_type'        },
            { fields: ['period'],                         name: 'bonus_programs_period'      },
            { fields: ['validFrom', 'validTo'],           name: 'bonus_programs_date_range'  },
            { fields: ['displayOrder'],                   name: 'bonus_programs_order'       },
        ],
    }
);

// ═══════════════════════════════════════════════════════════════════════
// BONUS AWARD
// One record per driver per program per period.
// UNIQUE(driverId, programId, periodKey) prevents double-awarding.
// ═══════════════════════════════════════════════════════════════════════

class BonusAward extends Model {}

BonusAward.init(
    {
        id: {
            type:         DataTypes.CHAR(36),
            primaryKey:   true,
            defaultValue: DataTypes.UUIDV4,
        },

        // Driver who earned it — UUID (matches Account.uuid)
        driverId: {
            type:      DataTypes.CHAR(36),
            allowNull: false,
        },

        // Which program was completed
        programId: {
            type:      DataTypes.CHAR(36),
            allowNull: false,
        },

        // Idempotency: "2026-02-28", "2026-W09", "2026-02", "lifetime"
        periodKey: {
            type:      DataTypes.STRING(20),
            allowNull: false,
        },

        // The transaction that credited the wallet
        walletTransactionId: {
            type:      DataTypes.CHAR(36),
            allowNull: true,
        },

        // The trip that pushed the driver over the target
        triggerTripId: {
            type:      DataTypes.CHAR(36),
            allowNull: true,
        },

        awardedAmount: {
            type:      DataTypes.INTEGER,
            allowNull: false,
            comment:   'XAF awarded — snapshot of bonusAmount at time of award',
        },

        // The metric value at time of award (e.g. "10 trips" or "55000 XAF")
        metricAtAward: {
            type:      DataTypes.INTEGER,
            allowNull: true,
        },

        awardedAt: {
            type:         DataTypes.DATE,
            allowNull:    false,
            defaultValue: DataTypes.NOW,
        },

        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
    },
    {
        sequelize,
        modelName:   'BonusAward',
        tableName:   'bonus_awards',
        underscored: false,
        timestamps:  true,
        indexes: [
            // ⚠️  This UNIQUE constraint is the double-award kill switch
            {
                unique: true,
                fields: ['driverId', 'programId', 'periodKey'],
                name:   'bonus_awards_unique_driver_program_period',
            },
            { fields: ['driverId'],   name: 'bonus_awards_driver'   },
            { fields: ['programId'],  name: 'bonus_awards_program'  },
            { fields: ['awardedAt'],  name: 'bonus_awards_awarded'  },
        ],
    }
);

// ── Internal association (within this file) ───────────────────────────
BonusProgram.hasMany(BonusAward, { foreignKey: 'programId', as: 'awards', onDelete: 'RESTRICT' });
BonusAward.belongsTo(BonusProgram, { foreignKey: 'programId', as: 'program' });

module.exports = { BonusProgram, BonusAward };