// backend/src/controllers/public/promotionsController.js

const Coupon = require('../../models/Coupon');
const { Op } = require('sequelize');
const {CouponUsage, Trip} = require("../../models");
const couponService = require('../../services/couponService');

// Coupons on rides are capped at the commission so WeGo never pays the driver.
const RIDE_COMMISSION_RATE = parseFloat(process.env.COMMISSION_RATE || '0.15');

/**
 * 🎁 GET ACTIVE PROMOTIONS FOR MOBILE USERS
 *
 * Endpoint: GET /api/promotions/active
 * Access: Public (no auth required) OR Authenticated (personalized)
 *
 * Returns active, valid coupons that users can apply to their rides
 */
exports.getActivePromotions = async (req, res) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🎁 [PROMOTIONS] Fetching active promotions...');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        const { limit = 10, applicable_to } = req.query;
        const now = new Date();

        // Build where clause for active, valid coupons
        const where = {
            is_active: true,
            valid_from: { [Op.lte]: now },
            valid_until: { [Op.gte]: now },
            // Only show coupons that haven't reached usage limit
            [Op.or]: [
                { usage_limit_total: null },
                {
                    used_count: {
                        [Op.lt]: Coupon.sequelize.col('usage_limit_total')
                    }
                }
            ]
        };

        // Filter by applicable_to if provided
        if (applicable_to) {
            where.applicable_to = { [Op.in]: [applicable_to, 'all'] };
        }

        const promotions = await Coupon.findAll({
            where,
            limit: parseInt(limit),
            order: [
                ['discount_value', 'DESC'], // Best discounts first
                ['valid_until', 'ASC']      // Expiring soon
            ],
            attributes: [
                'id',
                'code',
                'description',
                'discount_type',
                'discount_value',
                'max_discount_amount',
                'min_trip_amount',
                'usage_limit_per_user',
                'valid_until',
                'applicable_to'
            ]
        });

        console.log(`✅ [PROMOTIONS] Found ${promotions.length} active promotions`);

        // Transform for mobile display
        const promotionsFormatted = promotions.map(promo => {
            const promoData = promo.toJSON();

            // Generate display text
            let displayText = '';
            if (promoData.discount_type === 'PERCENTAGE') {
                displayText = `Get ${promoData.discount_value}% off`;
                if (promoData.max_discount_amount) {
                    displayText += ` (up to ${promoData.max_discount_amount} FCFA)`;
                }
            } else if (promoData.discount_type === 'FIXED_AMOUNT') {
                displayText = `Get ${promoData.discount_value} FCFA off`;
            } else if (promoData.discount_type === 'FREE_DELIVERY') {
                displayText = 'Free delivery on this ride';
            }

            // Calculate days until expiry
            const daysUntilExpiry = Math.ceil(
                (new Date(promoData.valid_until) - now) / (1000 * 60 * 60 * 24)
            );

            // Assign color based on discount value (for UI)
            let color = '#FFB800'; // Gold default
            if (promoData.discount_type === 'PERCENTAGE') {
                if (promoData.discount_value >= 30) {
                    color = '#EF4444'; // Red for high discounts
                } else if (promoData.discount_value >= 20) {
                    color = '#F59E0B'; // Orange
                }
            }

            return {
                ...promoData,
                display_text: displayText,
                days_until_expiry: daysUntilExpiry,
                color: color,
                is_expiring_soon: daysUntilExpiry <= 3,
                // Add placeholder image (you can customize per promo later)
                image_url: 'https://images.unsplash.com/photo-1607083206869-4c7672e72a8a?w=800'
            };
        });

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(200).json({
            success: true,
            message: 'Active promotions retrieved successfully',
            data: {
                promotions: promotionsFormatted,
                count: promotionsFormatted.length
            }
        });

    } catch (error) {
        console.error('❌ [PROMOTIONS] Error fetching promotions:', error);

        res.status(500).json({
            success: false,
            message: 'Failed to retrieve promotions',
            error: error.message
        });
    }
};


/**
 * ✅ VALIDATE COUPON CODE
 *
 * Endpoint: POST /api/promotions/validate
 * Access: Authenticated users only
 * Body: { code: "WEGO-SUMMER2024", trip_amount: 10000 }
 *
 * Returns whether coupon is valid and calculates discount
 */
exports.validateCoupon = async (req, res) => {
    try {
        // Mobile sends { code, fare_estimate }. Accept trip_amount too for safety.
        const { code, fare_estimate, trip_amount } = req.body;
        const userId = req.user?.uuid;
        const gross  = Math.round(parseFloat(fare_estimate ?? trip_amount ?? 0));

        if (!code) {
            return res.status(400).json({ success: false, message: 'Coupon code is required' });
        }
        if (!gross || gross <= 0) {
            return res.status(400).json({ success: false, message: 'Valid fare amount is required' });
        }

        // Single source of truth — same evaluation + commission cap as booking,
        // so the previewed discount is exactly what gets applied at trip creation.
        const commissionCap = Math.floor(gross * RIDE_COMMISSION_RATE);
        const result = await couponService.evaluate({
            code, userUuid: userId, grossAmount: gross, maxDiscount: commissionCap,
        });

        if (!result.ok) {
            return res.status(400).json({ success: false, message: result.message, code: 'COUPON_INVALID' });
        }

        const finalFare = Math.max(0, gross - result.discount);
        return res.status(200).json({
            success: true,
            message: 'Coupon is valid',
            data: {
                code:            result.coupon.code,
                discount_amount: result.discount,
                final_fare:      finalFare,
                discount_label:  result.coupon.description || result.coupon.code,
                original_amount: gross,
            },
        });

    } catch (error) {
        console.error('❌ [PROMOTIONS] Error validating coupon:', error);
        return res.status(500).json({ success: false, message: 'Failed to validate coupon', error: error.message });
    }
};




/**
 * 🎟️ GET COUPON DETAILS BY CODE
 *
 * Endpoint: GET /api/promotions/:code
 * Access: Public
 *
 * Returns detailed information about a specific coupon
 */
exports.getCouponByCode = async (req, res) => {
    try {
        const { code } = req.params;

        console.log(`\n🔍 [PROMOTIONS] Fetching coupon details: ${code}`);

        const coupon = await Coupon.findOne({
            where: {
                code: code.toUpperCase(),
                is_active: true
            },
            attributes: [
                'id',
                'code',
                'description',
                'discount_type',
                'discount_value',
                'max_discount_amount',
                'min_trip_amount',
                'usage_limit_per_user',
                'valid_from',
                'valid_until',
                'applicable_to'
            ]
        });

        if (!coupon) {
            console.log('❌ Coupon not found or inactive');
            return res.status(404).json({
                success: false,
                message: 'Coupon not found',
                code: 'COUPON_NOT_FOUND'
            });
        }

        // Check if currently valid
        const isCurrentlyValid = coupon.isValid();
        const now = new Date();
        const daysUntilExpiry = Math.ceil(
            (new Date(coupon.valid_until) - now) / (1000 * 60 * 60 * 24)
        );

        console.log(`✅ [PROMOTIONS] Coupon found: ${coupon.code}`);

        res.status(200).json({
            success: true,
            message: 'Coupon details retrieved successfully',
            data: {
                ...coupon.toJSON(),
                is_valid: isCurrentlyValid,
                days_until_expiry: daysUntilExpiry,
                is_expiring_soon: daysUntilExpiry <= 3 && daysUntilExpiry > 0
            }
        });

    } catch (error) {
        console.error('❌ [PROMOTIONS] Error fetching coupon:', error);

        res.status(500).json({
            success: false,
            message: 'Failed to retrieve coupon details',
            error: error.message
        });
    }
};