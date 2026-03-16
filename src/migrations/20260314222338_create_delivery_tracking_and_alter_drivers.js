'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {

        // ═══════════════════════════════════════════════════════════════════════════
        // PART 1 — delivery_tracking table
        // Stores real-time location snapshots during active deliveries
        // Same pattern as trip tracking — used for live map + playback
        // ═══════════════════════════════════════════════════════════════════════════

        await queryInterface.createTable('delivery_tracking', {
            id: {
                type: Sequelize.BIGINT,
                autoIncrement: true,
                primaryKey: true,
                allowNull: false,
                comment: 'BIGINT because this table grows very fast',
            },

            delivery_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: {
                    model: 'deliveries',
                    key: 'id',
                },
                onUpdate: 'CASCADE',
                onDelete: 'CASCADE',
                comment: 'Cascade delete — when delivery deleted, tracking deleted too',
            },

            driver_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: {
                    model: 'drivers',
                    key: 'id',
                },
                onUpdate: 'CASCADE',
                onDelete: 'CASCADE',
            },

            // ─── LOCATION ─────────────────────────────────────────────────────────────
            latitude: {
                type: Sequelize.DECIMAL(10, 8),
                allowNull: false,
            },

            longitude: {
                type: Sequelize.DECIMAL(11, 8),
                allowNull: false,
            },

            // Driver heading in degrees (0–360)
            // Used to rotate the vehicle marker on the map
            bearing: {
                type: Sequelize.DECIMAL(6, 3),
                allowNull: true,
                comment: 'Heading in degrees 0-360 for map marker rotation',
            },

            // Speed in km/h — useful for detecting if driver is stuck
            speed_kmh: {
                type: Sequelize.DECIMAL(6, 2),
                allowNull: true,
            },

            // GPS accuracy in meters — filter out bad readings
            accuracy_meters: {
                type: Sequelize.DECIMAL(8, 2),
                allowNull: true,
            },

            // ─── DELIVERY PHASE ───────────────────────────────────────────────────────
            // Which leg of the delivery this snapshot belongs to
            // Allows us to replay just the pickup leg or just the dropoff leg
            phase: {
                type: Sequelize.ENUM(
                    'en_route_pickup',   // Driver heading to sender
                    'en_route_dropoff'   // Driver heading to recipient
                ),
                allowNull: false,
            },

            // ─── TIMESTAMP ────────────────────────────────────────────────────────────
            // We use recorded_at instead of created_at
            // because we want the exact device timestamp, not server receipt time
            recorded_at: {
                type: Sequelize.DATE,
                allowNull: false,
                defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
            },
        });

        // ─── INDEXES FOR delivery_tracking ────────────────────────────────────────

        // Primary query: get all tracking points for a delivery
        await queryInterface.addIndex('delivery_tracking', ['delivery_id'], {
            name: 'idx_delivery_tracking_delivery',
        });

        // Live map query: get latest position of a driver
        await queryInterface.addIndex('delivery_tracking', ['driver_id', 'recorded_at'], {
            name: 'idx_delivery_tracking_driver_time',
        });

        // Phase-filtered replay
        await queryInterface.addIndex('delivery_tracking', ['delivery_id', 'phase'], {
            name: 'idx_delivery_tracking_delivery_phase',
        });

        console.log('✅ delivery_tracking table created');

        // ═══════════════════════════════════════════════════════════════════════════
        // PART 2 — Alter drivers table
        // Add current_mode column for ride/delivery mode toggle
        // ═══════════════════════════════════════════════════════════════════════════

        // Check if column already exists to make migration safe to re-run
        const tableDescription = await queryInterface.describeTable('drivers');

        if (!tableDescription.current_mode) {
            await queryInterface.addColumn('drivers', 'current_mode', {
                type: Sequelize.ENUM('ride', 'delivery', 'offline'),
                allowNull: false,
                defaultValue: 'ride',
                comment: 'Current operating mode — cannot accept both ride and delivery simultaneously',
                after: 'is_online', // Place it right after the is_online column
            });

            console.log('✅ current_mode column added to drivers table');
        } else {
            console.log('⚠️  current_mode column already exists on drivers — skipping');
        }

        // ─── Index for delivery driver matching ───────────────────────────────────
        // When searching for available delivery drivers we filter by
        // is_online=true AND current_mode='delivery'
        // This composite index makes that query very fast
        await queryInterface.addIndex('drivers', ['is_online', 'current_mode'], {
            name: 'idx_drivers_online_mode',
        }).catch(() => {
            // Index may already exist — ignore error
            console.log('⚠️  idx_drivers_online_mode index already exists — skipping');
        });

        // ═══════════════════════════════════════════════════════════════════════════
        // PART 3 — Alter driver_earnings table
        // Add type column to distinguish ride vs delivery earnings
        // ═══════════════════════════════════════════════════════════════════════════

        const earningsDescription = await queryInterface.describeTable('driver_earnings');

        if (!earningsDescription.type) {
            await queryInterface.addColumn('driver_earnings', 'type', {
                type: Sequelize.ENUM('ride', 'delivery'),
                allowNull: false,
                defaultValue: 'ride',
                comment: 'Earnings source type — used for filterable earnings dashboard',
                after: 'driver_id',
            });

            console.log('✅ type column added to driver_earnings table');
        } else {
            console.log('⚠️  type column already exists on driver_earnings — skipping');
        }

        // ─── Index for filtered earnings queries ──────────────────────────────────
        await queryInterface.addIndex('driver_earnings', ['driver_id', 'type'], {
            name: 'idx_driver_earnings_driver_type',
        }).catch(() => {
            console.log('⚠️  idx_driver_earnings_driver_type index already exists — skipping');
        });

        await queryInterface.addIndex('driver_earnings', ['type'], {
            name: 'idx_driver_earnings_type',
        }).catch(() => {
            console.log('⚠️  idx_driver_earnings_type index already exists — skipping');
        });

        console.log('✅ driver_earnings table updated with type column');
        console.log('✅ Migration 4 complete');
    },

    async down(queryInterface, Sequelize) {

        // Drop delivery_tracking first (has FK to deliveries)
        await queryInterface.dropTable('delivery_tracking');
        console.log('🗑️ delivery_tracking table dropped');

        // Remove current_mode from drivers
        const tableDescription = await queryInterface.describeTable('drivers');
        if (tableDescription.current_mode) {
            await queryInterface.removeColumn('drivers', 'current_mode');
            console.log('🗑️ current_mode column removed from drivers');
        }

        // Remove type from driver_earnings
        const earningsDescription = await queryInterface.describeTable('driver_earnings');
        if (earningsDescription.type) {
            await queryInterface.removeColumn('driver_earnings', 'type');
            console.log('🗑️ type column removed from driver_earnings');
        }

        // Remove indexes
        await queryInterface.removeIndex('drivers', 'idx_drivers_online_mode').catch(() => {});
        await queryInterface.removeIndex('driver_earnings', 'idx_driver_earnings_driver_type').catch(() => {});
        await queryInterface.removeIndex('driver_earnings', 'idx_driver_earnings_type').catch(() => {});

        console.log('🗑️ Migration 4 rolled back');
    },
};