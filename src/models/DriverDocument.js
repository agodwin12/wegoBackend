const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const DriverDocument = sequelize.define(
    'DriverDocument',
    {
        id: {
            type: DataTypes.BIGINT.UNSIGNED,
            autoIncrement: true,
            primaryKey: true,
        },

        account_id: {
            type: DataTypes.CHAR(36), // ✅ matches Account.uuid
            allowNull: false,
            references: {
                model: 'accounts',
                key: 'uuid',
            },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
        },

        doc_type: {
            type: DataTypes.ENUM('DRIVER_LICENSE', 'INSURANCE', 'CNI', 'OTHER'),
            allowNull: false,
        },

        file_url: {
            type: DataTypes.STRING(255),
            allowNull: false,
        },

        number: {
            type: DataTypes.STRING(128),
            allowNull: true,
        },

        issued_at: {
            type: DataTypes.DATEONLY,
            allowNull: true,
        },

        expires_at: {
            type: DataTypes.DATEONLY,
            allowNull: true,
        },

        status: {
            type: DataTypes.ENUM('PENDING', 'APPROVED', 'REJECTED'),
            allowNull: false,
            defaultValue: 'PENDING',
        },
    },
    {
        tableName: 'driver_documents',
        timestamps: true,
        indexes: [{ fields: ['account_id', 'doc_type', 'status'] }],
    }
);

module.exports = DriverDocument;
