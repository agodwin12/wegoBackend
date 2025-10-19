'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('vehicle_rentals', {
            id: { type: Sequelize.STRING(36), primaryKey: true },
            userId: {
                type: Sequelize.CHAR(36), allowNull: false,
                references: { model: 'accounts', key: 'uuid' },
                onUpdate: 'CASCADE', onDelete: 'CASCADE'
            },
            vehicleId: {
                type: Sequelize.STRING(36), allowNull: false,
                references: { model: 'vehicles', key: 'id' },
                onUpdate: 'CASCADE', onDelete: 'CASCADE'
            },
            rentalType: { type: Sequelize.ENUM('HOUR','DAY'), allowNull: false },
            startDate: Sequelize.DATE,
            endDate: Sequelize.DATE,
            status: { type: Sequelize.ENUM('PENDING','CONFIRMED','CANCELLED','COMPLETED'), defaultValue: 'PENDING' },
            totalPrice: { type: Sequelize.DECIMAL(10,2), defaultValue: 0.00 },
            paymentStatus: { type: Sequelize.ENUM('unpaid','paid','refunded'), defaultValue: 'unpaid' },
            approvedByAdminId: {
                type: Sequelize.CHAR(36),
                references: { model: 'accounts', key: 'uuid' },
                onUpdate: 'CASCADE', onDelete: 'SET NULL'
            },
            createdAt: { type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
            updatedAt: { type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
        });
    },
    async down(queryInterface) {
        await queryInterface.dropTable('vehicle_rentals');
    }
};
