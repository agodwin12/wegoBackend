// src/models/DeliveryWallet.js

const { DataTypes, Model } = require('sequelize');

module.exports = (sequelize) => {

    class DeliveryWallet extends Model {

        // Available balance excludes pending withdrawals
        get availableBalance() {
            return parseFloat(this.balance) - parseFloat(this.pending_withdrawal);
        }

        // Outstanding cash commission debt
        get outstandingCashCommission() {
            return parseFloat(this.total_commission_owed) - parseFloat(this.total_commission_paid);
        }

        static associate(models) {
            DeliveryWallet.belongsTo(models.Driver, {
                foreignKey: 'driver_id',
                targetKey:  'id',
                as:         'driver',
            });

            DeliveryWallet.hasMany(models.DeliveryWalletTransaction, {
                foreignKey: 'wallet_id',
                as:         'transactions',
            });

            DeliveryWallet.hasMany(models.DeliveryPayoutRequest, {
                foreignKey: 'wallet_id',
                as:         'payoutRequests',
            });

            if (models.Employee) {
                DeliveryWallet.belongsTo(models.Employee, {
                    foreignKey: 'frozen_by',
                    as:         'frozenByEmployee',
                });
            }
        }
    }

    DeliveryWallet.init({
        id: {
            type:          DataTypes.INTEGER.UNSIGNED,
            autoIncrement: true,
            primaryKey:    true,
        },

        // VARCHAR(36) to match Driver.id — no references block
        driver_id: {
            type:      DataTypes.STRING(36),
            allowNull: false,
            unique:    true,
        },

        balance: {
            type:         DataTypes.DECIMAL(12, 2),
            allowNull:    false,
            defaultValue: 0.00,
            get() { return parseFloat(this.getDataValue('balance') || 0); },
        },

        total_earned: {
            type:         DataTypes.DECIMAL(12, 2),
            allowNull:    false,
            defaultValue: 0.00,
            get() { return parseFloat(this.getDataValue('total_earned') || 0); },
        },

        total_cash_collected: {
            type:         DataTypes.DECIMAL(12, 2),
            allowNull:    false,
            defaultValue: 0.00,
            get() { return parseFloat(this.getDataValue('total_cash_collected') || 0); },
        },

        total_commission_owed: {
            type:         DataTypes.DECIMAL(12, 2),
            allowNull:    false,
            defaultValue: 0.00,
            get() { return parseFloat(this.getDataValue('total_commission_owed') || 0); },
        },

        total_commission_paid: {
            type:         DataTypes.DECIMAL(12, 2),
            allowNull:    false,
            defaultValue: 0.00,
            get() { return parseFloat(this.getDataValue('total_commission_paid') || 0); },
        },

        total_withdrawn: {
            type:         DataTypes.DECIMAL(12, 2),
            allowNull:    false,
            defaultValue: 0.00,
            get() { return parseFloat(this.getDataValue('total_withdrawn') || 0); },
        },

        pending_withdrawal: {
            type:         DataTypes.DECIMAL(12, 2),
            allowNull:    false,
            defaultValue: 0.00,
            get() { return parseFloat(this.getDataValue('pending_withdrawal') || 0); },
        },

        status: {
            type:         DataTypes.ENUM('active', 'frozen', 'suspended'),
            allowNull:    false,
            defaultValue: 'active',
        },

        frozen_reason: {
            type:      DataTypes.STRING(255),
            allowNull: true,
        },

        // INT UNSIGNED — no references block, Sequelize associations handle the relationship
        frozen_by: {
            type:      DataTypes.INTEGER.UNSIGNED,
            allowNull: true,
        },

    }, {
        sequelize,
        modelName:   'DeliveryWallet',
        tableName:   'delivery_wallets',
        timestamps:  true,
        underscored: true,
    });

    return DeliveryWallet;
};