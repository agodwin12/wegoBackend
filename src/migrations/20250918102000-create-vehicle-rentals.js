'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('vehicle_rentals', {
            id: {
                type: Sequelize.STRING(36),
                primaryKey: true
            },
            userId: {
                type: Sequelize.CHAR(36),
                allowNull: false,
                collate: 'utf8mb4_bin',
                references: { model: 'accounts', key: 'uuid' },
                onUpdate: 'CASCADE',
                onDelete: 'CASCADE'
            },
            vehicleId: {
                type: Sequelize.STRING(36),
                allowNull: false,
                references: { model: 'vehicles', key: 'id' },
                onUpdate: 'CASCADE',
                onDelete: 'CASCADE'
            },
            rentalRegion: {
                type: Sequelize.STRING(64),
                allowNull: false
            },
            rentalType: {
                type: Sequelize.ENUM('HOUR', 'DAY', 'WEEK', 'MONTH'),
                allowNull: false
            },
            startDate: {
                type: Sequelize.DATE,
                allowNull: false
            },
            endDate: {
                type: Sequelize.DATE,
                allowNull: false
            },
            status: {
                type: Sequelize.ENUM('PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED'),
                allowNull: false,
                defaultValue: 'PENDING'
            },
            contactStatus: {
                type: Sequelize.ENUM('PENDING', 'CONTACTED', 'NEGOTIATING', 'APPROVED', 'REJECTED'),
                allowNull: false,
                defaultValue: 'PENDING'
            },
            userNotes: {
                type: Sequelize.TEXT,
                allowNull: true
            },
            totalPrice: {
                type: Sequelize.DECIMAL(10, 2),
                allowNull: false,
                defaultValue: 0.00
            },
            paymentStatus: {
                type: Sequelize.ENUM('unpaid', 'paid', 'refunded'),
                allowNull: false,
                defaultValue: 'unpaid'
            },
            approvedByAdminId: {
                type: Sequelize.CHAR(36),
                allowNull: true,
                collate: 'utf8mb4_bin',
                references: { model: 'accounts', key: 'uuid' },
                onUpdate: 'CASCADE',
                onDelete: 'SET NULL'
            },
            handledByEmployeeId: {
                type: Sequelize.CHAR(36),
                allowNull: true,
                collate: 'utf8mb4_bin',
                references: { model: 'accounts', key: 'uuid' },
                onUpdate: 'CASCADE',
                onDelete: 'SET NULL'
            },
            createdAt: {
                type: Sequelize.DATE,
                allowNull: false,
                defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
            },
            updatedAt: {
                type: Sequelize.DATE,
                allowNull: false,
                defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP')
            }
        });

        // Indexes for performance
        await queryInterface.addIndex('vehicle_rentals', ['userId'], {
            name: 'idx_vehicle_rentals_user_id'
        });
        await queryInterface.addIndex('vehicle_rentals', ['vehicleId'], {
            name: 'idx_vehicle_rentals_vehicle_id'
        });
        await queryInterface.addIndex('vehicle_rentals', ['rentalRegion'], {
            name: 'idx_vehicle_rentals_rental_region'
        });
        await queryInterface.addIndex('vehicle_rentals', ['status'], {
            name: 'idx_vehicle_rentals_status'
        });
        await queryInterface.addIndex('vehicle_rentals', ['contactStatus'], {
            name: 'idx_vehicle_rentals_contact_status'
        });
        await queryInterface.addIndex('vehicle_rentals', ['approvedByAdminId'], {
            name: 'idx_vehicle_rentals_approved_by_admin_id'
        });
        await queryInterface.addIndex('vehicle_rentals', ['handledByEmployeeId'], {
            name: 'idx_vehicle_rentals_handled_by_employee_id'
        });

        // Composite index for checking overlapping bookings
        await queryInterface.addIndex('vehicle_rentals', ['vehicleId', 'startDate', 'endDate'], {
            name: 'idx_vehicle_rentals_booking_overlap'
        });
    },

    async down(queryInterface) {
        await queryInterface.dropTable('vehicle_rentals');
    }
};