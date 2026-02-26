// backend/src/routes/public/stats.routes.js

const express = require('express');
const router = express.Router();
const statsController = require('../../controllers/public/statsController');
const { authenticate } = require('../../middleware/auth.middleware');

// ═══════════════════════════════════════════════════════════════════════
// USER STATISTICS ROUTES FOR MOBILE USERS
// ═══════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────
// All stats routes require authentication
// ───────────────────────────────────────────────────────────────────────
router.use(authenticate);

// ═══════════════════════════════════════════════════════════════════════
// MAIN STATISTICS ENDPOINT
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   GET /api/users/stats
 * @desc    Get comprehensive user statistics
 * @access  Private (requires authentication)
 *
 * @returns {Object} Complete user statistics including:
 *          - total_trips: Number of completed trips
 *          - rating: Average rating received (1-5)
 *          - total_ratings: Number of ratings received
 *          - points: Reward points earned
 *          - total_spent: Total money spent (passengers)
 *          - total_earned: Total money earned (drivers)
 *          - total_distance_km: Total distance traveled
 *          - total_duration_minutes: Total time spent on trips
 *          - avg_distance_km: Average distance per trip
 *          - avg_duration_minutes: Average duration per trip
 *          - co2_saved_kg: CO2 emissions saved
 *          - trees_equivalent: Equivalent trees planted
 *          - monthly_trips: Trips in last 30 days
 *          - weekly_trips: Trips in last 7 days
 *          - activity_level: User tier (NEW, BRONZE, SILVER, GOLD, PLATINUM)
 *          - favorite_hour: Most active hour of day
 *          - achievements: Array of unlocked achievements
 *          - next_milestone: Next milestone to reach
 *
 * @example Success Response (200):
 * {
 *   "success": true,
 *   "message": "User statistics retrieved successfully",
 *   "data": {
 *     "total_trips": 45,
 *     "rating": 4.8,
 *     "total_ratings": 23,
 *     "points": 1250,
 *     "total_spent": 125000,
 *     "total_earned": 0,
 *     "currency": "FCFA",
 *     "total_distance_km": 450.5,
 *     "total_duration_minutes": 1350,
 *     "avg_distance_km": 10.01,
 *     "avg_duration_minutes": 30,
 *     "co2_saved_kg": 27.03,
 *     "trees_equivalent": 1,
 *     "monthly_trips": 12,
 *     "weekly_trips": 3,
 *     "activity_level": "GOLD",
 *     "favorite_hour": 18,
 *     "achievements": [
 *       {
 *         "id": "first_ride",
 *         "name": "First Ride",
 *         "description": "Complete your first trip",
 *         "icon": "🚀",
 *         "unlocked_at": null
 *       }
 *     ],
 *     "next_milestone": {
 *       "trips": 50,
 *       "reward": "200 points"
 *     }
 *   }
 * }
 *
 * @example Error Response (401):
 * {
 *   "success": false,
 *   "message": "Authentication required",
 *   "code": "NO_TOKEN_PROVIDED"
 * }
 *
 * @example Error Response (500):
 * {
 *   "success": false,
 *   "message": "Failed to retrieve user statistics",
 *   "error": "Database connection error"
 * }
 */
router.get('/', statsController.getUserStats);

// ═══════════════════════════════════════════════════════════════════════
// ACTIVITY CHART ENDPOINT
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   GET /api/users/stats/activity
 * @desc    Get user activity chart data over time
 * @access  Private (requires authentication)
 *
 * @query   period - Time period for chart data
 *          Options: 'week' | 'month' | 'year'
 *          Default: 'month'
 *
 * @returns {Object} Time-series data for chart visualization:
 *          - period: The time period used
 *          - start_date: Start date of the period
 *          - end_date: End date of the period
 *          - chart_data: Array of daily/monthly data points
 *
 * @example Request:
 * GET /api/users/stats/activity?period=month
 * Authorization: Bearer YOUR_ACCESS_TOKEN
 *
 * @example Success Response (200):
 * {
 *   "success": true,
 *   "message": "Activity chart data retrieved successfully",
 *   "data": {
 *     "period": "month",
 *     "start_date": "2024-01-10T00:00:00.000Z",
 *     "end_date": "2024-02-10T14:30:00.000Z",
 *     "chart_data": [
 *       {
 *         "date": "2024-02-01",
 *         "trips": 3,
 *         "distance": "15.50"
 *       },
 *       {
 *         "date": "2024-02-02",
 *         "trips": 5,
 *         "distance": "28.30"
 *       },
 *       {
 *         "date": "2024-02-03",
 *         "trips": 2,
 *         "distance": "12.80"
 *       }
 *     ]
 *   }
 * }
 *
 * @example Error Response (401):
 * {
 *   "success": false,
 *   "message": "Authentication required",
 *   "code": "NO_TOKEN_PROVIDED"
 * }
 *
 * @example Error Response (500):
 * {
 *   "success": false,
 *   "message": "Failed to retrieve activity chart data",
 *   "error": "Database query error"
 * }
 */
router.get('/activity', statsController.getUserActivityChart);

// ═══════════════════════════════════════════════════════════════════════
// ACHIEVEMENTS ENDPOINT
// ═══════════════════════════════════════════════════════════════════════

/**
 * @route   GET /api/users/stats/achievements
 * @desc    Get all user achievements, badges, and milestones
 * @access  Private (requires authentication)
 *
 * @returns {Object} All achievements (unlocked and locked):
 *          - total: Total number of achievements
 *          - unlocked: Number of unlocked achievements
 *          - progress: Percentage of achievements unlocked
 *          - achievements.unlocked: Array of unlocked achievements
 *          - achievements.locked: Array of locked achievements
 *
 * @example Request:
 * GET /api/users/stats/achievements
 * Authorization: Bearer YOUR_ACCESS_TOKEN
 *
 * @example Success Response (200):
 * {
 *   "success": true,
 *   "message": "Achievements retrieved successfully",
 *   "data": {
 *     "total": 8,
 *     "unlocked": 4,
 *     "progress": 50,
 *     "achievements": {
 *       "unlocked": [
 *         {
 *           "id": "first_ride",
 *           "name": "First Ride",
 *           "description": "Complete your first trip",
 *           "icon": "🚀",
 *           "requirement": 1,
 *           "unlocked": true
 *         },
 *         {
 *           "id": "getting_started",
 *           "name": "Getting Started",
 *           "description": "Complete 10 trips",
 *           "icon": "🎯",
 *           "requirement": 10,
 *           "unlocked": true
 *         },
 *         {
 *           "id": "bronze_rider",
 *           "name": "Bronze Rider",
 *           "description": "Complete 20 trips",
 *           "icon": "🥉",
 *           "requirement": 20,
 *           "unlocked": true
 *         },
 *         {
 *           "id": "five_star",
 *           "name": "Five Star Service",
 *           "description": "Maintain 4.8+ rating",
 *           "icon": "⭐",
 *           "requirement": 4.8,
 *           "unlocked": true
 *         }
 *       ],
 *       "locked": [
 *         {
 *           "id": "silver_rider",
 *           "name": "Silver Rider",
 *           "description": "Complete 50 trips",
 *           "icon": "🥈",
 *           "requirement": 50,
 *           "unlocked": false
 *         },
 *         {
 *           "id": "gold_rider",
 *           "name": "Gold Rider",
 *           "description": "Complete 100 trips",
 *           "icon": "🥇",
 *           "requirement": 100,
 *           "unlocked": false
 *         },
 *         {
 *           "id": "platinum_rider",
 *           "name": "Platinum Rider",
 *           "description": "Complete 500 trips",
 *           "icon": "💎",
 *           "requirement": 500,
 *           "unlocked": false
 *         },
 *         {
 *           "id": "perfect_rating",
 *           "name": "Perfect Rating",
 *           "description": "Achieve 5.0 rating",
 *           "icon": "🌟",
 *           "requirement": 5.0,
 *           "unlocked": false
 *         }
 *       ]
 *     }
 *   }
 * }
 *
 * @example Error Response (401):
 * {
 *   "success": false,
 *   "message": "Authentication required",
 *   "code": "NO_TOKEN_PROVIDED"
 * }
 *
 * @example Error Response (500):
 * {
 *   "success": false,
 *   "message": "Failed to retrieve achievements",
 *   "error": "Database error"
 * }
 */
router.get('/achievements', statsController.getUserAchievements);

// ═══════════════════════════════════════════════════════════════════════
// EXPORT ROUTER
// ═══════════════════════════════════════════════════════════════════════

module.exports = router;