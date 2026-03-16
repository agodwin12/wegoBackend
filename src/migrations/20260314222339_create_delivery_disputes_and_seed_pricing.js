'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {

        // ═══════════════════════════════════════════════════════════════════════════
        // PART 1 — delivery_disputes table
        // Formal dispute resolution for deliveries
        // Separate from the services marketplace disputes table
        // ═══════════════════════════════════════════════════════════════════════════

        await queryInterface.createTable('delivery_disputes', {
            id: {
                type: Sequelize.INTEGER,
                autoIncrement: true,
                primaryKey: true,
                allowNull: false,
            },

            // Human-readable dispute code e.g. "DDSP-20260314-00012"
            dispute_code: {
                type: Sequelize.STRING(30),
                allowNull: false,
                unique: true,
            },

            // ─── LINKED DELIVERY ──────────────────────────────────────────────────────
            delivery_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: {
                    model: 'deliveries',
                    key: 'id',
                },
                onUpdate: 'CASCADE',
                onDelete: 'RESTRICT',
            },

            // ─── PARTIES ──────────────────────────────────────────────────────────────
            filed_by_user_id: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: {
                    model: 'users',
                    key: 'id',
                },
                onUpdate: 'CASCADE',
                onDelete: 'SET NULL',
                comment: 'Sender who filed the dispute — NULL if filed by admin',
            },

            filed_by_driver_id: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: {
                    model: 'drivers',
                    key: 'id',
                },
                onUpdate: 'CASCADE',
                onDelete: 'SET NULL',
                comment: 'Driver who filed the dispute — NULL if filed by sender/admin',
            },

            assigned_to_employee_id: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: {
                    model: 'employees',
                    key: 'id',
                },
                onUpdate: 'CASCADE',
                onDelete: 'SET NULL',
                comment: 'Admin employee handling this dispute',
            },

            // ─── DISPUTE DETAILS ──────────────────────────────────────────────────────
            dispute_type: {
                type: Sequelize.ENUM(
                    'package_not_delivered',   // Driver marked delivered but recipient never got it
                    'package_damaged',         // Package arrived damaged
                    'wrong_item_delivered',    // Driver delivered to wrong address/person
                    'payment_issue',           // Payment dispute
                    'driver_behaviour',        // Misconduct by driver
                    'sender_behaviour',        // Misconduct by sender
                    'pin_issue',               // Recipient claims they never got PIN
                    'overcharge',              // Sender disputes the final price
                    'other'
                ),
                allowNull: false,
            },

            description: {
                type: Sequelize.TEXT,
                allowNull: false,
                comment: 'Detailed description of the problem — min 50 chars enforced in app',
            },

            // Evidence uploaded by the filing party
            evidence_urls: {
                type: Sequelize.JSON,
                allowNull: true,
                comment: 'Array of Cloudflare R2 URLs — photos/screenshots as evidence',
            },

            // ─── RESPONSE ─────────────────────────────────────────────────────────────
            // The other party's response
            response_description: {
                type: Sequelize.TEXT,
                allowNull: true,
            },

            response_evidence_urls: {
                type: Sequelize.JSON,
                allowNull: true,
                comment: 'Counter-evidence from responding party',
            },

            responded_at: {
                type: Sequelize.DATE,
                allowNull: true,
            },

            // ─── ADMIN INVESTIGATION ──────────────────────────────────────────────────
            admin_notes: {
                type: Sequelize.TEXT,
                allowNull: true,
                comment: 'Internal notes — not visible to sender or driver',
            },

            // ─── RESOLUTION ───────────────────────────────────────────────────────────
            resolution_type: {
                type: Sequelize.ENUM(
                    'full_refund',        // Sender gets full refund
                    'partial_refund',     // Partial refund agreed
                    'no_refund',          // In favour of driver
                    'redelivery',         // Driver must redeliver at no cost
                    'mutual_agreement',   // Custom resolution
                    'driver_warning',     // Driver gets a formal warning
                    'driver_suspended',   // Driver suspended from platform
                    'sender_warned',      // Sender warned for false claims
                    'dismissed'           // Dispute found to be invalid
                ),
                allowNull: true,
                comment: 'Set when dispute is resolved',
            },

            resolution_notes: {
                type: Sequelize.TEXT,
                allowNull: true,
                comment: 'Explanation of the resolution — visible to both parties',
            },

            // Financial outcome
            refund_amount: {
                type: Sequelize.DECIMAL(10, 2),
                allowNull: true,
                defaultValue: 0.00,
                comment: 'Amount refunded to sender — 0 if no refund',
            },

            // ─── STATUS ───────────────────────────────────────────────────────────────
            status: {
                type: Sequelize.ENUM(
                    'open',           // Just filed — awaiting assignment
                    'investigating',  // Admin assigned and reviewing
                    'awaiting_response', // Waiting for other party to respond
                    'resolved',       // Admin made final decision
                    'closed'          // Fully closed — all actions taken
                ),
                allowNull: false,
                defaultValue: 'open',
            },

            priority: {
                type: Sequelize.ENUM('low', 'medium', 'high', 'urgent'),
                allowNull: false,
                defaultValue: 'medium',
            },

            // ─── TIMESTAMPS ───────────────────────────────────────────────────────────
            resolved_at: {
                type: Sequelize.DATE,
                allowNull: true,
            },

            closed_at: {
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

        // ─── INDEXES FOR delivery_disputes ────────────────────────────────────────

        await queryInterface.addIndex('delivery_disputes', ['dispute_code'], {
            name: 'idx_delivery_disputes_code',
            unique: true,
        });

        await queryInterface.addIndex('delivery_disputes', ['delivery_id'], {
            name: 'idx_delivery_disputes_delivery',
        });

        await queryInterface.addIndex('delivery_disputes', ['status'], {
            name: 'idx_delivery_disputes_status',
        });

        await queryInterface.addIndex('delivery_disputes', ['assigned_to_employee_id'], {
            name: 'idx_delivery_disputes_employee',
        });

        await queryInterface.addIndex('delivery_disputes', ['priority', 'status'], {
            name: 'idx_delivery_disputes_priority_status',
        });

        console.log('✅ delivery_disputes table created');

        // ═══════════════════════════════════════════════════════════════════════════
        // PART 2 — Seed default pricing configs
        // Insert sensible defaults for Douala and Yaoundé
        // Admin can edit these from backoffice immediately
        // ═══════════════════════════════════════════════════════════════════════════

        await queryInterface.bulkInsert('delivery_pricing', [
            {
                // ── Douala — Standard config
                zone_name: 'Douala Standard',
                zone_description: 'Standard delivery pricing for Douala metropolitan area',
                base_fee: 500.00,
                per_km_rate: 150.00,
                size_multiplier_small: 1.00,   // Small: documents, envelopes = base price
                size_multiplier_medium: 1.30,  // Medium: +30%
                size_multiplier_large: 1.70,   // Large: +70%
                commission_percentage: 20.00,  // WEGO takes 20% in Douala
                minimum_price: 1000.00,        // Minimum 1,000 XAF per delivery
                max_distance_km: 50.00,
                is_active: true,
                created_by: null,
                created_at: new Date(),
                updated_at: new Date(),
            },
            {
                // ── Yaoundé — Standard config
                zone_name: 'Yaoundé Standard',
                zone_description: 'Standard delivery pricing for Yaoundé metropolitan area',
                base_fee: 500.00,
                per_km_rate: 160.00,           // Slightly higher per km than Douala
                size_multiplier_small: 1.00,
                size_multiplier_medium: 1.30,
                size_multiplier_large: 1.70,
                commission_percentage: 20.00,
                minimum_price: 1000.00,
                max_distance_km: 40.00,
                is_active: true,
                created_by: null,
                created_at: new Date(),
                updated_at: new Date(),
            },
            {
                // ── Douala Express — Premium fast delivery tier
                // Admin can assign specific drivers to this tier later
                zone_name: 'Douala Express',
                zone_description: 'Premium express delivery — faster matching, higher rate',
                base_fee: 1000.00,
                per_km_rate: 200.00,
                size_multiplier_small: 1.00,
                size_multiplier_medium: 1.20,
                size_multiplier_large: 1.50,
                commission_percentage: 15.00,  // Lower commission — incentivize express drivers
                minimum_price: 2000.00,
                max_distance_km: 30.00,        // Express capped at 30km
                is_active: false,              // Disabled by default — admin activates when ready
                created_by: null,
                created_at: new Date(),
                updated_at: new Date(),
            },
        ]);

        console.log('✅ Default delivery pricing configs seeded (Douala Standard, Yaoundé Standard, Douala Express)');
        console.log('✅ Migration 5 complete — All delivery tables ready');
        console.log('');
        console.log('📋 SUMMARY OF ALL DELIVERY TABLES CREATED:');
        console.log('   1. delivery_pricing       — Zone pricing configs');
        console.log('   2. delivery_surge_rules   — Auto surge time rules');
        console.log('   3. deliveries             — Core delivery records');
        console.log('   4. delivery_tracking      — Real-time location snapshots');
        console.log('   5. delivery_disputes      — Dispute resolution');
        console.log('');
        console.log('📋 ALTERED TABLES:');
        console.log('   - drivers.current_mode    — ride/delivery/offline toggle');
        console.log('   - driver_earnings.type    — ride/delivery earnings filter');
    },

    async down(queryInterface, Sequelize) {
        await queryInterface.dropTable('delivery_disputes');
        console.log('🗑️ delivery_disputes table dropped');

        // Remove seeded pricing data
        await queryInterface.bulkDelete('delivery_pricing', {
            zone_name: ['Douala Standard', 'Yaoundé Standard', 'Douala Express'],
        });
        console.log('🗑️ Default pricing seeds removed');

        console.log('🗑️ Migration 5 rolled back');
    },
};