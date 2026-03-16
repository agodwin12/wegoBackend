// src/controllers/backoffice/deliveryAgents.controller.js

const { Op } = require('sequelize');
const { Account, Driver, DriverProfile, Delivery, sequelize } = require('../../models');

// ═══════════════════════════════════════════════════════════════════════════════
// GET ALL DELIVERY AGENTS
// GET /api/backoffice/delivery/agents
// ═══════════════════════════════════════════════════════════════════════════════
exports.getAgents = async (req, res) => {
    try {
        const {
            page   = 1,
            limit  = 10,
            search = '',
            mode,    // 'ride' | 'delivery' | '' (all)
            status,  // 'online' | 'offline' | 'busy'
        } = req.query;

        const offset = (parseInt(page) - 1) * parseInt(limit);

        // ── Driver WHERE ──────────────────────────────────────────────────────
        const driverWhere = {};
        if (mode)   driverWhere.current_mode = mode;
        if (status) driverWhere.status       = status;

        // ── Account WHERE ─────────────────────────────────────────────────────
        const accountWhere = {
            user_type: { [Op.in]: ['DRIVER', 'DELIVERY_AGENT'] },
        };
        if (search) {
            accountWhere[Op.or] = [
                { first_name: { [Op.like]: `%${search}%` } },
                { last_name:  { [Op.like]: `%${search}%` } },
                { phone_e164: { [Op.like]: `%${search}%` } },
                { email:      { [Op.like]: `%${search}%` } },
            ];
        }

        // ── Query ─────────────────────────────────────────────────────────────
        const { count, rows: drivers } = await Driver.findAndCountAll({
            where: driverWhere,
            include: [
                {
                    model:      Account,
                    as:         'account',
                    where:      accountWhere,
                    attributes: [
                        'uuid', 'first_name', 'last_name', 'email',
                        'phone_e164', 'avatar_url', 'status', 'user_type',
                    ],
                    required: true,
                    include: [
                        {
                            model:      DriverProfile,
                            as:         'driver_profile',
                            attributes: ['rating_avg', 'rating_count', 'vehicle_plate', 'vehicle_color', 'vehicle_type'],
                            required:   false,
                        },
                    ],
                },
            ],
            order: [
                // ✅ Backtick-qualified to avoid ambiguous column error
                [sequelize.literal("FIELD(`Driver`.`status`, 'online', 'busy', 'offline')"),     'ASC'],
                [sequelize.literal("FIELD(`Driver`.`current_mode`, 'delivery', 'ride')"),         'ASC'],
                [sequelize.literal('`Driver`.`lastHeartbeat`'),                                   'DESC'],
            ],
            limit:    parseInt(limit),
            offset,
            distinct: true,
        });

        // ── Enrich with delivery stats ────────────────────────────────────────
        const agentsWithStats = await Promise.all(drivers.map(async (driver) => {
            const [totalDeliveries, completedDeliveries, totalEarnings, activeDelivery] = await Promise.all([
                Delivery.count({ where: { driver_id: driver.id } }),
                Delivery.count({ where: { driver_id: driver.id, status: 'delivered' } }),
                Delivery.sum('driver_payout', { where: { driver_id: driver.id, status: 'delivered' } }),
                Delivery.findOne({
                    where: {
                        driver_id: driver.id,
                        status: { [Op.in]: ['accepted','en_route_pickup','arrived_pickup','picked_up','en_route_dropoff','arrived_dropoff'] },
                    },
                    attributes: ['id', 'delivery_code', 'status'],
                }),
            ]);

            // ── Vehicle: prefer Driver.vehicle_make_model (delivery agents)
            // Fall back to DriverProfile.vehicle_make_model (ride drivers)
            const vehicleMakeModel =
                driver.vehicle_make_model ||
                driver.account?.driver_profile?.vehicle_make_model ||
                null;

            return {
                id:            driver.id,
                userId:        driver.userId,
                status:        driver.status,
                currentMode:   driver.current_mode,
                lat:           driver.lat,
                lng:           driver.lng,
                phone:         driver.phone,
                rating:        driver.rating,
                lastHeartbeat: driver.lastHeartbeat,

                account: {
                    uuid:      driver.account?.uuid,
                    firstName: driver.account?.first_name,
                    lastName:  driver.account?.last_name,
                    email:     driver.account?.email,
                    phone:     driver.account?.phone_e164,
                    avatar:    driver.account?.avatar_url,   // ✅ R2 URL
                    status:    driver.account?.status,
                    userType:  driver.account?.user_type,
                },

                // ✅ vehicle_make_model from Driver row directly
                profile: {
                    vehicleMakeModel: vehicleMakeModel,
                    vehiclePlate:  driver.account?.driver_profile?.vehicle_plate  || null,
                    vehicleColor:  driver.account?.driver_profile?.vehicle_color  || null,
                    vehicleType:   driver.account?.driver_profile?.vehicle_type   || null,
                    ratingAvg:     driver.account?.driver_profile?.rating_avg     || null,
                    ratingCount:   driver.account?.driver_profile?.rating_count   || null,
                },

                stats: {
                    totalDeliveries,
                    completedDeliveries,
                    totalEarnings:  totalEarnings || 0,
                    completionRate: totalDeliveries > 0
                        ? Math.round((completedDeliveries / totalDeliveries) * 100)
                        : 0,
                },

                activeDelivery: activeDelivery ? {
                    id:           activeDelivery.id,
                    deliveryCode: activeDelivery.delivery_code,
                    status:       activeDelivery.status,
                } : null,
            };
        }));

        // ── Summary stats ─────────────────────────────────────────────────────
        const [totalDrivers, deliveryModeCount, onlineDeliveryCount, busyCount] = await Promise.all([
            Driver.count(),
            Driver.count({ where: { current_mode: 'delivery' } }),
            Driver.count({ where: { current_mode: 'delivery', status: 'online' } }),
            Driver.count({ where: { current_mode: 'delivery', status: 'busy' } }),
        ]);

        return res.json({
            success: true,
            agents:  agentsWithStats,
            stats: {
                totalDrivers,
                deliveryModeCount,
                onlineDeliveryCount,
                busyCount,
                rideModeCount: totalDrivers - deliveryModeCount,
            },
            pagination: {
                total:      count,
                page:       parseInt(page),
                limit:      parseInt(limit),
                totalPages: Math.ceil(count / parseInt(limit)),
            },
        });

    } catch (error) {
        console.error('❌ [DELIVERY AGENTS] getAgents error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch delivery agents' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// SWITCH DRIVER MODE
// PATCH /api/backoffice/delivery/agents/:driverId/mode
// ═══════════════════════════════════════════════════════════════════════════════
exports.switchMode = async (req, res) => {
    try {
        const { driverId } = req.params;
        const { mode }     = req.body;

        if (!['ride', 'delivery'].includes(mode)) {
            return res.status(400).json({ success: false, message: 'mode must be "ride" or "delivery"' });
        }

        const driver = await Driver.findByPk(driverId);
        if (!driver) return res.status(404).json({ success: false, message: 'Driver not found' });

        if (driver.status === 'busy') {
            return res.status(400).json({
                success: false,
                message: 'Cannot switch mode while driver has an active trip or delivery',
            });
        }

        const previousMode = driver.current_mode;
        await driver.update({ current_mode: mode });

        console.log(`🔄 [DELIVERY AGENTS] Admin ${req.user.id} switched driver ${driverId}: ${previousMode} → ${mode}`);

        return res.json({
            success:     true,
            message:     `Driver switched to ${mode} mode`,
            previousMode,
            currentMode: mode,
        });

    } catch (error) {
        console.error('❌ [DELIVERY AGENTS] switchMode error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to switch driver mode' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET SINGLE AGENT DETAILS
// GET /api/backoffice/delivery/agents/:driverId
// ═══════════════════════════════════════════════════════════════════════════════
exports.getAgent = async (req, res) => {
    try {
        const { driverId } = req.params;
        const page  = parseInt(req.query.page  || 1);
        const limit = parseInt(req.query.limit || 10);

        const driver = await Driver.findByPk(driverId, {
            include: [
                {
                    model:      Account,
                    as:         'account',
                    attributes: [
                        'uuid', 'first_name', 'last_name', 'email',
                        'phone_e164', 'avatar_url', 'status', 'user_type', 'created_at',
                    ],
                    include: [
                        {
                            model:    DriverProfile,
                            as:       'driver_profile',
                            required: false,
                        },
                    ],
                },
            ],
        });

        if (!driver) {
            return res.status(404).json({ success: false, message: 'Agent not found' });
        }

        // ── All stats in parallel ─────────────────────────────────────────────
        const [
            totalDeliveries,
            completedDeliveries,
            cancelledDeliveries,
            totalEarnings,
            totalCommissionGenerated,
            avgRatingRow,
            activeDelivery,
        ] = await Promise.all([
            Delivery.count({ where: { driver_id: driverId } }),
            Delivery.count({ where: { driver_id: driverId, status: 'delivered' } }),
            Delivery.count({ where: { driver_id: driverId, status: 'cancelled' } }),
            Delivery.sum('driver_payout',    { where: { driver_id: driverId, status: 'delivered' } }),
            Delivery.sum('commission_amount',{ where: { driver_id: driverId, status: 'delivered' } }),
            Delivery.findOne({
                where:      { driver_id: driverId, rating: { [Op.not]: null } },
                attributes: [[sequelize.fn('AVG', sequelize.col('rating')), 'avgRating']],
                raw:        true,
            }),
            Delivery.findOne({
                where: {
                    driver_id: driverId,
                    status: { [Op.in]: ['accepted','en_route_pickup','arrived_pickup','picked_up','en_route_dropoff','arrived_dropoff'] },
                },
                attributes: ['id', 'delivery_code', 'status', 'pickup_address', 'dropoff_address', 'total_price', 'package_size'],
            }),
        ]);

        // ── Paginated delivery history ─────────────────────────────────────────
        const { count: deliveryCount, rows: deliveries } = await Delivery.findAndCountAll({
            where:  { driver_id: driverId },
            order:  [['created_at', 'DESC']],
            limit,
            offset: (page - 1) * limit,
            attributes: [
                'id', 'delivery_code', 'status', 'package_size',
                'total_price', 'driver_payout', 'commission_amount',
                'payment_method', 'payment_status',
                'pickup_address', 'dropoff_address',
                'recipient_name', 'recipient_phone',
                'rating', 'rating_comment',
                'distance_km', 'surge_multiplier_applied',
                'created_at', 'delivered_at', 'cancelled_at',
            ],
        });

        // ── Vehicle: same fallback logic as list ──────────────────────────────
        const vehicleMakeModel =
            driver.vehicle_make_model ||
            driver.account?.driver_profile?.vehicle_make_model ||
            null;

        return res.json({
            success: true,
            agent: {
                id:            driver.id,
                userId:        driver.userId,
                status:        driver.status,
                currentMode:   driver.current_mode,
                lat:           driver.lat,
                lng:           driver.lng,
                phone:         driver.phone,
                rating:        driver.rating,
                vehicleId:     driver.vehicleId,
                lastHeartbeat: driver.lastHeartbeat,

                account: {
                    uuid:      driver.account?.uuid,
                    firstName: driver.account?.first_name,
                    lastName:  driver.account?.last_name,
                    email:     driver.account?.email,
                    phone:     driver.account?.phone_e164,
                    avatar:    driver.account?.avatar_url,
                    status:    driver.account?.status,
                    userType:  driver.account?.user_type,
                    createdAt: driver.account?.created_at,
                },

                // ✅ vehicle_make_model from Driver row + other details from profile
                vehicleMakeModel,
                profile: driver.account?.driver_profile || null,

                stats: {
                    totalDeliveries,
                    completedDeliveries,
                    cancelledDeliveries,
                    totalEarnings:            totalEarnings            || 0,
                    totalCommissionGenerated: totalCommissionGenerated || 0,
                    deliveryRating:           avgRatingRow?.avgRating
                        ? parseFloat(Number(avgRatingRow.avgRating).toFixed(2))
                        : null,
                    completionRate: totalDeliveries > 0
                        ? Math.round((completedDeliveries / totalDeliveries) * 100)
                        : 0,
                },

                activeDelivery: activeDelivery ? {
                    id:             activeDelivery.id,
                    deliveryCode:   activeDelivery.delivery_code,
                    status:         activeDelivery.status,
                    packageSize:    activeDelivery.package_size,
                    pickupAddress:  activeDelivery.pickup_address,
                    dropoffAddress: activeDelivery.dropoff_address,
                    totalPrice:     parseFloat(activeDelivery.total_price),
                } : null,

                deliveries,
                deliveryPagination: {
                    total:      deliveryCount,
                    page,
                    limit,
                    totalPages: Math.ceil(deliveryCount / limit),
                },
            },
        });

    } catch (error) {
        console.error('❌ [DELIVERY AGENTS] getAgent error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch agent details' });
    }
};