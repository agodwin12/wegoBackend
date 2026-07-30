'use strict';

// Widen notifications.type ENUM to include the new delivery stage notifications
// (DELIVERY_ARRIVED_PICKUP, DELIVERY_ARRIVED_DROPOFF, DELIVERY_DELIVERED). The
// full set is taken from the model so DB + code stay in sync.

const { NOTIFICATION_TYPES } = require('../models/Notification');

module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.changeColumn('notifications', 'type', {
            type:      Sequelize.ENUM(...NOTIFICATION_TYPES),
            allowNull: false,
        });
    },

    // Widening an ENUM is not safely reversible (rows may use the new values),
    // so down is a no-op.
    async down() {},
};
