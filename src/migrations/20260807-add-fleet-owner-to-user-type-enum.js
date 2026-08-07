'use strict';

// Widen accounts.user_type ENUM to include FLEET_OWNER. The backoffice
// fleet-owner creation flow (fleetOwnerAdmin.controller.js), the /api/fleet/*
// routes, and the deployed wegoPartner frontend's FLEET_NAV all assume this
// value already exists, but it was never added to the schema — every fresh
// deployment from this codebase fails with "Data truncated for column
// 'user_type'" on the very first fleet-owner creation attempt. This brings
// the column in sync with src/models/Account.js.

module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.changeColumn('accounts', 'user_type', {
            type: Sequelize.ENUM(
                'PASSENGER',
                'DRIVER',
                'PARTNER',
                'ADMIN',
                'DELIVERY_AGENT',
                'FLEET_OWNER'
            ),
            allowNull: false,
        });
    },

    // Widening an ENUM is not safely reversible (rows may already use the
    // new value), so down is a no-op — matches the convention used by
    // 20260805-add-no-show-to-trip-status.js.
    async down() {},
};
