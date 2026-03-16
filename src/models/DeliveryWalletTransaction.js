// src/models/DeliveryWalletTransaction.js

const { DataTypes, Model } = require('sequelize');

module.exports = (sequelize) => {

    class DeliveryWalletTransaction extends Model {

        get isCredit() {
            return ['delivery_earning','cash_collected','cash_commission_paid',
                'withdrawal_reversal','adjustment_credit'].includes(this.type);
        }

        get isDebit() {
            return ['commission_deduction','cash_commission_owed',
                'withdrawal','adjustment_debit'].includes(this.type);
        }

        get typeLabel() {
            const labels = {
                delivery_earning:     'Delivery Earning',
                cash_collected:       'Cash Collected',
                commission_deduction: 'WEGO Commission',
                cash_commission_owed: 'Cash Commission Due',
                cash_commission_paid: 'Cash Commission Settled',
                withdrawal:           'Withdrawal',
                withdrawal_reversal:  'Withdrawal Reversed',
                adjustment_credit:    'Manual Credit',
                adjustment_debit:     'Manual Debit',
            };
            return labels[this.type] || this.type;
        }

        static associate(models) {
            DeliveryWalletTransaction.belongsTo(models.DeliveryWallet, {
                foreignKey: 'wallet_id',
                as:         'wallet',
            });

            DeliveryWalletTransaction.belongsTo(models.Delivery, {
                foreignKey: 'delivery_id',
                as:         'delivery',
            });

            if (models.Employee) {
                DeliveryWalletTransaction.belongsTo(models.Employee, {
                    foreignKey: 'created_by_employee_id',
                    as:         'createdByEmployee',
                });
            }
        }
    }

    DeliveryWalletTransaction.init({
        id: {
            type:          DataTypes.INTEGER.UNSIGNED,
            autoIncrement: true,
            primaryKey:    true,
        },

        wallet_id: {
            type:      DataTypes.INTEGER.UNSIGNED,
            allowNull: false,
            // No references — table created manually via SQL
        },

        delivery_id: {
            type:      DataTypes.INTEGER.UNSIGNED,
            allowNull: true,
        },

        type: {
            type: DataTypes.ENUM(
                'delivery_earning',
                'cash_collected',
                'commission_deduction',
                'cash_commission_owed',
                'cash_commission_paid',
                'withdrawal',
                'withdrawal_reversal',
                'adjustment_credit',
                'adjustment_debit'
            ),
            allowNull: false,
        },

        payment_method: {
            type:      DataTypes.ENUM('mtn_mobile_money', 'orange_money', 'cash', 'system'),
            allowNull: true,
        },

        amount: {
            type:      DataTypes.DECIMAL(12, 2),
            allowNull: false,
            get() { return parseFloat(this.getDataValue('amount') || 0); },
        },

        balance_before: {
            type:      DataTypes.DECIMAL(12, 2),
            allowNull: false,
            get() { return parseFloat(this.getDataValue('balance_before') || 0); },
        },

        balance_after: {
            type:      DataTypes.DECIMAL(12, 2),
            allowNull: false,
            get() { return parseFloat(this.getDataValue('balance_after') || 0); },
        },

        notes: {
            type:      DataTypes.STRING(500),
            allowNull: true,
        },

        created_by_employee_id: {
            type:      DataTypes.INTEGER.UNSIGNED,
            allowNull: true,
        },

    }, {
        sequelize,
        modelName:   'DeliveryWalletTransaction',
        tableName:   'delivery_wallet_transactions',
        timestamps:  true,
        underscored: true,
        updatedAt:   false,
    });

    return DeliveryWalletTransaction;
};