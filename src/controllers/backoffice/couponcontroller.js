const Coupon = require('../../models/Coupon');
const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize');

// Generate random coupon code
const generateCouponCode = (length = 8) => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = 'WEGO-';
    for (let i = 0; i < length; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
};

// Get all coupons with pagination and filters
exports.getAllCoupons = async (req, res) => {
    try {
        const {
            page = 1,
            limit = 10,
            code,
            status,
            discount_type,
            is_active,
            sort = 'createdAt',
            order = 'DESC'
        } = req.query;

        const offset = (page - 1) * limit;

        // Build where clause
        const where = {};
        if (code) {
            where.code = { [Op.like]: `%${code.toUpperCase()}%` };
        }
        if (discount_type) {
            where.discount_type = discount_type;
        }
        if (is_active !== undefined) {
            where.is_active = is_active === 'true';
        }

        // Filter by validity status
        if (status === 'active') {
            const now = new Date();
            where.is_active = true;
            where.valid_from = { [Op.lte]: now };
            where.valid_until = { [Op.gte]: now };
        } else if (status === 'expired') {
            const now = new Date();
            where.valid_until = { [Op.lt]: now };
        } else if (status === 'upcoming') {
            const now = new Date();
            where.valid_from = { [Op.gt]: now };
        }

        const { count, rows: coupons } = await Coupon.findAndCountAll({
            where,
            limit: parseInt(limit),
            offset: parseInt(offset),
            order: [[sort, order]],
            include: [
                {
                    association: 'creator', // Use association instead of model
                    attributes: ['id', 'first_name', 'last_name', 'email']
                }
            ]
        });

        // Add computed fields
        const couponsWithStatus = coupons.map(coupon => {
            const couponData = coupon.toJSON();
            couponData.is_valid = coupon.isValid();
            couponData.usage_percentage = couponData.usage_limit_total
                ? Math.round((couponData.used_count / couponData.usage_limit_total) * 100)
                : null;
            return couponData;
        });

        res.status(200).json({
            success: true,
            message: 'Coupons retrieved successfully',
            data: {
                coupons: couponsWithStatus,
                pagination: {
                    total: count,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    totalPages: Math.ceil(count / limit)
                }
            }
        });
    } catch (error) {
        console.error('❌ Error fetching coupons:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve coupons',
            error: error.message
        });
    }
};

// Get single coupon by ID
exports.getCouponById = async (req, res) => {
    try {
        const { id } = req.params;

        const coupon = await Coupon.findByPk(id, {
            include: [
                {
                    association: 'creator',
                    attributes: ['id', 'first_name', 'last_name', 'email']
                }
            ]
        });

        if (!coupon) {
            return res.status(404).json({
                success: false,
                message: 'Coupon not found'
            });
        }

        const couponData = coupon.toJSON();
        couponData.is_valid = coupon.isValid();
        couponData.usage_percentage = couponData.usage_limit_total
            ? Math.round((couponData.used_count / couponData.usage_limit_total) * 100)
            : null;

        res.status(200).json({
            success: true,
            message: 'Coupon retrieved successfully',
            data: couponData
        });
    } catch (error) {
        console.error('❌ Error fetching coupon:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve coupon',
            error: error.message
        });
    }
};

// Create new coupon
exports.createCoupon = async (req, res) => {
    try {
        const {
            code,
            description,
            discount_type,
            discount_value,
            max_discount_amount,
            min_trip_amount,
            usage_limit_total,
            usage_limit_per_user,
            valid_from,
            valid_until,
            applicable_to,
            is_active = true,
            auto_generate_code = false
        } = req.body;

        const employeeId = req.user.id;

        // Validate required fields
        if (!discount_type || !discount_value || !valid_from || !valid_until) {
            return res.status(400).json({
                success: false,
                message: 'discount_type, discount_value, valid_from, and valid_until are required'
            });
        }

        // Generate or validate code
        let couponCode = code;
        if (auto_generate_code || !code) {
            couponCode = generateCouponCode();

            // Ensure uniqueness
            let isUnique = false;
            while (!isUnique) {
                const existing = await Coupon.findOne({ where: { code: couponCode } });
                if (!existing) {
                    isUnique = true;
                } else {
                    couponCode = generateCouponCode();
                }
            }
        } else {
            // Check if code already exists
            const existingCoupon = await Coupon.findOne({
                where: { code: couponCode.toUpperCase() }
            });

            if (existingCoupon) {
                return res.status(400).json({
                    success: false,
                    message: `Coupon code '${couponCode}' already exists`
                });
            }
        }

        // Validate dates
        const fromDate = new Date(valid_from);
        const untilDate = new Date(valid_until);

        if (untilDate <= fromDate) {
            return res.status(400).json({
                success: false,
                message: 'valid_until must be after valid_from'
            });
        }

        const coupon = await Coupon.create({
            id: uuidv4(),
            code: couponCode,
            description,
            discount_type,
            discount_value,
            max_discount_amount: max_discount_amount || null,
            min_trip_amount: min_trip_amount || 0,
            usage_limit_total: usage_limit_total || null,
            usage_limit_per_user: usage_limit_per_user || 1,
            valid_from: fromDate,
            valid_until: untilDate,
            applicable_to: applicable_to || 'all',
            is_active,
            created_by: employeeId
        });

        // Fetch the created coupon with associations
        const createdCoupon = await Coupon.findByPk(coupon.id, {
            include: [
                {
                    association: 'creator',
                    attributes: ['id', 'first_name', 'last_name', 'email']
                }
            ]
        });

        console.log('✅ Coupon created:', coupon.code);

        res.status(201).json({
            success: true,
            message: 'Coupon created successfully',
            data: createdCoupon
        });
    } catch (error) {
        console.error('❌ Error creating coupon:', error);

        if (error.name === 'SequelizeValidationError') {
            return res.status(400).json({
                success: false,
                message: 'Validation error',
                errors: error.errors.map(e => ({
                    field: e.path,
                    message: e.message
                }))
            });
        }

        res.status(500).json({
            success: false,
            message: 'Failed to create coupon',
            error: error.message
        });
    }
};

// Update coupon
exports.updateCoupon = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            code,
            description,
            discount_type,
            discount_value,
            max_discount_amount,
            min_trip_amount,
            usage_limit_total,
            usage_limit_per_user,
            valid_from,
            valid_until,
            applicable_to,
            is_active
        } = req.body;

        const coupon = await Coupon.findByPk(id);

        if (!coupon) {
            return res.status(404).json({
                success: false,
                message: 'Coupon not found'
            });
        }

        // Check if coupon has been used - prevent certain changes
        if (coupon.used_count > 0) {
            // Don't allow changing discount type or value if already used
            if ((discount_type && discount_type !== coupon.discount_type) ||
                (discount_value && discount_value !== coupon.discount_value)) {
                return res.status(400).json({
                    success: false,
                    message: 'Cannot change discount type or value for a coupon that has already been used'
                });
            }
        }

        // If changing code, check uniqueness
        if (code && code.toUpperCase() !== coupon.code) {
            const existingCoupon = await Coupon.findOne({
                where: {
                    code: code.toUpperCase(),
                    id: { [Op.ne]: id }
                }
            });

            if (existingCoupon) {
                return res.status(400).json({
                    success: false,
                    message: `Coupon code '${code}' already exists`
                });
            }
            coupon.code = code;
        }

        // Update fields
        if (description !== undefined) coupon.description = description;
        if (discount_type !== undefined) coupon.discount_type = discount_type;
        if (discount_value !== undefined) coupon.discount_value = discount_value;
        if (max_discount_amount !== undefined) coupon.max_discount_amount = max_discount_amount;
        if (min_trip_amount !== undefined) coupon.min_trip_amount = min_trip_amount;
        if (usage_limit_total !== undefined) coupon.usage_limit_total = usage_limit_total;
        if (usage_limit_per_user !== undefined) coupon.usage_limit_per_user = usage_limit_per_user;
        if (valid_from !== undefined) coupon.valid_from = new Date(valid_from);
        if (valid_until !== undefined) coupon.valid_until = new Date(valid_until);
        if (applicable_to !== undefined) coupon.applicable_to = applicable_to;
        if (is_active !== undefined) coupon.is_active = is_active;

        await coupon.save();

        // Fetch updated coupon with associations
        const updatedCoupon = await Coupon.findByPk(id, {
            include: [
                {
                    association: 'creator',
                    attributes: ['id', 'first_name', 'last_name', 'email']
                }
            ]
        });

        console.log('✅ Coupon updated:', coupon.code);

        res.status(200).json({
            success: true,
            message: 'Coupon updated successfully',
            data: updatedCoupon
        });
    } catch (error) {
        console.error('❌ Error updating coupon:', error);

        if (error.name === 'SequelizeValidationError') {
            return res.status(400).json({
                success: false,
                message: 'Validation error',
                errors: error.errors.map(e => ({
                    field: e.path,
                    message: e.message
                }))
            });
        }

        res.status(500).json({
            success: false,
            message: 'Failed to update coupon',
            error: error.message
        });
    }
};

// Delete coupon
exports.deleteCoupon = async (req, res) => {
    try {
        const { id } = req.params;

        const coupon = await Coupon.findByPk(id);

        if (!coupon) {
            return res.status(404).json({
                success: false,
                message: 'Coupon not found'
            });
        }

        // Prevent deletion if coupon has been used
        if (coupon.used_count > 0) {
            return res.status(400).json({
                success: false,
                message: 'Cannot delete a coupon that has already been used. Consider deactivating it instead.'
            });
        }

        await coupon.destroy();

        console.log('✅ Coupon deleted:', coupon.code);

        res.status(200).json({
            success: true,
            message: 'Coupon deleted successfully'
        });
    } catch (error) {
        console.error('❌ Error deleting coupon:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete coupon',
            error: error.message
        });
    }
};

// Toggle coupon active status
exports.toggleCouponStatus = async (req, res) => {
    try {
        const { id } = req.params;

        const coupon = await Coupon.findByPk(id);

        if (!coupon) {
            return res.status(404).json({
                success: false,
                message: 'Coupon not found'
            });
        }

        coupon.is_active = !coupon.is_active;
        await coupon.save();

        console.log(`✅ Coupon status toggled to ${coupon.is_active ? 'active' : 'inactive'}:`, coupon.code);

        res.status(200).json({
            success: true,
            message: `Coupon ${coupon.is_active ? 'activated' : 'deactivated'} successfully`,
            data: coupon
        });
    } catch (error) {
        console.error('❌ Error toggling coupon status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to toggle coupon status',
            error: error.message
        });
    }
};

// Get coupon usage statistics
exports.getCouponUsage = async (req, res) => {
    try {
        const { id } = req.params;
        const { page = 1, limit = 20 } = req.query;
        const offset = (page - 1) * limit;

        const coupon = await Coupon.findByPk(id);

        if (!coupon) {
            return res.status(404).json({
                success: false,
                message: 'Coupon not found'
            });
        }

        // Note: CouponUsage model needs to be created and associated
        // For now, return basic coupon info
        res.status(200).json({
            success: true,
            message: 'Coupon usage retrieved successfully',
            data: {
                coupon: {
                    code: coupon.code,
                    used_count: coupon.used_count,
                    usage_limit_total: coupon.usage_limit_total,
                    total_discount_given: 0, // Calculate from CouponUsage when available
                    unique_users: 0 // Calculate from CouponUsage when available
                },
                usages: [],
                pagination: {
                    total: 0,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    totalPages: 0
                }
            }
        });
    } catch (error) {
        console.error('❌ Error fetching coupon usage:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve coupon usage',
            error: error.message
        });
    }
};

// Generate random coupon code (utility endpoint)
exports.generateCode = async (req, res) => {
    try {
        const { length = 8 } = req.query;

        let code = generateCouponCode(parseInt(length));

        // Ensure uniqueness
        let isUnique = false;
        let attempts = 0;
        while (!isUnique && attempts < 10) {
            const existing = await Coupon.findOne({ where: { code } });
            if (!existing) {
                isUnique = true;
            } else {
                code = generateCouponCode(parseInt(length));
                attempts++;
            }
        }

        res.status(200).json({
            success: true,
            message: 'Coupon code generated successfully',
            data: { code }
        });
    } catch (error) {
        console.error('❌ Error generating coupon code:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate coupon code',
            error: error.message
        });
    }
};