// src/models/DeliveryPayoutRequest.js

const { DataTypes, Model } = require('sequelize');

module.exports = (sequelize) => {

    class DeliveryPayoutRequest extends Model {

        static generatePayoutCode() {
            const now    = new Date();
            const date   = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
            const random = Math.floor(Math.random() * 99999).toString().padStart(5, '0');
            return `DPAY-${date}-${random}`;
        }

        isPending()     { return this.status === 'pending'; }
        isProcessing()  { return this.status === 'processing'; }
        isCompleted()   { return this.status === 'completed'; }
        isRejected()    { return this.status === 'rejected'; }
        isCancelled()   { return this.status === 'cancelled'; }
        canBeCancelled(){ return ['pending'].includes(this.status); }

        static associate(models) {
            DeliveryPayoutRequest.belongsTo(models.Driver, {
                foreignKey: 'driver_id',
                targetKey:  'id',
                as:         'driver',
            });

            DeliveryPayoutRequest.belongsTo(models.DeliveryWallet, {
                foreignKey: 'wallet_id',
                as:         'wallet',
            });

            DeliveryPayoutRequest.belongsTo(models.DeliveryWalletTransaction, {
                foreignKey: 'transaction_id',
                as:         'transaction',
            });

            if (models.Employee) {
                DeliveryPayoutRequest.belongsTo(models.Employee, {
                    foreignKey: 'processed_by',
                    as:         'processedByEmployee',
                });
                DeliveryPayoutRequest.belongsTo(models.Employee, {
                    foreignKey: 'rejected_by',
                    as:         'rejectedByEmployee',
                });
            }
        }
    }

    DeliveryPayoutRequest.init({
        id: {
            type:          DataTypes.INTEGER.UNSIGNED,
            autoIncrement: true,
            primaryKey:    true,
        },

        payout_code: {
            type:      DataTypes.STRING(30),
            allowNull: false,
            unique:    true,
        },

        // VARCHAR(36) to match Driver.id — no references block
        driver_id: {
            type:      DataTypes.STRING(36),
            allowNull: false,
        },

        wallet_id: {
            type:      DataTypes.INTEGER.UNSIGNED,
            allowNull: false,
        },

        amount: {
            type:      DataTypes.DECIMAL(12, 2),
            allowNull: false,
            get() { return parseFloat(this.getDataValue('amount') || 0); },
        },

        payment_method: {
            type:      DataTypes.ENUM('mtn_mobile_money', 'orange_money'),
            allowNull: false,
        },

        phone_number: {
            type:      DataTypes.STRING(20),
            allowNull: false,
        },

        status: {
            type:         DataTypes.ENUM('pending', 'processing', 'completed', 'rejected', 'cancelled'),
            allowNull:    false,
            defaultValue: 'pending',
        },

        processed_by: {
            type:      DataTypes.INTEGER.UNSIGNED,
            allowNull: true,
        },

        processed_at: {
            type:      DataTypes.DATE,
            allowNull: true,
        },

        completed_at: {
            type:      DataTypes.DATE,
            allowNull: true,
        },

        payment_reference: {
            type:      DataTypes.STRING(100),
            allowNull: true,
        },

        rejected_by: {
            type:      DataTypes.INTEGER.UNSIGNED,
            allowNull: true,
        },

        rejection_reason: {
            type:      DataTypes.STRING(500),
            allowNull: true,
        },

        agent_notes: {
            type:      DataTypes.STRING(500),
            allowNull: true,
        },

        admin_notes: {
            type:      DataTypes.STRING(500),
            allowNull: true,
        },

        transaction_id: {
            type:      DataTypes.INTEGER.UNSIGNED,
            allowNull: true,
        },

    }, {
        sequelize,
        modelName:   'DeliveryPayoutRequest',
        tableName:   'delivery_payout_requests',
        timestamps:  true,
        underscored: true,
    });

    return DeliveryPayoutRequest;
};