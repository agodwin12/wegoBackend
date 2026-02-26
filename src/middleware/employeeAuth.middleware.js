// backend/middleware/employeeAuth.middleware.js
// Employee Authentication Middleware (Backoffice)

const jwt = require("jsonwebtoken");
const { Employee } = require("../models");

/**
 * Authentication middleware for backoffice employees
 * Verifies JWT token and attaches employee to request
 */
async function authenticateEmployee(req, res, next) {
    try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🔐 [EMPLOYEE AUTH] Checking authentication...');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        // ═══════════════════════════════════════════════════════════════
        // STEP 1: Check for Authorization header
        // ═══════════════════════════════════════════════════════════════
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            console.log('❌ [EMPLOYEE AUTH] No token provided or invalid format');
            console.log('   Authorization header:', authHeader ? 'Present but invalid format' : 'Missing');

            return res.status(401).json({
                success: false,
                message: 'Authentication required. Please provide a valid token.',
                code: 'NO_TOKEN_PROVIDED'
            });
        }

        // ═══════════════════════════════════════════════════════════════
        // STEP 2: Extract and verify token
        // ═══════════════════════════════════════════════════════════════
        const token = authHeader.substring(7); // Remove "Bearer " prefix
        console.log('🔑 [EMPLOYEE AUTH] Token extracted from header');

        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch (tokenError) {
            console.log('❌ [EMPLOYEE AUTH] Token verification failed:', tokenError.message);

            if (tokenError.name === 'TokenExpiredError') {
                return res.status(401).json({
                    success: false,
                    message: 'Your session has expired. Please login again.',
                    code: 'TOKEN_EXPIRED'
                });
            } else if (tokenError.name === 'JsonWebTokenError') {
                return res.status(401).json({
                    success: false,
                    message: 'Invalid authentication token.',
                    code: 'INVALID_TOKEN'
                });
            } else {
                return res.status(401).json({
                    success: false,
                    message: 'Authentication failed.',
                    code: 'TOKEN_VERIFICATION_FAILED'
                });
            }
        }

        // Check if token is for employee
        if (!decoded || decoded.type !== 'employee') {
            console.log('❌ [EMPLOYEE AUTH] Token is not for employee');
            console.log('   Token type:', decoded?.type || 'undefined');

            return res.status(403).json({
                success: false,
                message: 'Access denied. Employees only.',
                code: 'INVALID_USER_TYPE'
            });
        }

        if (!decoded.id) {
            console.log('❌ [EMPLOYEE AUTH] Token decoded but missing employee ID');
            return res.status(401).json({
                success: false,
                message: 'Invalid token payload.',
                code: 'INVALID_TOKEN_PAYLOAD'
            });
        }

        console.log('✅ [EMPLOYEE AUTH] Token verified successfully');
        console.log('   Employee ID:', decoded.id);
        console.log('   Employee Email:', decoded.email);
        console.log('   Employee Role:', decoded.role);

        // ═══════════════════════════════════════════════════════════════
        // STEP 3: Fetch employee account from database
        // ═══════════════════════════════════════════════════════════════
        console.log('🔍 [EMPLOYEE AUTH] Fetching employee from database...');

        const employee = await Employee.findByPk(decoded.id, {
            attributes: { exclude: ['password'] }
        });

        if (!employee) {
            console.log('❌ [EMPLOYEE AUTH] Employee not found in database');
            console.log('   Attempted ID:', decoded.id);

            return res.status(401).json({
                success: false,
                message: 'Employee account not found. Please login again.',
                code: 'EMPLOYEE_NOT_FOUND'
            });
        }

        console.log('✅ [EMPLOYEE AUTH] Employee found');
        console.log('   Name:', employee.first_name, employee.last_name);
        console.log('   Email:', employee.email);
        console.log('   Role:', employee.role);
        console.log('   Status:', employee.status);

        // ═══════════════════════════════════════════════════════════════
        // STEP 4: Check employee status
        // ═══════════════════════════════════════════════════════════════
        if (employee.status === 'blocked') {
            console.log('❌ [EMPLOYEE AUTH] Employee account is blocked');

            return res.status(403).json({
                success: false,
                message: 'Your account has been blocked. Please contact administrator.',
                code: 'EMPLOYEE_BLOCKED'
            });
        }

        if (employee.status === 'suspended') {
            console.log('⚠️  [EMPLOYEE AUTH] Employee account is suspended');

            return res.status(403).json({
                success: false,
                message: 'Your account has been suspended. Please contact administrator.',
                code: 'EMPLOYEE_SUSPENDED'
            });
        }

        if (employee.status !== 'active') {
            console.log('❌ [EMPLOYEE AUTH] Employee account is not active');
            console.log('   Current status:', employee.status);

            return res.status(403).json({
                success: false,
                message: 'Your account is not active. Please contact administrator.',
                code: 'EMPLOYEE_NOT_ACTIVE'
            });
        }

        // ═══════════════════════════════════════════════════════════════
        // STEP 5: Check if account is locked
        // ═══════════════════════════════════════════════════════════════
        if (employee.isLocked && employee.isLocked()) {
            console.log('🔒 [EMPLOYEE AUTH] Employee account is locked');

            return res.status(403).json({
                success: false,
                message: 'Your account is temporarily locked due to multiple failed login attempts.',
                code: 'EMPLOYEE_LOCKED'
            });
        }

        // ═══════════════════════════════════════════════════════════════
        // STEP 6: Attach employee to request and proceed
        // ═══════════════════════════════════════════════════════════════
        console.log('✅ [EMPLOYEE AUTH] Authentication successful!');
        console.log('   Employee:', employee.first_name, employee.last_name);
        console.log('   ID:', employee.id);
        console.log('   Role:', employee.role);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        req.user = employee;
        next();

    } catch (err) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ [EMPLOYEE AUTH MIDDLEWARE ERROR]');
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('Error Message:', err.message);
        console.error('Error Stack:', err.stack);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(err.status || 500).json({
            success: false,
            message: err.message || 'Authentication failed.',
            code: err.code || 'EMPLOYEE_AUTH_ERROR'
        });
    }
}

/**
 * Middleware to check if employee has specific role(s)
 * Usage: router.delete('/employees/:id', authenticateEmployee, requireEmployeeRole('super_admin', 'admin'), ...)
 */
function requireEmployeeRole(...allowedRoles) {
    return (req, res, next) => {
        if (!req.user) {
            console.log('❌ [EMPLOYEE AUTH] User not authenticated');

            return res.status(401).json({
                success: false,
                message: 'Authentication required.',
                code: 'NOT_AUTHENTICATED'
            });
        }

        if (!allowedRoles.includes(req.user.role)) {
            console.log('❌ [EMPLOYEE AUTH] Insufficient permissions');
            console.log('   Required roles:', allowedRoles);
            console.log('   Employee has:', req.user.role);

            return res.status(403).json({
                success: false,
                message: `Access denied. Required roles: ${allowedRoles.join(', ')}`,
                code: 'INSUFFICIENT_PERMISSIONS'
            });
        }

        console.log('✅ [EMPLOYEE AUTH] Role check passed');
        console.log('   Employee role:', req.user.role);

        next();
    };
}

/**
 * Middleware to check if employee can modify target employee
 * Super admins can modify anyone, admins can modify non-admins
 */
function canModifyEmployee(req, res, next) {
    const currentEmployee = req.user;
    const targetEmployeeId = parseInt(req.params.id);

    console.log('🔍 [EMPLOYEE AUTH] Checking modification permissions');
    console.log('   Current employee:', currentEmployee.id, `(${currentEmployee.role})`);
    console.log('   Target employee:', targetEmployeeId);

    // Super admin can modify anyone
    if (currentEmployee.role === 'super_admin') {
        console.log('✅ [EMPLOYEE AUTH] Super admin - allowed');
        return next();
    }

    // Employees cannot modify themselves through this endpoint
    if (currentEmployee.id === targetEmployeeId) {
        console.log('❌ [EMPLOYEE AUTH] Cannot modify own account through this endpoint');

        return res.status(403).json({
            success: false,
            message: 'You cannot modify your own account through this endpoint.',
            code: 'CANNOT_MODIFY_SELF'
        });
    }

    // Admin can modify non-admins
    if (currentEmployee.role === 'admin') {
        // Would need to check target employee role from DB
        // For now, allow and handle in controller
        console.log('⚠️  [EMPLOYEE AUTH] Admin modifying employee - will validate in controller');
        return next();
    }

    // Other roles cannot modify employees
    console.log('❌ [EMPLOYEE AUTH] Insufficient permissions to modify employees');

    return res.status(403).json({
        success: false,
        message: 'You do not have permission to modify employee accounts.',
        code: 'INSUFFICIENT_PERMISSIONS'
    });
}

module.exports = {
    authenticateEmployee,
    requireEmployeeRole,
    canModifyEmployee,
};