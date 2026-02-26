// backend/routes/backoffice/authRoutes.js
// Employee Authentication Routes

const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const { Employee } = require("../../models");

/* ================================
   EMPLOYEE LOGIN
================================= */
router.post("/login", async (req, res) => {
    try {
        const { email, password } = req.body;

        // Validate input
        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: "Email and password are required",
            });
        }

        // Find employee by email
        const employee = await Employee.findByEmail(email);
        if (!employee) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password",
            });
        }

        // Check if account is locked
        if (employee.isLocked()) {
            return res.status(403).json({
                success: false,
                message: "Account is locked due to multiple failed login attempts. Please try again later.",
            });
        }

        // Check if account is blocked
        if (employee.status === "blocked") {
            return res.status(403).json({
                success: false,
                message: "Your account has been blocked. Please contact administrator.",
            });
        }

        // Verify password
        const isPasswordValid = await employee.comparePassword(password);
        if (!isPasswordValid) {
            // Increment login attempts
            await employee.incrementLoginAttempts();

            return res.status(401).json({
                success: false,
                message: "Invalid email or password",
            });
        }

        // Reset login attempts on successful login
        await employee.resetLoginAttempts();

        // Generate JWT token
        const token = jwt.sign(
            {
                id: employee.id,
                email: employee.email,
                role: employee.role,
                type: "employee",
            },
            process.env.JWT_SECRET,
            { expiresIn: "24h" }
        );

        res.json({
            success: true,
            message: "Login successful",
            token,
            user: employee.toSafeObject(),
        });
    } catch (error) {
        console.error("❌ Login Error:", error);
        res.status(500).json({
            success: false,
            message: "Login failed",
            error: error.message,
        });
    }
});

/* ================================
   GET CURRENT EMPLOYEE (ME)
================================= */
router.get("/me", async (req, res) => {
    try {
        // Extract token from header
        const token = req.headers.authorization?.split(" ")[1];
        if (!token) {
            return res.status(401).json({
                success: false,
                message: "No token provided",
            });
        }

        // Verify token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Get employee
        const employee = await Employee.findByPk(decoded.id, {
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
            user: employee.toSafeObject(),
        });
    } catch (error) {
        console.error("❌ Get Me Error:", error);
        res.status(401).json({
            success: false,
            message: "Invalid token",
        });
    }
});

/* ================================
   LOGOUT (CLIENT-SIDE)
================================= */
router.post("/logout", (req, res) => {
    // Logout is handled client-side by removing token
    res.json({
        success: true,
        message: "Logout successful",
    });
});

module.exports = router;