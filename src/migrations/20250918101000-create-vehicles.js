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
            makeModel: Sequelize.STRING(64),
            color: Sequelize.STRING(32),
            seats: {
                type: Sequelize.INTEGER,
                defaultValue: 4
            },
            partnerId: {
                type: Sequelize.CHAR(36),
                allowNull: false,
                collate: 'utf8mb4_bin',   // ✅ must match accounts.uuid
                references: { model: 'accounts', key: 'uuid' },
                onUpdate: 'CASCADE',
                onDelete: 'CASCADE'
            },
            availableForRent: {
                type: Sequelize.BOOLEAN,
                defaultValue: false
            },
            rentalPricePerHour: Sequelize.DECIMAL(10,2),
            rentalPricePerDay: Sequelize.DECIMAL(10,2),
            rentalCurrency: {
                type: Sequelize.STRING(10),
                defaultValue: 'XAF'
            },

            // 🔹 Array of image URLs stored as JSON
            images: {
                type: Sequelize.JSON,
                allowNull: true
            },

            createdAt: {
                type: Sequelize.DATE,
                defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
            },
            updatedAt: {
                type: Sequelize.DATE,
                defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
            }
        });

        // Indexes to speed up partner lookups
        await queryInterface.addIndex('vehicles', ['partnerId']);
        await queryInterface.addIndex('vehicles', ['availableForRent']);
    },

    async down(queryInterface) {
        await queryInterface.dropTable('vehicles');
    }
};
