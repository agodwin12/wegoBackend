// backend/src/controllers/public/statsController.js

const { Account, Trip, Rating, Payment } = require('../../models');
const { Op } = require('sequelize');
const sequelize = require('../../config/database');

/**
 * 📊 GET USER STATISTICS
 *
 * Endpoint: GET /api/users/stats
 * Access: Private (requires authentication)
 *
 * Calculates comprehensive user statistics from database:
 * - Total completed trips
 * - Average rating received
 * - Total points/rewards earned
 * - Total money spent
 * - Distance traveled
 * - CO2 saved
 * - Monthly activity
 */
exports.getUserStats = async (req, res) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📊 [STATS] Calculating user statistics...');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        const userId = req.user.uuid;
        const userType = req.user.user_type;

        console.log(`👤 User: ${userId}`);
        console.log(`🏷️  Type: ${userType}`);

        // ═══════════════════════════════════════════════════════════════
        // 1️⃣ CALCULATE TRIP STATISTICS
        // ═══════════════════════════════════════════════════════════════

        let tripStats;

        if (userType === 'PASSENGER') {
            // Passenger: trips where they were the passenger
            tripStats = await Trip.findAll({
                where: {
                    passengerId: userId,
                    status: 'COMPLETED'
                },
                attributes: [
                    [sequelize.fn('COUNT', sequelize.col('id')), 'total_trips'],
                    [sequelize.fn('SUM', sequelize.col('distance_km')), 'total_distance'],
                    [sequelize.fn('SUM', sequelize.col('duration_minutes')), 'total_duration'],
                    [sequelize.fn('AVG', sequelize.col('distance_km')), 'avg_distance'],
                    [sequelize.fn('AVG', sequelize.col('duration_minutes')), 'avg_duration']
                ],
                raw: true
            });
        } else if (userType === 'DRIVER') {
            // Driver: trips where they were the driver
            tripStats = await Trip.findAll({
                where: {
                    driverId: userId,
                    status: 'COMPLETED'
                },
                attributes: [
                    [sequelize.fn('COUNT', sequelize.col('id')), 'total_trips'],
                    [sequelize.fn('SUM', sequelize.col('distance_km')), 'total_distance'],
                    [sequelize.fn('SUM', sequelize.col('duration_minutes')), 'total_duration'],
                    [sequelize.fn('AVG', sequelize.col('distance_km')), 'avg_distance'],
                    [sequelize.fn('AVG', sequelize.col('duration_minutes')), 'avg_duration']
                ],
                raw: true
            });
        }

        const totalTrips = parseInt(tripStats[0]?.total_trips || 0);
        const totalDistance = parseFloat(tripStats[0]?.total_distance || 0);
        const totalDuration = parseInt(tripStats[0]?.total_duration || 0);
        const avgDistance = parseFloat(tripStats[0]?.avg_distance || 0);
        const avgDuration = parseInt(tripStats[0]?.avg_duration || 0);

        console.log(`✅ Trips: ${totalTrips} completed`);
        console.log(`📏 Distance: ${totalDistance.toFixed(2)} km`);

        // ═══════════════════════════════════════════════════════════════
        // 2️⃣ CALCULATE RATING STATISTICS
        // ═══════════════════════════════════════════════════════════════

        const ratingStats = await Rating.findAll({
            where: {
                ratedUser: userId
            },
            attributes: [
                [sequelize.fn('AVG', sequelize.col('rating')), 'avg_rating'],
                [sequelize.fn('COUNT', sequelize.col('id')), 'total_ratings']
            ],
            raw: true
        });

        const avgRating = parseFloat(ratingStats[0]?.avg_rating || 0);
        const totalRatings = parseInt(ratingStats[0]?.total_ratings || 0);

        console.log(`⭐ Rating: ${avgRating.toFixed(1)} (${totalRatings} reviews)`);

        // ═══════════════════════════════════════════════════════════════
        // 3️⃣ CALCULATE PAYMENT/FINANCIAL STATISTICS
        // ═══════════════════════════════════════════════════════════════

        let paymentStats;
        let totalSpent = 0;
        let totalEarned = 0;

        if (userType === 'PASSENGER') {
            // Passenger: money spent on trips
            paymentStats = await Payment.findAll({
                where: {
                    passengerId: userId,
                    status: 'COMPLETED'
                },
                attributes: [
                    [sequelize.fn('SUM', sequelize.col('amount')), 'total_amount'],
                    [sequelize.fn('COUNT', sequelize.col('id')), 'total_payments']
                ],
                raw: true
            });

            totalSpent = parseFloat(paymentStats[0]?.total_amount || 0);
            console.log(`💰 Total Spent: ${totalSpent} FCFA`);

        } else if (userType === 'DRIVER') {
            // Driver: money earned from trips
            paymentStats = await Payment.findAll({
                where: {
                    driverId: userId,
                    status: 'COMPLETED'
                },
                attributes: [
                    [sequelize.fn('SUM', sequelize.col('amount')), 'total_amount'],
                    [sequelize.fn('COUNT', sequelize.col('id')), 'total_payments']
                ],
                raw: true
            });

            totalEarned = parseFloat(paymentStats[0]?.total_amount || 0);
            console.log(`💵 Total Earned: ${totalEarned} FCFA`);
        }

        // ═══════════════════════════════════════════════════════════════
        // 4️⃣ CALCULATE REWARDS/POINTS
        // ═══════════════════════════════════════════════════════════════

        // Points calculation formula:
        // - 10 points per completed trip
        // - Bonus points for 5-star ratings (50 points)
        // - Bonus for milestone trips (100, 500, 1000)

        let points = totalTrips * 10;

        // Bonus for 5-star ratings
        const fiveStarRatings = await Rating.count({
            where: {
                ratedUser: userId,
                rating: 5
            }
        });
        points += fiveStarRatings * 50;

        // Milestone bonuses
        if (totalTrips >= 1000) points += 5000;
        else if (totalTrips >= 500) points += 2000;
        else if (totalTrips >= 100) points += 500;
        else if (totalTrips >= 50) points += 200;
        else if (totalTrips >= 10) points += 100;

        console.log(`🏆 Points: ${points}`);

        // ═══════════════════════════════════════════════════════════════
        // 5️⃣ CALCULATE ENVIRONMENTAL IMPACT (CO2 SAVINGS)
        // ═══════════════════════════════════════════════════════════════

        // Average car emits 120g CO2 per km
        // Carpooling/ride-sharing saves ~50% emissions
        const co2SavedKg = (totalDistance * 120 * 0.5) / 1000; // Convert to kg

        console.log(`🌍 CO2 Saved: ${co2SavedKg.toFixed(2)} kg`);

        // ═══════════════════════════════════════════════════════════════
        // 6️⃣ CALCULATE MONTHLY ACTIVITY
        // ═══════════════════════════════════════════════════════════════

        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const monthlyTrips = await Trip.count({
            where: {
                [userType === 'PASSENGER' ? 'passengerId' : 'driverId']: userId,
                status: 'COMPLETED',
                completed_at: { [Op.gte]: thirtyDaysAgo }
            }
        });

        console.log(`📅 Last 30 days: ${monthlyTrips} trips`);

        // ═══════════════════════════════════════════════════════════════
        // 7️⃣ CALCULATE STREAK & ACHIEVEMENTS
        // ═══════════════════════════════════════════════════════════════

        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const weeklyTrips = await Trip.count({
            where: {
                [userType === 'PASSENGER' ? 'passengerId' : 'driverId']: userId,
                status: 'COMPLETED',
                completed_at: { [Op.gte]: sevenDaysAgo }
            }
        });

        // Determine activity level
        let activityLevel = 'NEW';
        if (totalTrips >= 100) activityLevel = 'PLATINUM';
        else if (totalTrips >= 50) activityLevel = 'GOLD';
        else if (totalTrips >= 20) activityLevel = 'SILVER';
        else if (totalTrips >= 5) activityLevel = 'BRONZE';

        // ═══════════════════════════════════════════════════════════════
        // 8️⃣ CALCULATE FAVORITE TIMES & ROUTES
        // ═══════════════════════════════════════════════════════════════

        // Most active hour
        const hourlyActivity = await Trip.findAll({
            where: {
                [userType === 'PASSENGER' ? 'passengerId' : 'driverId']: userId,
                status: 'COMPLETED'
            },
            attributes: [
                [sequelize.fn('HOUR', sequelize.col('created_at')), 'hour'],
                [sequelize.fn('COUNT', sequelize.col('id')), 'trip_count']
            ],
            group: [sequelize.fn('HOUR', sequelize.col('created_at'))],
            order: [[sequelize.literal('trip_count'), 'DESC']],
            limit: 1,
            raw: true
        });

        const favoriteHour = hourlyActivity[0]?.hour || null;

        // ═══════════════════════════════════════════════════════════════
        // 9️⃣ BUILD RESPONSE
        // ═══════════════════════════════════════════════════════════════

        const stats = {
            // Core Statistics
            total_trips: totalTrips,
            rating: avgRating > 0 ? parseFloat(avgRating.toFixed(1)) : 5.0,
            total_ratings: totalRatings,
            points: points,

            // Financial
            total_spent: userType === 'PASSENGER' ? Math.round(totalSpent) : 0,
            total_earned: userType === 'DRIVER' ? Math.round(totalEarned) : 0,
            currency: 'FCFA',

            // Distance & Time
            total_distance_km: parseFloat(totalDistance.toFixed(2)),
            total_duration_minutes: totalDuration,
            avg_distance_km: parseFloat(avgDistance.toFixed(2)),
            avg_duration_minutes: avgDuration,

            // Environmental Impact
            co2_saved_kg: parseFloat(co2SavedKg.toFixed(2)),
            trees_equivalent: Math.round(co2SavedKg / 20), // 1 tree absorbs ~20kg CO2/year

            // Activity
            monthly_trips: monthlyTrips,
            weekly_trips: weeklyTrips,
            activity_level: activityLevel,
            favorite_hour: favoriteHour,

            // Achievements
            achievements: [],
            next_milestone: null
        };

        // Add achievements based on stats
        if (totalTrips >= 100) {
            stats.achievements.push({
                id: 'century_club',
                name: 'Century Club',
                description: '100+ trips completed',
                icon: '🏆',
                unlocked_at: null
            });
        }

        if (avgRating >= 4.8) {
            stats.achievements.push({
                id: 'five_star',
                name: 'Five Star Service',
                description: 'Maintain 4.8+ rating',
                icon: '⭐',
                unlocked_at: null
            });
        }

        if (co2SavedKg >= 100) {
            stats.achievements.push({
                id: 'eco_warrior',
                name: 'Eco Warrior',
                description: 'Saved 100kg+ of CO2',
                icon: '🌍',
                unlocked_at: null
            });
        }

        // Calculate next milestone
        if (totalTrips < 10) {
            stats.next_milestone = { trips: 10, reward: '100 points' };
        } else if (totalTrips < 50) {
            stats.next_milestone = { trips: 50, reward: '200 points' };
        } else if (totalTrips < 100) {
            stats.next_milestone = { trips: 100, reward: '500 points' };
        } else if (totalTrips < 500) {
            stats.next_milestone = { trips: 500, reward: '2000 points' };
        } else if (totalTrips < 1000) {
            stats.next_milestone = { trips: 1000, reward: '5000 points' };
        }

        console.log('✅ [STATS] Calculation complete');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(200).json({
            success: true,
            message: 'User statistics retrieved successfully',
            data: stats
        });

    } catch (error) {
        console.error('❌ [STATS] Error calculating statistics:', error);
        console.error('Stack:', error.stack);

        res.status(500).json({
            success: false,
            message: 'Failed to retrieve user statistics',
            error: error.message
        });
    }
};


/**
 * 📈 GET USER ACTIVITY CHART DATA
 *
 * Endpoint: GET /api/users/stats/activity
 * Access: Private (requires authentication)
 * Query: period (week, month, year)
 *
 * Returns trip activity over time for chart visualization
 */
exports.getUserActivityChart = async (req, res) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📈 [STATS] Fetching activity chart data...');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        const userId = req.user.uuid;
        const userType = req.user.user_type;
        const { period = 'month' } = req.query;

        // Calculate date range
        let startDate = new Date();
        let groupBy;
        let dateFormat;

        switch (period) {
            case 'week':
                startDate.setDate(startDate.getDate() - 7);
                groupBy = sequelize.fn('DATE', sequelize.col('completed_at'));
                dateFormat = '%Y-%m-%d';
                break;
            case 'month':
                startDate.setDate(startDate.getDate() - 30);
                groupBy = sequelize.fn('DATE', sequelize.col('completed_at'));
                dateFormat = '%Y-%m-%d';
                break;
            case 'year':
                startDate.setFullYear(startDate.getFullYear() - 1);
                groupBy = sequelize.fn('DATE_FORMAT', sequelize.col('completed_at'), '%Y-%m');
                dateFormat = '%Y-%m';
                break;
            default:
                startDate.setDate(startDate.getDate() - 30);
                groupBy = sequelize.fn('DATE', sequelize.col('completed_at'));
                dateFormat = '%Y-%m-%d';
        }

        console.log(`📅 Period: ${period}`);
        console.log(`📆 From: ${startDate.toISOString()}`);

        const activityData = await Trip.findAll({
            where: {
                [userType === 'PASSENGER' ? 'passengerId' : 'driverId']: userId,
                status: 'COMPLETED',
                completed_at: { [Op.gte]: startDate }
            },
            attributes: [
                [groupBy, 'date'],
                [sequelize.fn('COUNT', sequelize.col('id')), 'trip_count'],
                [sequelize.fn('SUM', sequelize.col('distance_km')), 'total_distance']
            ],
            group: [groupBy],
            order: [[groupBy, 'ASC']],
            raw: true
        });

        console.log(`✅ Found ${activityData.length} data points`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(200).json({
            success: true,
            message: 'Activity chart data retrieved successfully',
            data: {
                period,
                start_date: startDate,
                end_date: new Date(),
                chart_data: activityData.map(item => ({
                    date: item.date,
                    trips: parseInt(item.trip_count),
                    distance: parseFloat(item.total_distance || 0).toFixed(2)
                }))
            }
        });

    } catch (error) {
        console.error('❌ [STATS] Error fetching activity chart:', error);

        res.status(500).json({
            success: false,
            message: 'Failed to retrieve activity chart data',
            error: error.message
        });
    }
};


/**
 * 🏆 GET USER ACHIEVEMENTS
 *
 * Endpoint: GET /api/users/stats/achievements
 * Access: Private (requires authentication)
 *
 * Returns all achievements, badges, and milestones
 */
exports.getUserAchievements = async (req, res) => {
    try {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🏆 [STATS] Fetching achievements...');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        const userId = req.user.uuid;
        const userType = req.user.user_type;

        // Get trip count
        const totalTrips = await Trip.count({
            where: {
                [userType === 'PASSENGER' ? 'passengerId' : 'driverId']: userId,
                status: 'COMPLETED'
            }
        });

        // Get rating
        const ratingStats = await Rating.findOne({
            where: { ratedUser: userId },
            attributes: [
                [sequelize.fn('AVG', sequelize.col('rating')), 'avg_rating']
            ],
            raw: true
        });

        const avgRating = parseFloat(ratingStats?.avg_rating || 0);

        // Define all possible achievements
        const allAchievements = [
            {
                id: 'first_ride',
                name: 'First Ride',
                description: 'Complete your first trip',
                icon: '🚀',
                requirement: 1,
                unlocked: totalTrips >= 1
            },
            {
                id: 'getting_started',
                name: 'Getting Started',
                description: 'Complete 10 trips',
                icon: '🎯',
                requirement: 10,
                unlocked: totalTrips >= 10
            },
            {
                id: 'bronze_rider',
                name: 'Bronze Rider',
                description: 'Complete 20 trips',
                icon: '🥉',
                requirement: 20,
                unlocked: totalTrips >= 20
            },
            {
                id: 'silver_rider',
                name: 'Silver Rider',
                description: 'Complete 50 trips',
                icon: '🥈',
                requirement: 50,
                unlocked: totalTrips >= 50
            },
            {
                id: 'gold_rider',
                name: 'Gold Rider',
                description: 'Complete 100 trips',
                icon: '🥇',
                requirement: 100,
                unlocked: totalTrips >= 100
            },
            {
                id: 'platinum_rider',
                name: 'Platinum Rider',
                description: 'Complete 500 trips',
                icon: '💎',
                requirement: 500,
                unlocked: totalTrips >= 500
            },
            {
                id: 'five_star',
                name: 'Five Star Service',
                description: 'Maintain 4.8+ rating',
                icon: '⭐',
                requirement: 4.8,
                unlocked: avgRating >= 4.8
            },
            {
                id: 'perfect_rating',
                name: 'Perfect Rating',
                description: 'Achieve 5.0 rating',
                icon: '🌟',
                requirement: 5.0,
                unlocked: avgRating === 5.0
            }
        ];

        const unlockedAchievements = allAchievements.filter(a => a.unlocked);
        const lockedAchievements = allAchievements.filter(a => !a.unlocked);

        console.log(`✅ Unlocked: ${unlockedAchievements.length}/${allAchievements.length}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        res.status(200).json({
            success: true,
            message: 'Achievements retrieved successfully',
            data: {
                total: allAchievements.length,
                unlocked: unlockedAchievements.length,
                progress: Math.round((unlockedAchievements.length / allAchievements.length) * 100),
                achievements: {
                    unlocked: unlockedAchievements,
                    locked: lockedAchievements
                }
            }
        });

    } catch (error) {
        console.error('❌ [STATS] Error fetching achievements:', error);

        res.status(500).json({
            success: false,
            message: 'Failed to retrieve achievements',
            error: error.message
        });
    }
};