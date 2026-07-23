'use strict';

/**
 * Accounts created by the backoffice on behalf of a user (rental partners)
 * receive a generated temporary password delivered by SMS/email. Such
 * accounts must replace it on first login: this flag stays true until
 * PUT /users/change-password succeeds.
 */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.addColumn('accounts', 'must_change_password', {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: false,
            after: 'password_hash',
        });
    },

    async down(queryInterface) {
        await queryInterface.removeColumn('accounts', 'must_change_password');
    },
};
