// src/controllers/backoffice/deliveryLiveMonitor.controller.js

const { Op } = require('sequelize');
const { Delivery, Account, Driver, DeliveryTracking } = require('../../models');
const { redisClient } = require('../../config/redis');

// ═══════════════════════════════════════════════════════════════════════════════
// GET ALL ACTIVE DELIVERIES FOR LIVE MAP
// GET /api/backoffice/delivery/live
// Returns all in-progress deliveries with latest driver coordinates
// ═══════════════════════════════════════════════════════════════════════════════
exports.getLiveDeliveries = async (req, res) => {
    try {
        const ACTIVE_STATUSES = [
            'accepted',
            'en_route_pickup',
            'arrived_pickup',
            'picked_up',
            'en_route_dropoff',
            'arrived_dropoff',
        ];

        // Fetch all active deliveries with sender + driver info
        const deliveries = await Delivery.findAll({
            where: { status: { [Op.in]: ACTIVE_STATUSES } },
            include: [
                {
                    association: 'sender',
                    attributes:  ['uuid', 'first_name', 'last_name', 'phone_e164'],
                },
                {
                    association: 'driver',
                    attributes:  ['id', 'lat', 'lng', 'heading', 'status', 'phone', 'rating'],
                },
            ],
            order: [['updated_at', 'DESC']],
        });

        // For each delivery, get the driver's latest position
        // First try the Driver table (live heartbeat coords)
        // Fall back to latest DeliveryTracking record
        const liveData = await Promise.all(deliveries.map(async (delivery) => {
            let driverLat     = null;
            let driverLng     = null;
            let driverHeading = null;

            // Driver model has live lat/lng from Socket.IO heartbeat
            if (delivery.driver) {
                driverLat     = delivery.driver.lat     ? parseFloat(delivery.driver.lat)     : null;
                driverLng     = delivery.driver.lng     ? parseFloat(delivery.driver.lng)     : null;
                driverHeading = delivery.driver.heading ? parseFloat(delivery.driver.heading) : null;
            }

            // If Driver table has no coords, check latest tracking record
            if (!driverLat || !driverLng) {
                const latestTracking = await DeliveryTracking.getLatestPosition(delivery.id);
                if (latestTracking) {
                    driverLat     = parseFloat(latestTracking.latitude);
                    driverLng     = parseFloat(latestTracking.longitude);
                    driverHeading = latestTracking.bearing ? parseFloat(latestTracking.bearing) : null;
                }
            }

            // Try Redis as last resort — driver may have updated location there
            if (!driverLat && delivery.driver_id) {
                try {
                    const redisLoc = await redisClient.get(`driver:location:${delivery.driver_id}`);
                    if (redisLoc) {
                        const parsed = JSON.parse(redisLoc);
                        driverLat     = parsed.lat || parsed.latitude  || null;
                        driverLng     = parsed.lng || parsed.longitude || null;
                        driverHeading = parsed.heading || parsed.bearing || null;
                    }
                } catch (e) {
                    // Redis lookup failure is non-fatal
                }
            }

            // Get driver account name
            let driverName = 'Unknown Driver';
            if (delivery.driver_id) {
                try {
                    const driverAccount = await Account.findOne({
                        where:      { uuid: delivery.driver ? delivery.driver.userId : null },
                        attributes: ['first_name', 'last_name'],
                    });
                    if (driverAccount) {
                        driverName = `${driverAccount.first_name} ${driverAccount.last_name}`.trim();
                    }
                } catch (e) { /* non-fatal */ }
            }

            // Calculate how long since last status update
            const minutesSinceUpdate = delivery.updated_at
                ? Math.floor((Date.now() - new Date(delivery.updated_at).getTime()) / 60000)
                : null;

            return {
                id:           delivery.id,
                deliveryCode: delivery.delivery_code,
                status:       delivery.status,

                // Pickup
                pickup: {
                    address:  delivery.pickup_address,
                    lat:      parseFloat(delivery.pickup_latitude),
                    lng:      parseFloat(delivery.pickup_longitude),
                    landmark: delivery.pickup_landmark,
                },

                // Dropoff
                dropoff: {
                    address:  delivery.dropoff_address,
                    lat:      parseFloat(delivery.dropoff_latitude),
                    lng:      parseFloat(delivery.dropoff_longitude),
                    landmark: delivery.dropoff_landmark,
                },

                // Driver live position
                driver: {
                    id:      delivery.driver_id,
                    name:    driverName,
                    phone:   delivery.driver?.phone || null,
                    rating:  delivery.driver?.rating || null,
                    lat:     driverLat,
                    lng:     driverLng,
                    heading: driverHeading,
                    hasLocation: !!(driverLat && driverLng),
                },

                // Sender
                sender: {
                    name:  delivery.sender
                        ? `${delivery.sender.first_name} ${delivery.sender.last_name}`.trim()
                        : 'Unknown',
                    phone: delivery.sender?.phone_e164 || null,
                },

                // Package
                packageSize:  delivery.package_size,
                isFragile:    delivery.is_fragile,
                totalPrice:   parseFloat(delivery.total_price),
                paymentMethod: delivery.payment_method,

                // Timing
                acceptedAt:       delivery.accepted_at,
                pickedUpAt:       delivery.picked_up_at,
                updatedAt:        delivery.updated_at,
                minutesSinceUpdate,

                // Flag deliveries that haven't updated in a while
                isStale: minutesSinceUpdate !== null && minutesSinceUpdate > 15,
            };
        }));

        // Summary counts by status
        const statusCounts = ACTIVE_STATUSES.reduce((acc, s) => {
            acc[s] = liveData.filter(d => d.status === s).length;
            return acc;
        }, {});

        // Count drivers with known location
        const withLocation    = liveData.filter(d => d.driver.hasLocation).length;
        const withoutLocation = liveData.length - withLocation;

        return res.json({
            success:    true,
            total:      liveData.length,
            deliveries: liveData,
            summary: {
                total:          liveData.length,
                withLocation,
                withoutLocation,
                staleCount:     liveData.filter(d => d.isStale).length,
                statusCounts,
            },
            fetchedAt: new Date().toISOString(),
        });

    } catch (error) {
        console.error('❌ [LIVE MONITOR] getLiveDeliveries error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch live deliveries' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET SINGLE DELIVERY LIVE DETAIL
// GET /api/backoffice/delivery/live/:id
// Used when admin clicks a delivery on the map for full details
// ═══════════════════════════════════════════════════════════════════════════════
exports.getLiveDetail = async (req, res) => {
    try {
        const deliveryId = parseInt(req.params.id);

        const delivery = await Delivery.findByPk(deliveryId, {
            include: [
                { association: 'sender',      attributes: ['uuid', 'first_name', 'last_name', 'phone_e164', 'avatar_url'] },
                { association: 'driver',      attributes: ['id', 'lat', 'lng', 'heading', 'phone', 'rating', 'userId'] },
                { association: 'pricingZone', attributes: ['id', 'zone_name'] },
                { association: 'surgeRule',   attributes: ['id', 'name', 'multiplier'] },
            ],
        });

        if (!delivery) {
            return res.status(404).json({ success: false, message: 'Delivery not found' });
        }

        // Get full route for this delivery so far
        const route = await DeliveryTracking.getFullRoute(deliveryId);

        return res.json({
            success:  true,
            delivery: {
                ...delivery.toJSON(),
                delivery_pin: undefined, // Never expose PIN
                route: route.map(p => ({
                    lat:      parseFloat(p.latitude),
                    lng:      parseFloat(p.longitude),
                    bearing:  p.bearing,
                    phase:    p.phase,
                    recordedAt: p.recorded_at,
                })),
            },
        });

    } catch (error) {
        console.error('❌ [LIVE MONITOR] getLiveDetail error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch delivery detail' });
    }
};