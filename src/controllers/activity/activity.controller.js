// wegobackend/src/controllers/activity/activity.controller.js
// Unified Activity Feed for Passengers
// Returns paginated trips, rentals, and service requests

const { Op } = require('sequelize');

const {
    Trip,
    Account,
    DriverProfile,
    VehicleRental,
    Vehicle,
    ServiceListing,
    ServiceCategory,
    ServiceAdPayment,
    ServiceListingPlan,
} = require('../../models/index');

// ═══════════════════════════════════════════════════════════════════════
// PAGINATION HELPERS
// ═══════════════════════════════════════════════════════════════════════

const getPagination = (page, limit) => {
    const p = Math.max(1, parseInt(page) || 1);
    const l = Math.min(50, Math.max(1, parseInt(limit) || 10));
    return { limit: l, offset: (p - 1) * l, page: p };
};

const buildPaginationMeta = (count, page, limit) => ({
    total: count,
    page,
    limit,
    totalPages: Math.ceil(count / limit),
    hasNextPage: page * limit < count,
    hasPrevPage: page > 1,
});

// ═══════════════════════════════════════════════════════════════════════
// GET ALL ACTIVITY  ─  GET /api/activity?page=1&limit=10&type=all
// ═══════════════════════════════════════════════════════════════════════

exports.getAllActivity = async (req, res) => {
    try {
        const userId = req.user.uuid;
        const { page = 1, limit = 15, type = 'all' } = req.query;
        const { limit: l, offset, page: p } = getPagination(page, limit);

        console.log(`\n📊 [ACTIVITY] getAllActivity`);
        console.log(`   userId : ${userId}`);
        console.log(`   page   : ${p} | limit: ${l} | type: ${type}`);

        const [trips, rentals, services] = await Promise.all([
            type === 'all' || type === 'trips'
                ? _fetchTrips(userId, l, offset)
                : { rows: [], count: 0 },
            type === 'all' || type === 'rentals'
                ? _fetchRentals(userId, l, offset)
                : { rows: [], count: 0 },
            type === 'all' || type === 'services'
                ? _fetchServices(userId, l, offset)
                : { rows: [], count: 0 },
        ]);

        console.log(`✅ [ACTIVITY] getAllActivity complete`);
        console.log(`   trips: ${trips.count} | rentals: ${rentals.count} | services: ${services.count}`);

        return res.status(200).json({
            success: true,
            data: {
                trips: {
                    items: trips.rows,
                    meta: buildPaginationMeta(trips.count, p, l),
                },
                rentals: {
                    items: rentals.rows,
                    meta: buildPaginationMeta(rentals.count, p, l),
                },
                services: {
                    items: services.rows,
                    meta: buildPaginationMeta(services.count, p, l),
                },
                summary: {
                    totalTrips: trips.count,
                    totalRentals: rentals.count,
                    totalServices: services.count,
                },
            },
        });
    } catch (error) {
        console.error('❌ [ACTIVITY] getAllActivity crashed:', error.message);
        console.error(error.stack);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch activity',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET TRIPS  ─  GET /api/activity/trips?page=1&limit=10&status=COMPLETED
// ═══════════════════════════════════════════════════════════════════════

exports.getTrips = async (req, res) => {
    try {
        const userId = req.user.uuid;
        const { page = 1, limit = 10, status } = req.query;
        const { limit: l, offset, page: p } = getPagination(page, limit);

        console.log(`\n🚗 [ACTIVITY] getTrips`);
        console.log(`   userId : ${userId}`);
        console.log(`   page   : ${p} | limit: ${l} | status filter: ${status || 'default (COMPLETED+CANCELED)'}`);

        const where = { passengerId: userId };

        if (status) {
            const upper = status.toUpperCase();
            const valid = ['COMPLETED', 'CANCELED', 'IN_PROGRESS', 'MATCHED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'SEARCHING'];
            if (valid.includes(upper)) {
                where.status = upper;
                console.log(`   → status filter applied: ${upper}`);
            } else {
                console.warn(`   ⚠️ invalid status "${status}" — using default`);
                where.status = { [Op.in]: ['COMPLETED', 'CANCELED'] };
            }
        } else {
            where.status = { [Op.in]: ['COMPLETED', 'CANCELED'] };
        }

        const { rows, count } = await _fetchTrips(userId, l, offset, where);

        console.log(`✅ [ACTIVITY] getTrips — returning ${rows.length} of ${count}`);

        return res.status(200).json({
            success: true,
            data: {
                items: rows,
                meta: buildPaginationMeta(count, p, l),
            },
        });
    } catch (error) {
        console.error('❌ [ACTIVITY] getTrips crashed:', error.message);
        console.error(error.stack);
        return res.status(500).json({ success: false, message: 'Failed to fetch trips' });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET RENTALS  ─  GET /api/activity/rentals?page=1&limit=10&status=COMPLETED
// ═══════════════════════════════════════════════════════════════════════

exports.getRentals = async (req, res) => {
    try {
        const userId = req.user.uuid;
        const { page = 1, limit = 10, status } = req.query;
        const { limit: l, offset, page: p } = getPagination(page, limit);

        console.log(`\n🚙 [ACTIVITY] getRentals`);
        console.log(`   userId : ${userId}`);
        console.log(`   page   : ${p} | limit: ${l} | status: ${status || 'all'}`);

        const { rows, count } = await _fetchRentals(userId, l, offset, status);

        console.log(`✅ [ACTIVITY] getRentals — returning ${rows.length} of ${count}`);

        return res.status(200).json({
            success: true,
            data: {
                items: rows,
                meta: buildPaginationMeta(count, p, l),
            },
        });
    } catch (error) {
        console.error('❌ [ACTIVITY] getRentals crashed:', error.message);
        console.error(error.stack);
        return res.status(500).json({ success: false, message: 'Failed to fetch rentals' });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET SERVICES  ─  GET /api/activity/services?role=customer&status=completed
// ═══════════════════════════════════════════════════════════════════════

exports.getServices = async (req, res) => {
    try {
        const userId = req.user.uuid;
        const { page = 1, limit = 10, status, role } = req.query;
        const { limit: l, offset, page: p } = getPagination(page, limit);

        console.log(`\n🔧 [ACTIVITY] getServices`);
        console.log(`   userId : ${userId}`);
        console.log(`   page   : ${p} | limit: ${l} | status: ${status || 'all'} | role: ${role || 'all'}`);

        const { rows, count } = await _fetchServices(userId, l, offset, status, role);

        console.log(`✅ [ACTIVITY] getServices — returning ${rows.length} of ${count}`);

        return res.status(200).json({
            success: true,
            data: {
                items: rows,
                meta: buildPaginationMeta(count, p, l),
            },
        });
    } catch (error) {
        console.error('❌ [ACTIVITY] getServices crashed:', error.message);
        console.error(error.stack);
        return res.status(500).json({ success: false, message: 'Failed to fetch services' });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// PRIVATE: _fetchTrips
// ═══════════════════════════════════════════════════════════════════════

async function _fetchTrips(userId, limit, offset, customWhere = null) {
    const where = customWhere || {
        passengerId: userId,
        status: { [Op.in]: ['COMPLETED', 'CANCELED'] },
    };

    console.log(`   📋 _fetchTrips — limit: ${limit} | offset: ${offset}`);
    console.log(`   📋 _fetchTrips where:`, JSON.stringify(where));

    try {
        const result = await Trip.findAndCountAll({
            where,
            limit,
            offset,
            order: [['createdAt', 'DESC']],
            attributes: [
                'id',
                'pickupAddress',
                'dropoffAddress',
                'status',
                'fareEstimate',
                'fareFinal',        // ✅ correct field name — was 'fare' before
                'paymentMethod',
                'distanceM',
                'durationS',
                'createdAt',
                'tripCompletedAt',
                'canceledAt',
                'cancelReason',
                'canceledBy',
            ],
            include: [
                {
                    model: Account,
                    as: 'driver',
                    attributes: ['uuid', 'first_name', 'last_name', 'avatar_url'],
                    required: false,
                    include: [
                        {
                            model: DriverProfile,
                            as: 'driver_profile',
                            attributes: [
                                'rating_avg',
                                'vehicle_make_model',
                                'vehicle_color',
                                'vehicle_plate',
                                'vehicle_type',
                            ],
                            required: false,
                        },
                    ],
                },
            ],
        });

        console.log(`   ✅ _fetchTrips — total: ${result.count} | loaded: ${result.rows.length}`);
        return result;
    } catch (error) {
        console.error(`   ❌ _fetchTrips query failed: ${error.message}`);
        console.error(error.stack);

        console.log(`   ⚠️ _fetchTrips — retrying WITHOUT driver_profile include...`);
        try {
            const fallback = await Trip.findAndCountAll({
                where,
                limit,
                offset,
                order: [['createdAt', 'DESC']],
                attributes: [
                    'id',
                    'pickupAddress',
                    'dropoffAddress',
                    'status',
                    'fareEstimate',
                    'fareFinal',
                    'paymentMethod',
                    'distanceM',
                    'durationS',
                    'createdAt',
                    'tripCompletedAt',
                    'canceledAt',
                    'cancelReason',
                ],
                include: [
                    {
                        model: Account,
                        as: 'driver',
                        attributes: ['uuid', 'first_name', 'last_name', 'avatar_url'],
                        required: false,
                    },
                ],
            });
            console.log(`   ✅ _fetchTrips fallback — total: ${fallback.count}`);
            return fallback;
        } catch (fallbackErr) {
            console.error(`   ❌ _fetchTrips fallback also failed: ${fallbackErr.message}`);
            return { rows: [], count: 0 };
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════
// PRIVATE: _fetchRentals
// ═══════════════════════════════════════════════════════════════════════

async function _fetchRentals(userId, limit, offset, status = null) {
    // ✅ FIXED: VehicleRental has underscored: true
    // so camelCase field 'userId' maps to snake_case column 'user_id' in DB
    // Sequelize where clause must use the JS field name (camelCase) NOT the DB column
    // BUT since underscored:true is set, Sequelize maps it automatically
    // We use the model field name 'userId' which Sequelize translates to user_id
    const where = { userId };

    if (status) {
        const valid = ['PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED'];
        const up = status.toUpperCase();
        if (valid.includes(up)) {
            where.status = up;
            console.log(`   → rental status filter: ${up}`);
        } else {
            console.warn(`   ⚠️ invalid rental status "${status}" ignored`);
        }
    }

    console.log(`   📋 _fetchRentals — limit: ${limit} | offset: ${offset}`);
    console.log(`   📋 _fetchRentals where:`, JSON.stringify(where));

    try {
        const result = await VehicleRental.findAndCountAll({
            where,
            limit,
            offset,
            order: [['created_at', 'DESC']],
            attributes: [
                'id',
                'rentalType',
                'startDate',
                'endDate',
                'status',
                'totalPrice',
                'paymentStatus',
                'paymentMethod',
                'cancellationReason',
                'createdAt',
            ],
            include: [
                {
                    model: Vehicle,
                    as: 'vehicle',
                    attributes: [
                        'id',
                        'makeModel',           // ✅ JS field name (underscored:true → make_model in DB)
                        'color',
                        'plate',
                        'images',
                        'rentalPricePerHour',  // ✅ JS field name → rental_price_per_hour in DB
                        'rentalPricePerDay',   // ✅ JS field name → rental_price_per_day in DB
                    ],
                    required: false,
                },
            ],
        });

        console.log(`   ✅ _fetchRentals — total: ${result.count} | loaded: ${result.rows.length}`);
        return result;
    } catch (error) {
        console.error(`   ❌ _fetchRentals query failed: ${error.message}`);
        console.error(error.stack);

        console.log(`   ⚠️ _fetchRentals — retrying WITHOUT vehicle include...`);
        try {
            const fallback = await VehicleRental.findAndCountAll({
                where,
                limit,
                offset,
                order: [['created_at', 'DESC']],
                attributes: [
                    'id',
                    'rentalType',
                    'startDate',
                    'endDate',
                    'status',
                    'totalPrice',
                    'paymentStatus',
                    'paymentMethod',
                    'cancellationReason',
                    'createdAt',
                ],
            });
            console.log(`   ✅ _fetchRentals fallback — total: ${fallback.count}`);
            return fallback;
        } catch (fallbackErr) {
            console.error(`   ❌ _fetchRentals fallback also failed: ${fallbackErr.message}`);
            return { rows: [], count: 0 };
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════
// PRIVATE: _fetchServices
// Classifieds model — returns the user's own listings (provider view).
// Buyers no longer have "service request" history; they browse and call.
// ═══════════════════════════════════════════════════════════════════════

async function _fetchServices(userId, limit, offset, status = null) {
    const where = { provider_id: userId };

    if (status) {
        const valid = ['active', 'inactive', 'pending_review', 'hero_pending', 'rejected', 'draft'];
        if (valid.includes(status)) where.status = status;
    }

    try {
        const result = await ServiceListing.findAndCountAll({
            where,
            limit,
            offset,
            order: [['boost_priority', 'DESC'], ['created_at', 'DESC']],
            attributes: ['id', 'listing_id', 'title', 'status', 'boost_priority', 'plan_expires_at', 'created_at', 'average_rating', 'review_count'],
            include: [
                {
                    model: ServiceCategory,
                    as: 'category',
                    attributes: ['id', 'name_fr', 'name_en'],
                    required: false,
                },
                {
                    model: ServiceAdPayment,
                    as: 'adPayment',
                    attributes: ['id', 'plan_key_snapshot', 'status', 'plan_expires_at'],
                    required: false,
                    include: [{ model: ServiceListingPlan, as: 'plan', attributes: ['label_fr', 'label_en'], required: false }],
                },
            ],
        });
        console.log(`   ✅ _fetchServices — total: ${result.count} | loaded: ${result.rows.length}`);
        return result;
    } catch (err) {
        console.error(`   ❌ _fetchServices query failed: ${err.message}`);
        return { rows: [], count: 0 };
    }
}