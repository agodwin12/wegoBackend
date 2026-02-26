// backend/src/controllers/servicesMarketplace.ratings.controller.js
// FIXED - Made listing_id optional and accepts from both query and path params

const { ServiceRating, ServiceRequest, ServiceListing, Account } = require('../models');
const { uploadFileToR2 } = require('../middleware/upload');
const { Op } = require('sequelize');

// ═══════════════════════════════════════════════════════════════════════
// CREATE RATING (Customer rates provider after service completion)
// POST /api/services/ratings
// ═══════════════════════════════════════════════════════════════════════

exports.createRating = async (req, res) => {
    try {
        const {
            request_id,
            rating,
            quality_rating,
            professionalism_rating,
            communication_rating,
            value_rating,
            review_text,
        } = req.body;

        const customer_id = req.user.uuid;

        // ─────────────────────────────────────────────────────────────────
        // VALIDATION
        // ─────────────────────────────────────────────────────────────────

        if (!request_id || isNaN(request_id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid request ID. Please provide a valid service request.',
            });
        }

        if (!rating || rating < 1 || rating > 5) {
            return res.status(400).json({
                success: false,
                message: 'Overall rating is required and must be between 1 and 5 stars.',
            });
        }

        // Validate specific ratings if provided
        const specificRatings = [quality_rating, professionalism_rating, communication_rating, value_rating];
        for (const specificRating of specificRatings) {
            if (specificRating !== undefined && (specificRating < 1 || specificRating > 5)) {
                return res.status(400).json({
                    success: false,
                    message: 'All specific ratings must be between 1 and 5 stars.',
                });
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // CHECK SERVICE REQUEST
        // ─────────────────────────────────────────────────────────────────

        const request = await ServiceRequest.findOne({
            where: {
                id: request_id,
                customer_id,
            },
            include: [
                {
                    model: ServiceListing,
                    as: 'listing',
                }
            ]
        });

        if (!request) {
            return res.status(404).json({
                success: false,
                message: 'Service request not found or you do not have permission to rate it.',
            });
        }

        if (request.status !== 'completed' && request.status !== 'payment_confirmed') {
            return res.status(400).json({
                success: false,
                message: 'You can only rate completed services.',
            });
        }

        // ─────────────────────────────────────────────────────────────────
        // CHECK IF ALREADY RATED
        // ─────────────────────────────────────────────────────────────────

        const existingRating = await ServiceRating.findOne({
            where: { request_id }
        });

        if (existingRating) {
            return res.status(409).json({
                success: false,
                message: 'You have already rated this service. Ratings cannot be edited once submitted.',
            });
        }

        // ─────────────────────────────────────────────────────────────────
        // HANDLE REVIEW PHOTOS (max 3)
        // ─────────────────────────────────────────────────────────────────

        let review_photos = [];
        if (req.files && req.files.length > 0) {
            if (req.files.length > 3) {
                return res.status(400).json({
                    success: false,
                    message: 'Too many photos. Maximum 3 photos allowed per review.',
                });
            }

            try {
                for (const file of req.files) {
                    const photoUrl = await uploadFileToR2(file, 'service-ratings');
                    review_photos.push(photoUrl);
                }
            } catch (uploadError) {
                console.error('❌ [SERVICE_RATING_CONTROLLER] Photo upload failed:', uploadError);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to upload review photos. Please try again.',
                });
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // CREATE RATING
        // ─────────────────────────────────────────────────────────────────

        const newRating = await ServiceRating.create({
            request_id,
            provider_id: request.provider_id,
            customer_id,
            listing_id: request.listing_id,
            rating,
            quality_rating: quality_rating || null,
            professionalism_rating: professionalism_rating || null,
            communication_rating: communication_rating || null,
            value_rating: value_rating || null,
            review_text: review_text ? review_text.trim() : null,
            review_photos: review_photos.length > 0 ? review_photos : null,
            is_verified: true,
        });

        // ─────────────────────────────────────────────────────────────────
        // UPDATE LISTING STATISTICS
        // ─────────────────────────────────────────────────────────────────

        const listing = await ServiceListing.findByPk(request.listing_id);
        if (listing) {
            // Calculate new average rating
            const allRatings = await ServiceRating.findAll({
                where: { listing_id: request.listing_id },
                attributes: ['rating'],
            });

            const totalRating = allRatings.reduce((sum, r) => sum + r.rating, 0);
            const averageRating = (totalRating / allRatings.length).toFixed(2);

            await listing.update({
                average_rating: averageRating,
                total_reviews: allRatings.length,
            });
        }

        console.log('✅ [SERVICE_RATING_CONTROLLER] Rating created for request:', request.id);

        res.status(201).json({
            success: true,
            message: 'Rating submitted successfully. Thank you for your feedback!',
            data: {
                id: newRating.id,
                rating: newRating.rating,
                request_id: newRating.request_id,
                created_at: newRating.created_at,
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_RATING_CONTROLLER] Error in createRating:', error);

        if (error.name === 'SequelizeUniqueConstraintError') {
            return res.status(409).json({
                success: false,
                message: 'You have already rated this service.',
            });
        }

        if (error.name === 'SequelizeValidationError') {
            return res.status(400).json({
                success: false,
                message: 'Validation error. Please check your input and try again.',
                errors: error.errors.map(e => e.message),
            });
        }

        res.status(500).json({
            success: false,
            message: 'Unable to submit rating. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET RATINGS FOR LISTING (Public - with pagination)
// GET /api/services/moderation/:listingId/ratings (path param)
// GET /api/services/ratings?listing_id=X (query param) - ALSO SUPPORTED NOW!
// ═══════════════════════════════════════════════════════════════════════

exports.getRatingsForListing = async (req, res) => {
    try {
        // ✅ FIXED: Accept listing ID from BOTH path params AND query params
        const listingId = req.params.listingId || req.query.listing_id;

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const offset = (page - 1) * limit;
        const { min_rating } = req.query;

        // ✅ FIXED: Only validate if listing_id is provided (now optional)
        if (listingId && isNaN(listingId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid listing ID. Please provide a valid numeric ID.',
            });
        }

        // ✅ FIXED: Build where clause conditionally
        const where = {
            is_verified: true,
        };

        // Only filter by listing_id if provided
        if (listingId) {
            where.listing_id = parseInt(listingId);
        }

        if (min_rating) {
            where.rating = { [Op.gte]: parseInt(min_rating) };
        }

        const { count, rows: ratings } = await ServiceRating.findAndCountAll({
            where,
            include: [
                {
                    model: Account,
                    as: 'customer',
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164'],
                },
            ],
            limit,
            offset,
            order: [['created_at', 'DESC']],
        });

        const totalPages = Math.ceil(count / limit);

        // ✅ FIXED: Only calculate distribution if listingId is provided
        let distribution = null;
        if (listingId) {
            const ratingDistribution = await ServiceRating.findAll({
                where: { listing_id: parseInt(listingId), is_verified: true },
                attributes: [
                    'rating',
                    [require('sequelize').fn('COUNT', 'rating'), 'count']
                ],
                group: ['rating'],
                raw: true,
            });

            distribution = {
                5: 0, 4: 0, 3: 0, 2: 0, 1: 0
            };
            ratingDistribution.forEach(item => {
                distribution[item.rating] = parseInt(item.count);
            });
        }

        res.status(200).json({
            success: true,
            message: 'Ratings retrieved successfully',
            data: ratings,
            statistics: {
                total_reviews: count,
                ...(distribution && { rating_distribution: distribution }),
            },
            pagination: {
                total: count,
                page,
                limit,
                totalPages,
                hasNext: page < totalPages,
                hasPrev: page > 1,
            }
        });

    } catch (error) {
        console.error('❌ [SERVICE_RATING_CONTROLLER] Error in getRatingsForListing:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve ratings. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET RATINGS FOR PROVIDER (Provider's all ratings - with pagination)
// GET /api/services/ratings/provider/:providerId
// GET /api/services/ratings?provider_id=X (query param) - ALSO SUPPORTED!
// ═══════════════════════════════════════════════════════════════════════

exports.getRatingsForProvider = async (req, res) => {
    try {
        // ✅ FIXED: Accept provider ID from BOTH path params AND query params
        const providerId = req.params.providerId || req.query.provider_id;

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;

        // ✅ FIXED: Only validate if provider_id is provided (now optional)
        if (providerId && (typeof providerId !== 'string' || providerId.trim() === '')) {
            return res.status(400).json({
                success: false,
                message: 'Invalid provider ID.',
            });
        }

        // ✅ FIXED: Build where clause conditionally
        const where = {
            is_verified: true,
        };

        // Only filter by provider_id if provided
        if (providerId) {
            where.provider_id = providerId;
        }

        const { count, rows: ratings } = await ServiceRating.findAndCountAll({
            where,
            include: [
                {
                    model: Account,
                    as: 'customer',
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164'],
                },
                {
                    model: ServiceListing,
                    as: 'listing',
                    attributes: ['id', 'listing_id', 'title'],
                },
            ],
            limit,
            offset,
            order: [['created_at', 'DESC']],
        });

        const totalPages = Math.ceil(count / limit);

        // ✅ FIXED: Only calculate average if provider_id is provided
        let avgRating = 0;
        if (providerId) {
            const avgResult = await ServiceRating.findOne({
                where: { provider_id: providerId, is_verified: true },
                attributes: [
                    [require('sequelize').fn('AVG', require('sequelize').col('rating')), 'average_rating']
                ],
                raw: true,
            });
            avgRating = avgResult ? parseFloat(avgResult.average_rating).toFixed(2) : 0;
        }

        res.status(200).json({
            success: true,
            message: 'Provider ratings retrieved successfully',
            data: ratings,
            statistics: {
                total_reviews: count,
                average_rating: avgRating,
            },
            pagination: {
                total: count,
                page,
                limit,
                totalPages,
                hasNext: page < totalPages,
                hasPrev: page > 1,
            }
        });

    } catch (error) {
        console.error('❌ [SERVICE_RATING_CONTROLLER] Error in getRatingsForProvider:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve provider ratings. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET RATING BY ID
// GET /api/services/ratings/:id
// ═══════════════════════════════════════════════════════════════════════

exports.getRatingById = async (req, res) => {
    try {
        const { id } = req.params;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid rating ID. Please provide a valid numeric ID.',
            });
        }

        const rating = await ServiceRating.findByPk(id, {
            include: [
                {
                    model: Account,
                    as: 'customer',
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164'],
                },
                {
                    model: Account,
                    as: 'provider',
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164'],
                },
                {
                    model: ServiceListing,
                    as: 'listing',
                    attributes: ['id', 'listing_id', 'title'],
                },
                {
                    model: ServiceRequest,
                    as: 'request',
                    attributes: ['id', 'request_id', 'service_location', 'completed_at'],
                },
            ],
        });

        if (!rating) {
            return res.status(404).json({
                success: false,
                message: 'Rating not found.',
            });
        }

        res.status(200).json({
            success: true,
            message: 'Rating retrieved successfully',
            data: rating,
        });

    } catch (error) {
        console.error('❌ [SERVICE_RATING_CONTROLLER] Error in getRatingById:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve rating. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// ADD PROVIDER RESPONSE (Provider responds to a review)
// POST /api/services/ratings/:id/respond
// ═══════════════════════════════════════════════════════════════════════

exports.addProviderResponse = async (req, res) => {
    try {
        const { id } = req.params;
        const { provider_response } = req.body;
        const provider_id = req.user.uuid;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid rating ID. Please provide a valid numeric ID.',
            });
        }

        if (!provider_response || provider_response.trim().length < 3) {
            return res.status(400).json({
                success: false,
                message: 'Response is required and must be at least 3 characters long.',
            });
        }

        if (provider_response.length > 500) {
            return res.status(400).json({
                success: false,
                message: 'Response is too long. Maximum 500 characters allowed.',
            });
        }

        const rating = await ServiceRating.findOne({
            where: { id, provider_id }
        });

        if (!rating) {
            return res.status(404).json({
                success: false,
                message: 'Rating not found or you do not have permission to respond.',
            });
        }

        if (rating.provider_response) {
            return res.status(400).json({
                success: false,
                message: 'You have already responded to this review.',
            });
        }

        // Add response
        await rating.update({
            provider_response: provider_response.trim(),
            provider_responded_at: new Date(),
        });

        console.log('✅ [SERVICE_RATING_CONTROLLER] Provider responded to rating:', id);

        res.status(200).json({
            success: true,
            message: 'Response added successfully.',
            data: {
                id: rating.id,
                provider_response: rating.provider_response,
                provider_responded_at: rating.provider_responded_at,
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_RATING_CONTROLLER] Error in addProviderResponse:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to add response. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// FLAG RATING (Report inappropriate review)
// POST /api/services/ratings/:id/flag
// ═══════════════════════════════════════════════════════════════════════

exports.flagRating = async (req, res) => {
    try {
        const { id } = req.params;
        const { flagged_reason } = req.body;
        const user_id = req.user.uuid;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid rating ID. Please provide a valid numeric ID.',
            });
        }

        if (!flagged_reason || flagged_reason.trim().length < 3) {
            return res.status(400).json({
                success: false,
                message: 'Reason for flagging is required and must be at least 3 characters long.',
            });
        }

        const rating = await ServiceRating.findByPk(id);

        if (!rating) {
            return res.status(404).json({
                success: false,
                message: 'Rating not found.',
            });
        }

        if (rating.is_flagged) {
            return res.status(400).json({
                success: false,
                message: 'This review has already been flagged for moderation.',
            });
        }

        // Flag rating
        await rating.update({
            is_flagged: true,
            flagged_reason: flagged_reason.trim(),
        });

        console.log('✅ [SERVICE_RATING_CONTROLLER] Rating flagged:', id, 'by user:', user_id);

        res.status(200).json({
            success: true,
            message: 'Review flagged successfully. Our team will review it shortly.',
        });

    } catch (error) {
        console.error('❌ [SERVICE_RATING_CONTROLLER] Error in flagRating:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to flag review. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// INCREMENT HELPFUL COUNT (Mark review as helpful)
// POST /api/services/ratings/:id/helpful
// ═══════════════════════════════════════════════════════════════════════

exports.markAsHelpful = async (req, res) => {
    try {
        const { id } = req.params;

        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid rating ID. Please provide a valid numeric ID.',
            });
        }

        const rating = await ServiceRating.findByPk(id);

        if (!rating) {
            return res.status(404).json({
                success: false,
                message: 'Rating not found.',
            });
        }

        // Increment helpful count
        await rating.increment('helpful_count');

        res.status(200).json({
            success: true,
            message: 'Marked as helpful',
            data: {
                id: rating.id,
                helpful_count: rating.helpful_count + 1,
            },
        });

    } catch (error) {
        console.error('❌ [SERVICE_RATING_CONTROLLER] Error in markAsHelpful:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to mark as helpful. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET MY RATINGS (Customer's submitted ratings - with pagination)
// GET /api/services/ratings/my-ratings
// ═══════════════════════════════════════════════════════════════════════

exports.getMyRatings = async (req, res) => {
    try {
        const customer_id = req.user.uuid;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;

        const { count, rows: ratings } = await ServiceRating.findAndCountAll({
            where: { customer_id },
            include: [
                {
                    model: ServiceListing,
                    as: 'listing',
                    attributes: ['id', 'listing_id', 'title'],
                },
                {
                    model: Account,
                    as: 'provider',
                    attributes: ['uuid', 'first_name', 'last_name', 'phone_e164'],
                },
            ],
            limit,
            offset,
            order: [['created_at', 'DESC']],
        });

        const totalPages = Math.ceil(count / limit);

        res.status(200).json({
            success: true,
            message: 'Your ratings retrieved successfully',
            data: ratings,
            pagination: {
                total: count,
                page,
                limit,
                totalPages,
                hasNext: page < totalPages,
                hasPrev: page > 1,
            }
        });

    } catch (error) {
        console.error('❌ [SERVICE_RATING_CONTROLLER] Error in getMyRatings:', error);
        res.status(500).json({
            success: false,
            message: 'Unable to retrieve your ratings. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

module.exports = exports;