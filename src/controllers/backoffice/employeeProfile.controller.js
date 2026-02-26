// backend/src/controllers/backoffice/employeeProfile.controller.js
// Employee Profile Management Controller

const { Employee, Account } = require('../../models');
const bcrypt = require('bcrypt');
const { uploadToR2, deleteFromR2 } = require('../../utils/r2Upload');

// ═══════════════════════════════════════════════════════════════════════
// GET CURRENT EMPLOYEE PROFILE
// GET /api/employee/profile
// ═══════════════════════════════════════════════════════════════════════

const getProfile = async (req, res) => {
    try {
        const employeeId = req.user.id;

        console.log(`👤 [EMPLOYEE_PROFILE] Fetching profile for employee ID: ${employeeId}`);

        const employee = await Employee.findByPk(employeeId, {
            include: [
                {
                    model: Account,
                    as: 'account',
                    attributes: ['uuid', 'phone_e164', 'email', 'created_at'],
                }
            ],
            attributes: {
                exclude: ['password', 'accountId'] // Don't send password hash
            }
        });

        if (!employee) {
            console.log(`❌ [EMPLOYEE_PROFILE] Employee not found: ${employeeId}`);
            return res.status(404).json({
                success: false,
                message: 'Employee not found',
            });
        }

        console.log(`✅ [EMPLOYEE_PROFILE] Profile retrieved successfully`);

        res.status(200).json({
            success: true,
            message: 'Profile retrieved successfully',
            data: employee,
        });

    } catch (error) {
        console.error('❌ [EMPLOYEE_PROFILE] Error in getProfile:', error);
        console.error('Stack trace:', error.stack);

        res.status(500).json({
            success: false,
            message: 'Unable to fetch profile. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// UPDATE EMPLOYEE PROFILE
// PUT /api/employee/profile
// ═══════════════════════════════════════════════════════════════════════

const updateProfile = async (req, res) => {
    try {
        const employeeId = req.user.id;
        const {
            first_name,
            last_name,
            phone,
            bio,
            department,
        } = req.body;

        console.log(`📝 [EMPLOYEE_PROFILE] Updating profile for employee ID: ${employeeId}`);

        // ─────────────────────────────────────────────────────────────────
        // FETCH EMPLOYEE
        // ─────────────────────────────────────────────────────────────────

        const employee = await Employee.findByPk(employeeId);

        if (!employee) {
            console.log(`❌ [EMPLOYEE_PROFILE] Employee not found: ${employeeId}`);
            return res.status(404).json({
                success: false,
                message: 'Employee not found',
            });
        }

        // ─────────────────────────────────────────────────────────────────
        // VALIDATION
        // ─────────────────────────────────────────────────────────────────

        // Validate first_name
        if (first_name !== undefined) {
            if (!first_name || first_name.trim().length < 2) {
                return res.status(400).json({
                    success: false,
                    message: 'First name must be at least 2 characters',
                });
            }
        }

        // Validate last_name
        if (last_name !== undefined) {
            if (!last_name || last_name.trim().length < 2) {
                return res.status(400).json({
                    success: false,
                    message: 'Last name must be at least 2 characters',
                });
            }
        }

        // Validate phone (if provided)
        if (phone !== undefined && phone) {
            const phoneRegex = /^\+?[1-9]\d{1,14}$/;
            if (!phoneRegex.test(phone)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid phone number format',
                });
            }
        }

        // Validate bio (if provided)
        if (bio !== undefined && bio && bio.length > 500) {
            return res.status(400).json({
                success: false,
                message: 'Bio cannot exceed 500 characters',
            });
        }

        // ─────────────────────────────────────────────────────────────────
        // UPDATE PROFILE
        // ─────────────────────────────────────────────────────────────────

        const updateData = {};

        if (first_name !== undefined) updateData.first_name = first_name.trim();
        if (last_name !== undefined) updateData.last_name = last_name.trim();
        if (phone !== undefined) updateData.phone = phone;
        if (bio !== undefined) updateData.bio = bio.trim();
        if (department !== undefined) updateData.department = department;

        await employee.update(updateData);

        console.log(`✅ [EMPLOYEE_PROFILE] Profile updated successfully`);

        // Fetch updated profile
        const updatedEmployee = await Employee.findByPk(employeeId, {
            include: [
                {
                    model: Account,
                    as: 'account',
                    attributes: ['uuid', 'phone_e164', 'email', 'created_at'],
                }
            ],
            attributes: {
                exclude: ['password', 'accountId']
            }
        });

        res.status(200).json({
            success: true,
            message: 'Profile updated successfully',
            data: updatedEmployee,
        });

    } catch (error) {
        console.error('❌ [EMPLOYEE_PROFILE] Error in updateProfile:', error);
        console.error('Stack trace:', error.stack);

        res.status(500).json({
            success: false,
            message: 'Unable to update profile. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// UPDATE PROFILE PHOTO
// PUT /api/employee/profile/photo
// ═══════════════════════════════════════════════════════════════════════

const updateProfilePhoto = async (req, res) => {
    try {
        const employeeId = req.user.id;

        console.log(`📸 [EMPLOYEE_PROFILE] Updating profile photo for employee ID: ${employeeId}`);

        // ─────────────────────────────────────────────────────────────────
        // VALIDATION
        // ─────────────────────────────────────────────────────────────────

        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No photo file provided',
            });
        }

        // ─────────────────────────────────────────────────────────────────
        // FETCH EMPLOYEE
        // ─────────────────────────────────────────────────────────────────

        const employee = await Employee.findByPk(employeeId);

        if (!employee) {
            return res.status(404).json({
                success: false,
                message: 'Employee not found',
            });
        }

        // ─────────────────────────────────────────────────────────────────
        // UPLOAD TO R2
        // ─────────────────────────────────────────────────────────────────

        const photoUrl = await uploadToR2(
            req.file.buffer,
            req.file.originalname,
            'employees/profile-photos',
            req.file.mimetype
        );

        console.log(`📸 [EMPLOYEE_PROFILE] Photo uploaded: ${photoUrl}`);

        // ─────────────────────────────────────────────────────────────────
        // DELETE OLD PHOTO (if exists)
        // ─────────────────────────────────────────────────────────────────

        if (employee.profile_photo) {
            try {
                await deleteFromR2(employee.profile_photo);
                console.log(`🗑️ [EMPLOYEE_PROFILE] Deleted old photo`);
            } catch (err) {
                console.log(`⚠️ [EMPLOYEE_PROFILE] Could not delete old photo:`, err.message);
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // UPDATE EMPLOYEE RECORD
        // ─────────────────────────────────────────────────────────────────

        await employee.update({
            profile_photo: photoUrl,
        });

        console.log(`✅ [EMPLOYEE_PROFILE] Profile photo updated successfully`);

        res.status(200).json({
            success: true,
            message: 'Profile photo updated successfully',
            data: {
                profile_photo: photoUrl,
            },
        });

    } catch (error) {
        console.error('❌ [EMPLOYEE_PROFILE] Error in updateProfilePhoto:', error);
        console.error('Stack trace:', error.stack);

        res.status(500).json({
            success: false,
            message: 'Unable to update profile photo. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// CHANGE PASSWORD
// PUT /api/employee/profile/password
// ═══════════════════════════════════════════════════════════════════════

const changePassword = async (req, res) => {
    try {
        const employeeId = req.user.id;
        const { current_password, new_password, confirm_password } = req.body;

        console.log(`🔐 [EMPLOYEE_PROFILE] Changing password for employee ID: ${employeeId}`);

        // ─────────────────────────────────────────────────────────────────
        // VALIDATION
        // ─────────────────────────────────────────────────────────────────

        if (!current_password || !new_password || !confirm_password) {
            return res.status(400).json({
                success: false,
                message: 'All password fields are required',
            });
        }

        if (new_password !== confirm_password) {
            return res.status(400).json({
                success: false,
                message: 'New password and confirmation do not match',
            });
        }

        // Password strength validation
        if (new_password.length < 8) {
            return res.status(400).json({
                success: false,
                message: 'Password must be at least 8 characters long',
            });
        }

        const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#])[A-Za-z\d@$!%*?&#]/;
        if (!passwordRegex.test(new_password)) {
            return res.status(400).json({
                success: false,
                message: 'Password must contain uppercase, lowercase, number, and special character',
            });
        }

        // ─────────────────────────────────────────────────────────────────
        // FETCH EMPLOYEE
        // ─────────────────────────────────────────────────────────────────

        const employee = await Employee.findByPk(employeeId);

        if (!employee) {
            return res.status(404).json({
                success: false,
                message: 'Employee not found',
            });
        }

        // ─────────────────────────────────────────────────────────────────
        // VERIFY CURRENT PASSWORD
        // ─────────────────────────────────────────────────────────────────

        const isPasswordValid = await bcrypt.compare(current_password, employee.password);

        if (!isPasswordValid) {
            console.log(`❌ [EMPLOYEE_PROFILE] Invalid current password`);
            return res.status(401).json({
                success: false,
                message: 'Current password is incorrect',
            });
        }

        // ─────────────────────────────────────────────────────────────────
        // HASH NEW PASSWORD
        // ─────────────────────────────────────────────────────────────────

        const hashedPassword = await bcrypt.hash(new_password, 10);

        // ─────────────────────────────────────────────────────────────────
        // UPDATE PASSWORD
        // ─────────────────────────────────────────────────────────────────

        await employee.update({
            password: hashedPassword,
        });

        console.log(`✅ [EMPLOYEE_PROFILE] Password changed successfully`);

        // TODO: Send email notification about password change
        // TODO: Log this security event

        res.status(200).json({
            success: true,
            message: 'Password changed successfully',
        });

    } catch (error) {
        console.error('❌ [EMPLOYEE_PROFILE] Error in changePassword:', error);
        console.error('Stack trace:', error.stack);

        res.status(500).json({
            success: false,
            message: 'Unable to change password. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════

module.exports = {
    getProfile,
    updateProfile,
    updateProfilePhoto,
    changePassword,
};