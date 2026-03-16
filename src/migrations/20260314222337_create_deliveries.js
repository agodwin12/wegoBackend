'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('deliveries', {
            id: {
                type: Sequelize.INTEGER,
                autoIncrement: true,
                primaryKey: true,
                allowNull: false,
            },

            // ─── REFERENCE NUMBER ────────────────────────────────────────────────────
            // Human-readable delivery code shown in app and SMS
            // e.g. "DLV-20260314-00123"
            delivery_code: {
                type: Sequelize.STRING(30),
                allowNull: false,
                unique: true,
            },

            // ─── PARTIES ─────────────────────────────────────────────────────────────
            sender_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: {
                    model: 'users',
                    key: 'id',
                },
                onUpdate: 'CASCADE',
                onDelete: 'RESTRICT',
                comment: 'The passenger who booked the delivery',
            },

            driver_id: {
                type: Sequelize.INTEGER,
                allowNull: true, // NULL until a driver accepts
                references: {
                    model: 'drivers',
                    key: 'id',
                },
                onUpdate: 'CASCADE',
                onDelete: 'RESTRICT',
                comment: 'The driver who accepted the delivery',
            },

            // ─── RECIPIENT INFO ───────────────────────────────────────────────────────
            // The person RECEIVING the package — may differ from sender
            recipient_name: {
                type: Sequelize.STRING(100),
                allowNull: false,
            },

            recipient_phone: {
                type: Sequelize.STRING(20),
                allowNull: false,
                comment: 'PIN code sent to this number via Twilio SMS',
            },

            recipient_note: {
                type: Sequelize.STRING(500),
                allowNull: true,
                comment: 'e.g. "Call before arriving", "Leave at gate"',
            },

            // ─── PICKUP LOCATION ──────────────────────────────────────────────────────
            pickup_address: {
                type: Sequelize.STRING(500),
                allowNull: false,
            },

            pickup_latitude: {
                type: Sequelize.DECIMAL(10, 8),
                allowNull: false,
            },

            pickup_longitude: {
                type: Sequelize.DECIMAL(11, 8),
                allowNull: false,
            },

            pickup_landmark: {
                type: Sequelize.STRING(255),
                allowNull: true,
                comment: 'Optional landmark hint e.g. "Near Total petrol station"',
            },

            // ─── DROPOFF LOCATION ─────────────────────────────────────────────────────
            dropoff_address: {
                type: Sequelize.STRING(500),
                allowNull: false,
            },

            dropoff_latitude: {
                type: Sequelize.DECIMAL(10, 8),
                allowNull: false,
            },

            dropoff_longitude: {
                type: Sequelize.DECIMAL(11, 8),
                allowNull: false,
            },

            dropoff_landmark: {
                type: Sequelize.STRING(255),
                allowNull: true,
            },

            // ─── PACKAGE DETAILS ──────────────────────────────────────────────────────
            package_size: {
                type: Sequelize.ENUM('small', 'medium', 'large'),
                allowNull: false,
                comment: 'small=documents/envelopes, medium=parcels, large=bulky items',
            },

            package_description: {
                type: Sequelize.STRING(500),
                allowNull: true,
                comment: 'What is being sent — for driver awareness',
            },

            package_photo_url: {
                type: Sequelize.STRING(1000),
                allowNull: true,
                comment: 'Photo of package before pickup — stored in Cloudflare R2',
            },

            // Photo taken BY DRIVER at pickup — protects driver if item already damaged
            pickup_photo_url: {
                type: Sequelize.STRING(1000),
                allowNull: true,
                comment: 'Driver photo of package at pickup — proof of condition',
            },

            is_fragile: {
                type: Sequelize.BOOLEAN,
                allowNull: false,
                defaultValue: false,
            },

            // ─── PRICING SNAPSHOT ─────────────────────────────────────────────────────
            // We snapshot all pricing values at booking time
            // so historical records are accurate even if admin changes rates later

            pricing_zone_id: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: {
                    model: 'delivery_pricing',
                    key: 'id',
                },
                onUpdate: 'CASCADE',
                onDelete: 'SET NULL',
            },

            distance_km: {
                type: Sequelize.DECIMAL(8, 3),
                allowNull: false,
                comment: 'Actual distance from Google Maps Directions API',
            },

            base_fee_applied: {
                type: Sequelize.DECIMAL(10, 2),
                allowNull: false,
                comment: 'Snapshot of base fee at time of booking',
            },

            per_km_rate_applied: {
                type: Sequelize.DECIMAL(10, 2),
                allowNull: false,
                comment: 'Snapshot of per km rate at time of booking',
            },

            size_multiplier_applied: {
                type: Sequelize.DECIMAL(4, 2),
                allowNull: false,
                defaultValue: 1.00,
                comment: 'Snapshot of size multiplier at time of booking',
            },

            surge_multiplier_applied: {
                type: Sequelize.DECIMAL(4, 2),
                allowNull: false,
                defaultValue: 1.00,
                comment: '1.00 = no surge. e.g. 1.30 = 30% surge',
            },

            surge_rule_id: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: {
                    model: 'delivery_surge_rules',
                    key: 'id',
                },
                onUpdate: 'CASCADE',
                onDelete: 'SET NULL',
                comment: 'Which surge rule triggered — NULL if no surge',
            },

            // ─── FINAL AMOUNTS ────────────────────────────────────────────────────────
            subtotal: {
                type: Sequelize.DECIMAL(10, 2),
                allowNull: false,
                comment: 'base_fee + (distance_km * per_km_rate) before multipliers',
            },

            total_price: {
                type: Sequelize.DECIMAL(10, 2),
                allowNull: false,
                comment: 'Final amount charged to sender after all multipliers',
            },

            commission_percentage_applied: {
                type: Sequelize.DECIMAL(5, 2),
                allowNull: false,
                comment: 'Snapshot of commission % at time of booking',
            },

            commission_amount: {
                type: Sequelize.DECIMAL(10, 2),
                allowNull: false,
                comment: 'WEGO earnings = total_price * commission_percentage_applied / 100',
            },

            driver_payout: {
                type: Sequelize.DECIMAL(10, 2),
                allowNull: false,
                comment: 'total_price - commission_amount',
            },

            // ─── PAYMENT ──────────────────────────────────────────────────────────────
            payment_method: {
                type: Sequelize.ENUM('mtn_mobile_money', 'orange_money', 'cash'),
                allowNull: false,
            },

            payment_status: {
                type: Sequelize.ENUM(
                    'pending',       // Not yet paid
                    'paid',          // Mobile money confirmed
                    'cash_pending',  // Cash — driver hasn't confirmed receipt yet
                    'cash_confirmed',// Driver confirmed cash received
                    'refunded',      // Cancelled after payment
                    'failed'         // Payment attempt failed
                ),
                allowNull: false,
                defaultValue: 'pending',
            },

            payment_reference: {
                type: Sequelize.STRING(100),
                allowNull: true,
                comment: 'Mobile money transaction ID',
            },

            paid_at: {
                type: Sequelize.DATE,
                allowNull: true,
            },

            // ─── PIN CONFIRMATION ─────────────────────────────────────────────────────
            delivery_pin: {
                type: Sequelize.STRING(6),
                allowNull: true,
                comment: 'Hashed 4-digit PIN sent to recipient via SMS',
            },

            pin_verified_at: {
                type: Sequelize.DATE,
                allowNull: true,
                comment: 'Timestamp when driver entered correct PIN',
            },

            pin_attempts: {
                type: Sequelize.INTEGER,
                allowNull: false,
                defaultValue: 0,
                comment: 'Track failed PIN attempts — lock after 5',
            },

            // ─── STATUS FLOW ──────────────────────────────────────────────────────────
            // SEARCHING → ACCEPTED → EN_ROUTE_PICKUP → ARRIVED_PICKUP →
            // PICKED_UP → EN_ROUTE_DROPOFF → ARRIVED_DROPOFF → DELIVERED
            // Any state → CANCELLED or DISPUTED
            status: {
                type: Sequelize.ENUM(
                    'searching',        // Looking for available driver
                    'accepted',         // Driver accepted request
                    'en_route_pickup',  // Driver heading to sender
                    'arrived_pickup',   // Driver at pickup location
                    'picked_up',        // Driver has the package
                    'en_route_dropoff', // Driver heading to recipient
                    'arrived_dropoff',  // Driver at dropoff location
                    'delivered',        // PIN verified, delivery complete
                    'cancelled',        // Cancelled by sender or driver
                    'disputed',         // Under dispute investigation
                    'expired'           // No driver found within timeout
                ),
                allowNull: false,
                defaultValue: 'searching',
            },

            // ─── CANCELLATION ─────────────────────────────────────────────────────────
            cancelled_by: {
                type: Sequelize.ENUM('sender', 'driver', 'admin'),
                allowNull: true,
            },

            cancellation_reason: {
                type: Sequelize.STRING(500),
                allowNull: true,
            },

            cancelled_at: {
                type: Sequelize.DATE,
                allowNull: true,
            },

            // ─── MATCHING ─────────────────────────────────────────────────────────────
            // How many drivers declined before one accepted
            search_attempts: {
                type: Sequelize.INTEGER,
                allowNull: false,
                defaultValue: 0,
                comment: 'Number of drivers who declined before acceptance',
            },

            search_radius_km: {
                type: Sequelize.DECIMAL(5, 2),
                allowNull: true,
                comment: 'Radius used when driver was found',
            },

            // ─── TIMESTAMPS FOR EACH STATUS ───────────────────────────────────────────
            accepted_at: {
                type: Sequelize.DATE,
                allowNull: true,
            },

            arrived_pickup_at: {
                type: Sequelize.DATE,
                allowNull: true,
            },

            picked_up_at: {
                type: Sequelize.DATE,
                allowNull: true,
            },

            arrived_dropoff_at: {
                type: Sequelize.DATE,
                allowNull: true,
            },

            delivered_at: {
                type: Sequelize.DATE,
                allowNull: true,
            },

            // ─── DRIVER EARNINGS LINK ─────────────────────────────────────────────────
            // Points to the driver_earnings record created on completion
            earnings_record_id: {
                type: Sequelize.INTEGER,
                allowNull: true,
                comment: 'FK to driver_earnings table — set on delivery completion',
            },

            // ─── RATING ───────────────────────────────────────────────────────────────
            rating: {
                type: Sequelize.DECIMAL(3, 2),
                allowNull: true,
                comment: 'Sender rating of driver (1.00–5.00)',
            },

            rating_comment: {
                type: Sequelize.STRING(500),
                allowNull: true,
            },

            rated_at: {
                type: Sequelize.DATE,
                allowNull: true,
            },

            created_at: {
                type: Sequelize.DATE,
                allowNull: false,
                defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
            },

            updated_at: {
                type: Sequelize.DATE,
                allowNull: false,
                defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'),
            },
        });

        // ─── INDEXES ──────────────────────────────────────────────────────────────

        await queryInterface.addIndex('deliveries', ['delivery_code'], {
            name: 'idx_deliveries_code',
            unique: true,
        });

        await queryInterface.addIndex('deliveries', ['sender_id'], {
            name: 'idx_deliveries_sender',
        });

        await queryInterface.addIndex('deliveries', ['driver_id'], {
            name: 'idx_deliveries_driver',
        });

        await queryInterface.addIndex('deliveries', ['status'], {
            name: 'idx_deliveries_status',
        });

        await queryInterface.addIndex('deliveries', ['payment_status'], {
            name: 'idx_deliveries_payment_status',
        });

        await queryInterface.addIndex('deliveries', ['created_at'], {
            name: 'idx_deliveries_created_at',
        });

        // Composite index for driver dashboard queries
        await queryInterface.addIndex('deliveries', ['driver_id', 'status'], {
            name: 'idx_deliveries_driver_status',
        });

        // Composite index for admin reporting
        await queryInterface.addIndex('deliveries', ['status', 'created_at'], {
            name: 'idx_deliveries_status_date',
        });

        console.log('✅ deliveries table created');
    },

    async down(queryInterface, Sequelize) {
        await queryInterface.dropTable('deliveries');
        console.log('🗑️ deliveries table dropped');
    },
};