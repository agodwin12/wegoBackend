'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('vehicle_categories', {
            id: {
                type: Sequelize.STRING(36),
                primaryKey: true
            },
            name: {
                type: Sequelize.STRING(64),
                allowNull: false
            },
            slug: {
                type: Sequelize.STRING(64),
                allowNull: false,
                unique: true
            },
            description: {
                type: Sequelize.STRING(255),
                allowNull: true
            },
            icon: {
                type: Sequelize.STRING(64),
                allowNull: true,
                comment: 'Icon identifier (e.g., car-sports, car-suv, etc.)'
            },
            isActive: {
                type: Sequelize.BOOLEAN,
                allowNull: false,
                defaultValue: true
            },
            sortOrder: {
                type: Sequelize.INTEGER,
                allowNull: false,
                defaultValue: 0,
                comment: 'Display order (lower numbers appear first)'
            },
            createdAt: {
                type: Sequelize.DATE,
                allowNull: false,
                defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
            },
            updatedAt: {
                type: Sequelize.DATE,
                allowNull: false,
                defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP')
            }
        });

        // Indexes
        await queryInterface.addIndex('vehicle_categories', ['slug'], {
            name: 'idx_vehicle_categories_slug',
            unique: true
        });
        await queryInterface.addIndex('vehicle_categories', ['isActive'], {
            name: 'idx_vehicle_categories_is_active'
        });
        await queryInterface.addIndex('vehicle_categories', ['sortOrder'], {
            name: 'idx_vehicle_categories_sort_order'
        });
    },

    async down(queryInterface) {
        await queryInterface.dropTable('vehicle_categories');
    }
};