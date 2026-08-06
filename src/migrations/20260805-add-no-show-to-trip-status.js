'use strict';

// Widen trips.status ENUM to include NO_SHOW. The trip state machine
// (src/utils/tripStateMachine.js) already defines NO_SHOW as a valid
// terminal state reachable from DRIVER_ARRIVED, but the DB ENUM never
// included it, so any real applyTransition(trip, 'NO_SHOW', ...) call
// threw a Sequelize validation error. This brings the column in sync
// with src/models/Trip.js.

module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.changeColumn('trips', 'status', {
            type: Sequelize.ENUM(
                'DRAFT',
                'SEARCHING',
                'MATCHED',
                'DRIVER_ASSIGNED',
                'DRIVER_EN_ROUTE',
                'DRIVER_ARRIVED',
                'IN_PROGRESS',
                'COMPLETED',
                'CANCELED',
                'NO_DRIVERS',
                'NO_SHOW'
            ),
            allowNull: false,
            defaultValue: 'SEARCHING',
        });
    },

    // Widening an ENUM is not safely reversible (rows may already use the
    // new value), so down is a no-op — matches the convention used by
    // 20260730-add-delivery-stage-notification-types.js.
    async down() {},
};
