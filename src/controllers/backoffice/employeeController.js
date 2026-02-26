// backend/controllers/backoffice/employeeController.js
// Employee Management Controller

const { Employee, sequelize } = require("../../models");
const { Op } = require("sequelize");
const { uploadProfileToR2, deleteFile } = require("../../middleware/upload");
const jwt = require("jsonwebtoken");

/* ================================
   CREATE EMPLOYEE
================================= */
exports.createEmployee = async (req, res) => {
    try {
        const {
            first_name,
            last_name,
            email,
            phone,
            password,
            role,
            gender,
            date_of_birth,
            address,
            city,
            department,
            hire_date,
        } = req.body;

        // Check if email already exists
        const existingEmployee = await Employee.findByEmail(email);
        if (existingEmployee) {
            return res.status(400).json({
                success: false,
                message: "Email already registered",
            });
        }

        // Check if phone already exists
        const existingPhone = await Employee.findOne({ where: { phone } });
        if (existingPhone) {
            return res.status(400).json({
                success: false,
                message: "Phone number already registered",
            });
        }

        // Upload profile photo if provided
        let profile_photo_url = null;
        if (req.file) {
            profile_photo_url = await uploadProfileToR2(req.file);
        }

        // Generate employee ID
        const employee_id = Employee.generateEmployeeId();

        // Create employee
        const employee = await Employee.create({
            first_name,
            last_name,
            email,
            phone,
            password,
            role: role || "support",
            gender,
            date_of_birth,
            address,
            city,
            department,
            hire_date: hire_date || new Date(),
            employee_id,
            profile_photo: profile_photo_url,
            created_by: req.user?.id || null, // ID of logged-in employee
            status: "active",
        });

        res.status(201).json({
            success: true,
            message: "Employee created successfully",
            employee: employee.toSafeObject(),
        });
    } catch (error) {
        console.error("❌ Create Employee Error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to create employee",
            error: error.message,
        });
    }
};

/* ================================
   GET ALL EMPLOYEES
================================= */
exports.getAllEmployees = async (req, res) => {
    try {
        const {
            page = 1,
            limit = 10,
            search = "",
            role = "",
            status = "",
            sortBy = "createdAt",
            sortOrder = "DESC",
        } = req.query;

        const offset = (page - 1) * limit;

        // Build where clause
        const whereClause = {};

        if (search) {
            whereClause[Op.or] = [
                { first_name: { [Op.like]: `%${search}%` } },
                { last_name: { [Op.like]: `%${search}%` } },
                { email: { [Op.like]: `%${search}%` } },
                { employee_id: { [Op.like]: `%${search}%` } },
            ];
        }

        if (role) {
            whereClause.role = role;
        }

        if (status) {
            whereClause.status = status;
        }

        // Get employees with pagination
        const { count, rows: employees } = await Employee.findAndCountAll({
            where: whereClause,
            limit: parseInt(limit),
            offset: parseInt(offset),
            order: [[sortBy, sortOrder]],
            attributes: { exclude: ["password"] },
        });

        res.json({
            success: true,
            data: employees,
            pagination: {
                total: count,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(count / limit),
            },
        });
    } catch (error) {
        console.error("❌ Get Employees Error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch employees",
            error: error.message,
        });
    }
};

/* ================================
   GET SINGLE EMPLOYEE
================================= */
exports.getEmployeeById = async (req, res) => {
    try {
        const { id } = req.params;

        const employee = await Employee.findByPk(id, {
            attributes: { exclude: ["password"] },
        });

        if (!employee) {
            return res.status(404).json({
                success: false,
                message: "Employee not found",
            });
        }

        res.json({
            success: true,
            employee: employee.toSafeObject(),
        });
    } catch (error) {
        console.error("❌ Get Employee Error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch employee",
            error: error.message,
        });
    }
};

/* ================================
   UPDATE EMPLOYEE
================================= */
exports.updateEmployee = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            first_name,
            last_name,
            email,
            phone,
            role,
            gender,
            date_of_birth,
            address,
            city,
            department,
        } = req.body;

        const employee = await Employee.findByPk(id);
        if (!employee) {
            return res.status(404).json({
                success: false,
                message: "Employee not found",
            });
        }

        // Check if email is being changed and already exists
        if (email && email !== employee.email) {
            const existingEmail = await Employee.findByEmail(email);
            if (existingEmail) {
                return res.status(400).json({
                    success: false,
                    message: "Email already registered",
                });
            }
        }

        // Check if phone is being changed and already exists
        if (phone && phone !== employee.phone) {
            const existingPhone = await Employee.findOne({ where: { phone } });
            if (existingPhone) {
                return res.status(400).json({
                    success: false,
                    message: "Phone number already registered",
                });
            }
        }

        // Handle profile photo update
        if (req.file) {
            // Delete old photo from R2
            if (employee.profile_photo) {
                await deleteFile(employee.profile_photo);
            }
            // Upload new photo
            employee.profile_photo = await uploadProfileToR2(req.file);
        }

        // Update fields
        employee.first_name = first_name || employee.first_name;
        employee.last_name = last_name || employee.last_name;
        employee.email = email || employee.email;
        employee.phone = phone || employee.phone;
        employee.role = role || employee.role;
        employee.gender = gender || employee.gender;
        employee.date_of_birth = date_of_birth || employee.date_of_birth;
        employee.address = address || employee.address;
        employee.city = city || employee.city;
        employee.department = department || employee.department;

        await employee.save();

        res.json({
            success: true,
            message: "Employee updated successfully",
            employee: employee.toSafeObject(),
        });
    } catch (error) {
        console.error("❌ Update Employee Error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to update employee",
            error: error.message,
        });
    }
};

/* ================================
   UPDATE EMPLOYEE PASSWORD
================================= */
exports.updatePassword = async (req, res) => {
    try {
        const { id } = req.params;
        const { new_password } = req.body;

        if (!new_password || new_password.length < 8) {
            return res.status(400).json({
                success: false,
                message: "Password must be at least 8 characters long",
            });
        }

        const employee = await Employee.findByPk(id);
        if (!employee) {
            return res.status(404).json({
                success: false,
                message: "Employee not found",
            });
        }

        employee.password = new_password;
        await employee.save();

        res.json({
            success: true,
            message: "Password updated successfully",
        });
    } catch (error) {
        console.error("❌ Update Password Error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to update password",
            error: error.message,
        });
    }
};

/* ================================
   BLOCK EMPLOYEE
================================= */
exports.blockEmployee = async (req, res) => {
    try {
        const { id } = req.params;

        const employee = await Employee.findByPk(id);
        if (!employee) {
            return res.status(404).json({
                success: false,
                message: "Employee not found",
            });
        }

        employee.status = "blocked";
        await employee.save();

        res.json({
            success: true,
            message: "Employee blocked successfully",
            employee: employee.toSafeObject(),
        });
    } catch (error) {
        console.error("❌ Block Employee Error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to block employee",
            error: error.message,
        });
    }
};

/* ================================
   UNBLOCK EMPLOYEE
================================= */
exports.unblockEmployee = async (req, res) => {
    try {
        const { id } = req.params;

        const employee = await Employee.findByPk(id);
        if (!employee) {
            return res.status(404).json({
                success: false,
                message: "Employee not found",
            });
        }

        employee.status = "active";
        await employee.save();

        res.json({
            success: true,
            message: "Employee unblocked successfully",
            employee: employee.toSafeObject(),
        });
    } catch (error) {
        console.error("❌ Unblock Employee Error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to unblock employee",
            error: error.message,
        });
    }
};

/* ================================
   DELETE EMPLOYEE (SOFT DELETE)
================================= */
exports.deleteEmployee = async (req, res) => {
    try {
        const { id } = req.params;

        const employee = await Employee.findByPk(id);
        if (!employee) {
            return res.status(404).json({
                success: false,
                message: "Employee not found",
            });
        }

        // Soft delete (sets deleted_at timestamp)
        await employee.destroy();

        res.json({
            success: true,
            message: "Employee deleted successfully",
        });
    } catch (error) {
        console.error("❌ Delete Employee Error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to delete employee",
            error: error.message,
        });
    }
};

/* ================================
   RESTORE DELETED EMPLOYEE
================================= */
exports.restoreEmployee = async (req, res) => {
    try {
        const { id } = req.params;

        const employee = await Employee.findByPk(id, {
            paranoid: false, // Include soft-deleted records
        });

        if (!employee) {
            return res.status(404).json({
                success: false,
                message: "Employee not found",
            });
        }

        if (!employee.deleted_at) {
            return res.status(400).json({
                success: false,
                message: "Employee is not deleted",
            });
        }

        await employee.restore();

        res.json({
            success: true,
            message: "Employee restored successfully",
            employee: employee.toSafeObject(),
        });
    } catch (error) {
        console.error("❌ Restore Employee Error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to restore employee",
            error: error.message,
        });
    }
};

/* ================================
   GET DASHBOARD STATS
================================= */
exports.getEmployeeStats = async (req, res) => {
    try {
        const totalEmployees = await Employee.count();
        const activeEmployees = await Employee.count({ where: { status: "active" } });
        const blockedEmployees = await Employee.count({ where: { status: "blocked" } });

        // Count by role
        const byRole = await Employee.findAll({
            attributes: [
                "role",
                [sequelize.fn("COUNT", sequelize.col("id")), "count"],
            ],
            group: ["role"],
        });

        res.json({
            success: true,
            stats: {
                total: totalEmployees,
                active: activeEmployees,
                blocked: blockedEmployees,
                byRole,
            },
        });
    } catch (error) {
        console.error("❌ Get Stats Error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch statistics",
            error: error.message,
        });
    }
};