'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        // Remove old ENUM
        await queryInterface.changeColumn('vehicle_rentals', 'rentalType', {
            type: Sequelize.ENUM('HOUR', 'DAY', 'WEEK', 'MONTH'),
            allowNull: false
        });
    },

    async down(queryInterface, Sequelize) {
        // Revert to only HOUR, DAY
        await queryInterface.changeColumn('vehicle_rentals', 'rentalType', {
            type: Sequelize.ENUM('HOUR', 'DAY'),
            allowNull: false
        });
    }
};
