// backend/models/FAQ.js

module.exports = (sequelize, DataTypes) => {
    const FAQ = sequelize.define('FAQ', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true
        },
        category: {
            type: DataTypes.STRING(50),
            allowNull: false
        },
        question: {
            type: DataTypes.TEXT,
            allowNull: false
        },
        answer: {
            type: DataTypes.TEXT,
            allowNull: false
        },
        order: {
            type: DataTypes.INTEGER,
            defaultValue: 0
        },
        is_active: {
            type: DataTypes.BOOLEAN,
            defaultValue: true
        },
        language: {
            type: DataTypes.STRING(2),
            defaultValue: 'en'
        },
        created_by: {
            type: DataTypes.INTEGER,
            allowNull: true
        }
    }, {
        tableName: 'faqs',
        underscored: true,
        timestamps: true
    });

    FAQ.associate = (models) => {
        FAQ.belongsTo(models.User, {
            foreignKey: 'created_by',
            as: 'creator'
        });
    };

    return FAQ;
};