// src/controllers/rating.controller.js

const Rating = require('../models/rating.model');
const Trip = require('../models/Trip');
const Account = require('../models/Account');
const sequelize = require('../config/database');

/**
 * Submit a rating for a trip
 * POST /api/ratings
 */
exports.submitRating = async (req, res) => {
    const transaction = await sequelize.transaction();

    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('⭐ [RATING] Submitting rating');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        const { tripId, stars, comment } = req.body;
        const userId = req.user.uuid; // From auth middleware (Account UUID)

        // Validate input
        if (!tripId || !stars) {
            await transaction.rollback();
            return res.status(400).json({
                success: false,
                message: 'Trip ID and stars are required',
            });
        }

        if (stars < 1 || stars > 5) {
            await transaction.rollback();
            return res.status(400).json({
                success: false,
                message: 'Stars must be between 1 and 5',
            });
        }

        console.log(`📦 Trip ID: ${tripId}`);
        console.log(`👤 Rated by: ${userId}`);
        console.log(`⭐ Stars: ${stars}`);
        console.log(`💬 Comment: ${comment || 'None'}`);

        // Get trip details
        const trip = await Trip.findByPk(tripId, { transaction });

        if (!trip) {
            await transaction.rollback();
            return res.status(404).json({
                success: false,
                message: 'Trip not found',
            });
        }

        console.log(`🚗 Driver ID: ${trip.driverId}`);
        console.log(`👤 Passenger ID: ${trip.passengerId}`);

        // Check if trip is completed
        if (trip.status !== 'COMPLETED') {
            await transaction.rollback();
            return res.status(400).json({
                success: false,
                message: 'Can only rate completed trips',
            });
        }

        // Determine rating type and who is being rated
        let ratingType;
        let ratedUser;

        if (userId === trip.driverId) {
            // Driver rating passenger
            ratingType = 'DRIVER_TO_PASSENGER';
            ratedUser = trip.passengerId;
            console.log('📝 Rating type: DRIVER_TO_PASSENGER');
        } else if (userId === trip.passengerId) {
            // Passenger rating driver
            ratingType = 'PASSENGER_TO_DRIVER';
            ratedUser = trip.driverId;
            console.log('📝 Rating type: PASSENGER_TO_DRIVER');
        } else {
            await transaction.rollback();
            return res.status(403).json({
                success: false,
                message: 'You are not authorized to rate this trip',
            });
        }

        console.log(`🎯 Rated user: ${ratedUser}`);

        // Check if rating already exists
        const existingRating = await Rating.findOne({
            where: {
                tripId,
                ratingType,
            },
            transaction,
        });

        if (existingRating) {
            await transaction.rollback();
            return res.status(409).json({
                success: false,
                message: 'You have already rated this trip',
            });
        }

        // Create rating
        const rating = await Rating.create({
            tripId,
            ratedBy: userId,
            ratedUser,
            ratingType,
            stars,
            comment: comment || null,
        }, { transaction });

        console.log('✅ [RATING] Rating created successfully');

        // Update account's average rating
        await updateAccountAverageRating(ratedUser, ratingType, transaction);

        await transaction.commit();

        console.log('✅ [RATING] Transaction committed');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(201).json({
            success: true,
            message: 'Rating submitted successfully',
            data: {
                rating: {
                    id: rating.id,
                    stars: rating.stars,
                    comment: rating.comment,
                    ratingType: rating.ratingType,
                    createdAt: rating.createdAt,
                },
            },
        });

    } catch (error) {
        await transaction.rollback();
        console.error('❌ [RATING] Error submitting rating:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to submit rating',
            error: error.message,
        });
    }
};

/**
 * Get ratings for a specific trip
 * GET /api/ratings/trip/:tripId
 */
exports.getTripRatings = async (req, res) => {
    try {
        const { tripId } = req.params;

        console.log(`\n🔍 [RATING] Fetching ratings for trip: ${tripId}\n`);

        const ratings = await Rating.findAll({
            where: { tripId },
            include: [
                {
                    model: Account,
                    as: 'rater',
                    attributes: ['uuid', 'first_name', 'last_name', 'avatar_url'],
                },
            ],
            order: [['createdAt', 'DESC']],
        });

        console.log(`✅ [RATING] Found ${ratings.length} ratings\n`);

        res.status(200).json({
            success: true,
            data: {
                ratings: ratings.map(r => ({
                    id: r.id,
                    stars: r.stars,
                    comment: r.comment,
                    ratingType: r.ratingType,
                    ratedBy: r.ratedBy,
                    rater: r.rater ? {
                        uuid: r.rater.uuid,
                        name: `${r.rater.first_name} ${r.rater.last_name}`.trim(),
                        avatar: r.rater.avatar_url,
                    } : null,
                    createdAt: r.createdAt,
                })),
            },
        });

    } catch (error) {
        console.error('❌ [RATING] Error fetching trip ratings:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch ratings',
            error: error.message,
        });
    }
};

/**
 * Get ratings received by a user
 * GET /api/ratings/user/:userId
 */
exports.getUserRatings = async (req, res) => {
    try {
        const { userId } = req.params;
        const { type } = req.query; // 'driver' or 'passenger'

        console.log(`\n🔍 [RATING] Fetching ratings for user: ${userId}`);
        console.log(`📝 Type: ${type || 'all'}\n`);

        const whereClause = { ratedUser: userId };

        if (type === 'driver') {
            whereClause.ratingType = 'PASSENGER_TO_DRIVER';
        } else if (type === 'passenger') {
            whereClause.ratingType = 'DRIVER_TO_PASSENGER';
        }

        const ratings = await Rating.findAll({
            where: whereClause,
            include: [
                {
                    model: Account,
                    as: 'rater',
                    attributes: ['uuid', 'first_name', 'last_name', 'avatar_url'],
                },
            ],
            order: [['createdAt', 'DESC']],
            limit: 50, // Last 50 ratings
        });

        // Calculate average
        const totalStars = ratings.reduce((sum, r) => sum + r.stars, 0);
        const averageRating = ratings.length > 0
            ? (totalStars / ratings.length).toFixed(2)
            : 0;

        // Calculate star distribution
        const distribution = {
            5: ratings.filter(r => r.stars === 5).length,
            4: ratings.filter(r => r.stars === 4).length,
            3: ratings.filter(r => r.stars === 3).length,
            2: ratings.filter(r => r.stars === 2).length,
            1: ratings.filter(r => r.stars === 1).length,
        };

        console.log(`✅ [RATING] Found ${ratings.length} ratings`);
        console.log(`⭐ Average: ${averageRating}\n`);

        res.status(200).json({
            success: true,
            data: {
                ratings: ratings.map(r => ({
                    id: r.id,
                    stars: r.stars,
                    comment: r.comment,
                    ratingType: r.ratingType,
                    rater: r.rater ? {
                        uuid: r.rater.uuid,
                        name: `${r.rater.first_name} ${r.rater.last_name}`.trim(),
                        avatar: r.rater.avatar_url,
                    } : null,
                    createdAt: r.createdAt,
                })),
                summary: {
                    totalRatings: ratings.length,
                    averageRating: parseFloat(averageRating),
                    distribution,
                },
            },
        });

    } catch (error) {
        console.error('❌ [RATING] Error fetching user ratings:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch ratings',
            error: error.message,
        });
    }
};

/**
 * Check if user has rated a trip
 * GET /api/ratings/check/:tripId
 */
exports.checkTripRated = async (req, res) => {
    try {
        const { tripId } = req.params;
        const userId = req.user.uuid;

        const trip = await Trip.findByPk(tripId);

        if (!trip) {
            return res.status(404).json({
                success: false,
                message: 'Trip not found',
            });
        }

        let ratingType;
        if (userId === trip.driverId) {
            ratingType = 'DRIVER_TO_PASSENGER';
        } else if (userId === trip.passengerId) {
            ratingType = 'PASSENGER_TO_DRIVER';
        } else {
            return res.status(403).json({
                success: false,
                message: 'Unauthorized',
            });
        }

        const rating = await Rating.findOne({
            where: { tripId, ratingType },
        });

        res.status(200).json({
            success: true,
            data: {
                hasRated: !!rating,
                rating: rating ? {
                    stars: rating.stars,
                    comment: rating.comment,
                    createdAt: rating.createdAt,
                } : null,
            },
        });

    } catch (error) {
        console.error('❌ [RATING] Error checking rating:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to check rating',
            error: error.message,
        });
    }
};

/**
 * Helper: Update account's average rating
 */
async function updateAccountAverageRating(userId, ratingType, transaction) {
    try {
        console.log(`📊 [RATING] Updating average rating for account: ${userId}`);

        const ratings = await Rating.findAll({
            where: {
                ratedUser: userId,
                ratingType,
            },
            transaction,
        });

        if (ratings.length === 0) {
            console.log('⚠️ [RATING] No ratings found to calculate average');
            return;
        }

        const totalStars = ratings.reduce((sum, r) => sum + r.stars, 0);
        const averageRating = (totalStars / ratings.length).toFixed(2);

        console.log(`⭐ New average rating: ${averageRating} (${ratings.length} ratings)`);

        // TODO: You can add driverRating/passengerRating fields to Account model later
        // and update them here if needed

    } catch (error) {
        console.error('❌ [RATING] Error updating average rating:', error);
        throw error;
    }
}

module.exports = exports;