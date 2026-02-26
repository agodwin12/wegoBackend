// backend/models/Employee.js
// Employee Model for Backoffice Admin Panel

const { DataTypes } = require("sequelize");
const bcrypt = require("bcryptjs");

module.exports = (sequelize) => {
    const Employee = sequelize.define(
        "Employee",
        {
            id: {
                type: DataTypes.INTEGER,
                primaryKey: true,
                autoIncrement: true,
            },

            // Basic Information
            first_name: {
                type: DataTypes.STRING(100),
                allowNull: false,
            },
            last_name: {
                type: DataTypes.STRING(100),
                allowNull: false,
            },
            email: {
                type: DataTypes.STRING(255),
                allowNull: false,
                unique: true,
                validate: {
                    isEmail: true,
                },
            },
            phone: {
                type: DataTypes.STRING(20),
                allowNull: false,
                unique: true,
            },
            gender: {
                type: DataTypes.ENUM("male", "female", "other"),
                allowNull: true,
            },
            date_of_birth: {
                type: DataTypes.DATEONLY,
                allowNull: true,
            },

            // Authentication
            password: {
                type: DataTypes.STRING(255),
                allowNull: false,
            },

            // Profile
            profile_photo: {
                type: DataTypes.TEXT,
                allowNull: true,
                comment: "Cloudflare R2 URL",
            },

            // Role & Permissions
            role: {
                type: DataTypes.ENUM(
                    "super_admin",
                    "admin",
                    "manager",
                    "support",
                    "accountant",
                    "operations"
                ),
                allowNull: false,
                defaultValue: "support",
            },

            // Status
            status: {
                type: DataTypes.ENUM("active", "blocked", "suspended"),
                allowNull: false,
                defaultValue: "active",
            },

            // Additional Info
            address: {
                type: DataTypes.TEXT,
                allowNull: true,
            },
            city: {
                type: DataTypes.STRING(100),
                allowNull: true,
            },
            country: {
                type: DataTypes.STRING(100),
                allowNull: true,
                defaultValue: "Cameroon",
            },

            // Employment Details
            employee_id: {
                type: DataTypes.STRING(50),
                allowNull: true,
                unique: true,
                comment: "Company employee ID number",
            },
            hire_date: {
                type: DataTypes.DATEONLY,
                allowNull: true,
            },
            department: {
                type: DataTypes.STRING(100),
                allowNull: true,
            },

            // Metadata
            created_by: {
                type: DataTypes.INTEGER,
                allowNull: true,
                comment: "ID of employee who created this record",
            },
            last_login: {
                type: DataTypes.DATE,
                allowNull: true,
            },
            login_attempts: {
                type: DataTypes.INTEGER,
                defaultValue: 0,
            },
            locked_until: {
                type: DataTypes.DATE,
                allowNull: true,
                comment: "Account locked until this time (for security)",
            },

            // Soft Delete
            deleted_at: {
                type: DataTypes.DATE,
                allowNull: true,
            },
        },
        {
            tableName: "employees",
            timestamps: true,
            paranoid: true, // Enables soft delete

            // Hooks for password hashing
            hooks: {
                beforeCreate: async (employee) => {
                    if (employee.password) {
                        const salt = await bcrypt.genSalt(10);
                        employee.password = await bcrypt.hash(employee.password, salt);
                    }
                },
                beforeUpdate: async (employee) => {
                    if (employee.changed("password")) {
                        const salt = await bcrypt.genSalt(10);
                        employee.password = await bcrypt.hash(employee.password, salt);
                    }
                },
            },
        }
    );

    /* ================================
       INSTANCE METHODS
    ================================= */

    // Compare password
    Employee.prototype.comparePassword = async function (candidatePassword) {
        return await bcrypt.compare(candidatePassword, this.password);
    };

    // Get full name
    Employee.prototype.getFullName = function () {
        return `${this.first_name} ${this.last_name}`;
    };

    // Check if account is locked
    Employee.prototype.isLocked = function () {
        return this.locked_until && new Date() < new Date(this.locked_until);
    };

    // Lock account for failed login attempts
    Employee.prototype.lockAccount = async function (minutes = 30) {
        this.locked_until = new Date(Date.now() + minutes * 60 * 1000);
        this.login_attempts = 0;
        await this.save();
    };

    // Increment login attempts
    Employee.prototype.incrementLoginAttempts = async function () {
        this.login_attempts += 1;

        // Lock account after 5 failed attempts
        if (this.login_attempts >= 5) {
            await this.lockAccount(30); // Lock for 30 minutes
        } else {
            await this.save();
        }
    };

    // Reset login attempts on successful login
    Employee.prototype.resetLoginAttempts = async function () {
        this.login_attempts = 0;
        this.last_login = new Date();
        await this.save();
    };

    // Get safe employee data (without password)
    Employee.prototype.toSafeObject = function () {
        const {
            password,
            login_attempts,
            locked_until,
            ...safeData
        } = this.toJSON();
        return safeData;
    };

    /* ================================
       CLASS METHODS
    ================================= */

    // Find by email
    Employee.findByEmail = async function (email) {
        return await this.findOne({ where: { email } });
    };

    // Find active employees only
    Employee.findActive = async function () {
        return await this.findAll({ where: { status: "active" } });
    };

    // Generate employee ID
    Employee.generateEmployeeId = function () {
        const prefix = "EMP";
        const timestamp = Date.now().toString().slice(-6);
        const random = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
        return `${prefix}${timestamp}${random}`;
    };

    /* ================================
       ASSOCIATIONS (Add in index.js)
    ================================= */
    Employee.associate = (models) => {
        // Employee created by another employee
        Employee.belongsTo(models.Employee, {
            foreignKey: "created_by",
            as: "creator",
        });
    };

    return Employee;
};