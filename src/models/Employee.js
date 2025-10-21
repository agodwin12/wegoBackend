// src/models/Employee.js
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    const Employee = sequelize.define('Employee', {
        id: {
            type: DataTypes.UUID,
            defaultValue: DataTypes.UUIDV4,
            primaryKey: true,
            allowNull: false,
            field: 'id'
        },
        accountId: {
            type: DataTypes.UUID,
            allowNull: false,
            unique: true,
            field: 'account_id',  // Database column name
            references: {
                model: 'accounts',
                key: 'uuid'
            }
        },
        employeeCode: {
            type: DataTypes.STRING(20),
            unique: true,
            allowNull: false,
            field: 'employee_code'  // Database column name
        },
        department: {
            type: DataTypes.STRING(100),
            allowNull: true,
            field: 'department'
        },
        position: {
            type: DataTypes.STRING(100),
            allowNull: true,
            field: 'position'
        },
        hireDate: {
            type: DataTypes.DATEONLY,
            allowNull: true,
            field: 'hire_date'
        },
        salary: {
            type: DataTypes.DECIMAL(15, 2),
            allowNull: true,
            field: 'salary'
        },
        employmentStatus: {
            type: DataTypes.ENUM('ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'TERMINATED'),
            defaultValue: 'ACTIVE',
            allowNull: false,
            field: 'employment_status'  // Database column name
        },
        supervisorId: {
            type: DataTypes.UUID,
            allowNull: true,
            field: 'supervisor_id'
        },
        emergencyContactName: {
            type: DataTypes.STRING(100),
            allowNull: true,
            field: 'emergency_contact_name'
        },
        emergencyContactPhone: {
            type: DataTypes.STRING(20),
            allowNull: true,
            field: 'emergency_contact_phone'
        },
        notes: {
            type: DataTypes.TEXT,
            allowNull: true,
            field: 'notes'
        }
    }, {
        tableName: 'employees',
        underscored: true,
        timestamps: true,
        createdAt: 'created_at',
        updatedAt: 'updated_at'
    });

    return Employee;
};