'use strict';

// One review per (listing_id, customer_id). The rating controller already
// pre-checks for an existing review and catches SequelizeUniqueConstraintError,
// but no constraint existed — so a concurrent double-submit could create
// duplicates that skew average_rating/total_reviews. This adds the constraint
// (after removing any pre-existing duplicates, keeping the earliest row).

module.exports = {
    async up(queryInterface) {
        await queryInterface.sequelize.query(`
            DELETE r1 FROM service_ratings r1
            INNER JOIN service_ratings r2
                ON  r1.listing_id  = r2.listing_id
                AND r1.customer_id = r2.customer_id
                AND r1.id > r2.id;
        `);

        await queryInterface.addIndex('service_ratings', ['listing_id', 'customer_id'], {
            name:   'uq_service_rating_listing_customer',
            unique: true,
        });
    },

    async down(queryInterface) {
        await queryInterface.removeIndex('service_ratings', 'uq_service_rating_listing_customer');
    },
};
