'use strict';

// Trust/safety: user reports of a live service listing (fraud/scam/spam/etc.).

module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('service_listing_reports', {
            id:              { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
            listing_id:      { type: Sequelize.INTEGER, allowNull: false },
            reporter_id:     { type: Sequelize.CHAR(36), allowNull: false },
            reason_category: { type: Sequelize.ENUM('scam', 'spam', 'inappropriate', 'wrong_info', 'impersonation', 'other'), allowNull: false },
            reason_text:     { type: Sequelize.STRING(500), allowNull: true },
            status:          { type: Sequelize.ENUM('open', 'reviewing', 'actioned', 'dismissed'), allowNull: false, defaultValue: 'open' },
            resolution_note: { type: Sequelize.STRING(500), allowNull: true },
            resolved_by:     { type: Sequelize.INTEGER, allowNull: true },
            resolved_at:     { type: Sequelize.DATE, allowNull: true },
            created_at:      { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
            updated_at:      { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        });

        await queryInterface.addIndex('service_listing_reports', ['status', 'created_at'], { name: 'idx_slr_status_created' });
        await queryInterface.addIndex('service_listing_reports', ['listing_id'], { name: 'idx_slr_listing' });
        await queryInterface.addIndex('service_listing_reports', ['listing_id', 'reporter_id'], { name: 'uq_slr_reporter_listing', unique: true });
    },

    async down(queryInterface) {
        await queryInterface.dropTable('service_listing_reports');
    },
};
