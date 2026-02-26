// src/controllers/rating.controller.js

const { Rating, Trip, Account, DriverProfile } = require('../models');
const sequelize = require('../config/database');
const { v4: uuidv4 } = require('uuid');

// ═══════════════════════════════════════════════════════════════════════
// SUBMIT RATING
// POST /api/ratings
// ═══════════════════════════════════════════════════════════════════════
exports.submitRating = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('⭐ [RATING] submitRating');

        const { tripId, stars, comment } = req.body;
        const userId = req.user.uuid;

        // ── Validation ────────────────────────────────────────────────
        if (!tripId || !stars) {
            await transaction.rollback();
            return res.status(400).json({ success: false, message: 'tripId and stars are required' });
        }
        const starsNum = parseInt(stars);
        if (isNaN(starsNum) || starsNum < 1 || starsNum > 5) {
            await transaction.rollback();
            return res.status(400).json({ success: false, message: 'stars must be an integer between 1 and 5' });
        }
        if (comment && comment.length > 500) {
            await transaction.rollback();
            return res.status(400).json({ success: false, message: 'comment must be 500 characters or fewer' });
        }

        console.log(`📦 Trip: ${tripId} | Rater: ${userId} | Stars: ${starsNum}`);

        // ── Fetch trip ────────────────────────────────────────────────
        const trip = await Trip.findByPk(tripId, { transaction });
        if (!trip) {
            await transaction.rollback();
            return res.status(404).json({ success: false, message: 'Trip not found' });
        }

        if (trip.status !== 'COMPLETED') {
            await transaction.rollback();
            return res.status(400).json({ success: false, message: 'Can only rate completed trips' });
        }

        // ── Determine direction ───────────────────────────────────────
        let ratingType, ratedUser;
        if (userId === trip.driverId) {
            ratingType = 'DRIVER_TO_PASSENGER';
            ratedUser  = trip.passengerId;
        } else if (userId === trip.passengerId) {
            ratingType = 'PASSENGER_TO_DRIVER';
            ratedUser  = trip.driverId;
        } else {
            await transaction.rollback();
            return res.status(403).json({ success: false, message: 'You are not a participant in this trip' });
        }

        if (!ratedUser) {
            await transaction.rollback();
            return res.status(400).json({ success: false, message: 'Cannot determine who to rate — trip may have no assigned driver yet' });
        }

        console.log(`📝 ${ratingType} | Rated user: ${ratedUser}`);

        // ── Prevent duplicate ratings ─────────────────────────────────
        const existing = await Rating.findOne({ where: { tripId, ratingType }, transaction });
        if (existing) {
            await transaction.rollback();
            return res.status(409).json({ success: false, message: 'You have already rated this trip' });
        }

        // ── Create rating ─────────────────────────────────────────────
        const rating = await Rating.create({
            id:         uuidv4(),
            tripId,
            ratedBy:    userId,
            ratedUser,
            ratingType,
            rating:     starsNum,   // column name is 'rating' in the model
            review:     comment || null,
        }, { transaction });

        console.log('✅ [RATING] Rating row created:', rating.id);

        // ── ✅ FIX BE Broken Feature #4: Save average to DriverProfile ─
        await updateAccountAverageRating(ratedUser, ratingType, transaction);

        await transaction.commit();
        console.log('✅ [RATING] Transaction committed');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(201).json({
            success: true,
            message: 'Rating submitted successfully',
            data: {
                rating: {
                    id:         rating.id,
                    stars:      rating.rating,
                    comment:    rating.review,
                    ratingType: rating.ratingType,
                    createdAt:  rating.createdAt,
                },
            },
        });

    } catch (error) {
        await transaction.rollback();
        console.error('❌ [RATING] submitRating error:', error);
        res.status(500).json({ success: false, message: 'Failed to submit rating', error: error.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET RATINGS FOR A TRIP
// GET /api/ratings/trip/:tripId
// ═══════════════════════════════════════════════════════════════════════
exports.getTripRatings = async (req, res) => {
    try {
        const { tripId } = req.params;
        console.log(`\n🔍 [RATING] getTripRatings — trip: ${tripId}`);

        const ratings = await Rating.findAll({
            where: { tripId },
            include: [
                {
                    model:      Account,
                    as:         'rater',
                    attributes: ['uuid', 'first_name', 'last_name', 'avatar_url'],
                    required:   false,
                },
            ],
            order: [['createdAt', 'DESC']],
        });

        console.log(`✅ [RATING] Found ${ratings.length} ratings`);

        res.status(200).json({
            success: true,
            data: {
                ratings: ratings.map(r => ({
                    id:         r.id,
                    stars:      r.rating,
                    comment:    r.review,
                    ratingType: r.ratingType,
                    ratedBy:    r.ratedBy,
                    rater: r.rater ? {
                        uuid:   r.rater.uuid,
                        name:   `${r.rater.first_name} ${r.rater.last_name}`.trim(),
                        avatar: r.rater.avatar_url,
                    } : null,
                    createdAt: r.createdAt,
                })),
            },
        });

    } catch (error) {
        console.error('❌ [RATING] getTripRatings error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch ratings', error: error.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET RATINGS RECEIVED BY A USER
// GET /api/ratings/user/:userId
// ═══════════════════════════════════════════════════════════════════════
exports.getUserRatings = async (req, res) => {
    try {
        const { userId } = req.params;
        const { type, page = 1, limit = 50 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        console.log(`\n🔍 [RATING] getUserRatings — user: ${userId} | type: ${type || 'all'}`);

        const where = { ratedUser: userId };
        if (type === 'driver')    where.ratingType = 'PASSENGER_TO_DRIVER';
        if (type === 'passenger') where.ratingType = 'DRIVER_TO_PASSENGER';

        const { count, rows: ratings } = await Rating.findAndCountAll({
            where,
            include: [
                {
                    model:      Account,
                    as:         'rater',
                    attributes: ['uuid', 'first_name', 'last_name', 'avatar_url'],
                    required:   false,
                },
            ],
            order:  [['createdAt', 'DESC']],
            limit:  parseInt(limit),
            offset,
        });

        const totalStars   = ratings.reduce((s, r) => s + r.rating, 0);
        const averageRating = count > 0 ? parseFloat((totalStars / count).toFixed(2)) : 0;

        const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        for (const r of ratings) {
            const star = Math.round(r.rating);
            if (distribution[star] !== undefined) distribution[star]++;
        }

        console.log(`✅ [RATING] ${count} ratings — avg: ${averageRating}`);

        res.status(200).json({
            success: true,
            data: {
                summary: {
                    totalRatings:  count,
                    averageRating,
                    distribution,
                },
                ratings: ratings.map(r => ({
                    id:         r.id,
                    stars:      r.rating,
                    comment:    r.review,
                    ratingType: r.ratingType,
                    rater: r.rater ? {
                        uuid:   r.rater.uuid,
                        name:   `${r.rater.first_name} ${r.rater.last_name}`.trim(),
                        avatar: r.rater.avatar_url,
                    } : null,
                    createdAt: r.createdAt,
                })),
                pagination: {
                    total:      count,
                    page:       parseInt(page),
                    limit:      parseInt(limit),
                    totalPages: Math.ceil(count / parseInt(limit)),
                },
            },
        });

    } catch (error) {
        console.error('❌ [RATING] getUserRatings error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch ratings', error: error.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// CHECK IF USER HAS RATED A TRIP
// GET /api/ratings/check/:tripId
// ═══════════════════════════════════════════════════════════════════════
exports.checkTripRated = async (req, res) => {
    try {
        const { tripId } = req.params;
        const userId = req.user.uuid;

        const trip = await Trip.findByPk(tripId);
        if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' });

        let ratingType;
        if      (userId === trip.driverId)    ratingType = 'DRIVER_TO_PASSENGER';
        else if (userId === trip.passengerId) ratingType = 'PASSENGER_TO_DRIVER';
        else return res.status(403).json({ success: false, message: 'Unauthorized' });

        const rating = await Rating.findOne({ where: { tripId, ratingType } });

        res.status(200).json({
            success: true,
            data: {
                hasRated: !!rating,
                rating: rating ? {
                    stars:     rating.rating,
                    comment:   rating.review,
                    createdAt: rating.createdAt,
                } : null,
            },
        });

    } catch (error) {
        console.error('❌ [RATING] checkTripRated error:', error);
        res.status(500).json({ success: false, message: 'Failed to check rating', error: error.message });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// HELPER: Update average rating on DriverProfile
// ✅ FIX BE Broken Feature #4: Actually saves computed average to DB.
//    Was previously calculated but never persisted
// ═══════════════════════════════════════════════════════════════════════
async function updateAccountAverageRating(userId, ratingType, transaction) {
    try {
        console.log(`📊 [RATING] updateAccountAverageRating — user: ${userId} | type: ${ratingType}`);

        // Fetch ALL ratings for this user+type (including the one just inserted,
        // which is why we do this inside the same transaction)
        const ratings = await Rating.findAll({
            where: { ratedUser: userId, ratingType },
            attributes: ['rating'],
            transaction,
        });

        if (ratings.length === 0) {
            console.log('⚠️  [RATING] No ratings found — nothing to update');
            return;
        }

        const total   = ratings.reduce((sum, r) => sum + r.rating, 0);
        const average = parseFloat((total / ratings.length).toFixed(2));
        const count   = ratings.length;

        console.log(`⭐ New average: ${average} over ${count} ratings`);

        // ── Drivers: update DriverProfile.rating_avg ──────────────────
        if (ratingType === 'PASSENGER_TO_DRIVER') {
            const [rowsUpdated] = await DriverProfile.update(
                { rating_avg: average, rating_count: count },
                { where: { account_id: userId }, transaction }
            );
            if (rowsUpdated > 0) {
                console.log(`✅ [RATING] DriverProfile.rating_avg updated → ${average} (${count} ratings)`);
            } else {
                console.warn(`⚠️  [RATING] No DriverProfile found for account_id: ${userId}`);
            }
        }

        // ── Passengers: update Account.rating_avg if column exists ─────
        // (Only runs if your Account model has a rating_avg column for passengers)
        if (ratingType === 'DRIVER_TO_PASSENGER') {
            try {
                const [rowsUpdated] = await Account.update(
                    { rating_avg: average, rating_count: count },
                    { where: { uuid: userId }, transaction }
                );
                if (rowsUpdated > 0) {
                    console.log(`✅ [RATING] Account.rating_avg (passenger) updated → ${average}`);
                }
            } catch (passengerUpdateErr) {
                // Non-fatal: Account may not have rating_avg column yet
                console.warn(`⚠️  [RATING] Could not update passenger rating_avg: ${passengerUpdateErr.message}`);
            }
        }

    } catch (error) {
        console.error('❌ [RATING] updateAccountAverageRating error:', error.message);
        throw error; // Re-throw so the parent transaction rolls back
    }
}

module.exports = exports;