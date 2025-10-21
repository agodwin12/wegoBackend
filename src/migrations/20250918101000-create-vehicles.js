'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('vehicles', {
            id: {
                type: Sequelize.STRING(36),
                primaryKey: true
            },
            plate: {
                type: Sequelize.STRING(24),
                allowNull: false,
                unique: true
            },
            makeModel: {
                type: Sequelize.STRING(64),
                allowNull: true
            },
            color: {
                type: Sequelize.STRING(32),
                allowNull: true
            },
            region: {
                type: Sequelize.STRING(64),
                allowNull: false,
                defaultValue: 'Littoral'
            },
            seats: {
                type: Sequelize.INTEGER,
                allowNull: false,
                defaultValue: 4
            },
            partnerId: {
                type: Sequelize.CHAR(36),
                allowNull: false,
                collate: 'utf8mb4_bin',
                references: { model: 'accounts', key: 'uuid' },
                onUpdate: 'CASCADE',
                onDelete: 'CASCADE'
            },
            postedByEmployeeId: {
                type: Sequelize.CHAR(36),
                allowNull: true,
                collate: 'utf8mb4_bin',
                references: { model: 'accounts', key: 'uuid' },
                onUpdate: 'CASCADE',
                onDelete: 'SET NULL'
            },
            categoryId: {
                type: Sequelize.STRING(36),
                allowNull: true,
                references: { model: 'vehicle_categories', key: 'id' },
                onUpdate: 'CASCADE',
                onDelete: 'SET NULL'
            },
            availableForRent: {
                type: Sequelize.BOOLEAN,
                allowNull: false,
                defaultValue: false
            },
            rentalPricePerHour: {
                type: Sequelize.DECIMAL(10, 2),
                allowNull: true
            },
            rentalPricePerDay: {
                type: Sequelize.DECIMAL(10, 2),
                allowNull: true
            },
            rentalPricePerWeek: {
                type: Sequelize.DECIMAL(10, 2),
                allowNull: true
            },
            rentalPricePerMonth: {
                type: Sequelize.DECIMAL(10, 2),
                allowNull: true
            },
            rentalCurrency: {
                type: Sequelize.STRING(10),
                allowNull: false,
                defaultValue: 'XAF'
            },
            images: {
                type: Sequelize.JSON,
                allowNull: true,
                defaultValue: null
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

        // Indexes to speed up queries
        await queryInterface.addIndex('vehicles', ['partnerId'], {
            name: 'idx_vehicles_partner_id'
        });
        await queryInterface.addIndex('vehicles', ['postedByEmployeeId'], {
            name: 'idx_vehicles_posted_by_employee_id'
        });
        await queryInterface.addIndex('vehicles', ['categoryId'], {
            name: 'idx_vehicles_category_id'
        });
        await queryInterface.addIndex('vehicles', ['availableForRent'], {
            name: 'idx_vehicles_available_for_rent'
        });
        await queryInterface.addIndex('vehicles', ['region'], {
            name: 'idx_vehicles_region'
        });
    },

    async down(queryInterface) {
        await queryInterface.dropTable('vehicles');
    }
};