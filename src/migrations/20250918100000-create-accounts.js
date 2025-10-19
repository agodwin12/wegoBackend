'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('accounts', {
            uuid: {
                type: Sequelize.CHAR(36),
                allowNull: false,
                primaryKey: true,
                collate: 'utf8mb4_bin'   // ✅ ensure exact FK match
            },
            user_type: {
                type: Sequelize.ENUM('PASSENGER', 'DRIVER', 'PARTNER', 'ADMIN'),
                allowNull: false
            },
            email: { type: Sequelize.STRING(190), unique: true },
            phone_e164: { type: Sequelize.STRING(32), unique: true },
            phone_verified: { type: Sequelize.BOOLEAN, defaultValue: false },
            email_verified: { type: Sequelize.BOOLEAN, defaultValue: false },
            password_hash: { type: Sequelize.STRING(255), allowNull: false },
            password_algo: { type: Sequelize.STRING(32), defaultValue: 'bcrypt' },
            civility: { type: Sequelize.ENUM('M.', 'Mme', 'Mlle') },
            first_name: Sequelize.STRING(100),
            last_name: Sequelize.STRING(100),
            birth_date: Sequelize.DATEONLY,
            avatar_url: Sequelize.STRING(255),
            status: {
                type: Sequelize.ENUM('ACTIVE','PENDING','SUSPENDED','DELETED'),
                defaultValue: 'PENDING'
            },
            createdAt: { type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
            updatedAt: { type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
        });
    },

    async down(queryInterface) {
        await queryInterface.dropTable('accounts');
    }
};
