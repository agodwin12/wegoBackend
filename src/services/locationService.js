// src/services/locationService.js
const { redisClient, REDIS_KEYS, redisHelpers } = require('../config/redis');

class LocationService {
    constructor() {
        this.searchRadiusKm = parseFloat(process.env.DRIVER_SEARCH_RADIUS_KM || 5);
    }

    async updateDriverLocation(driverId, lng, lat, metadata = {}) {
        try {
            if (!this._isValidCoordinate(lng, lat)) {
                throw new Error('Invalid coordinates');
            }

            console.log(`📍 [LOCATION] Updating driver ${driverId} location: [${lat}, ${lng}]`);

            const pipeline = redisClient.pipeline();

            pipeline.geoadd(REDIS_KEYS.DRIVERS_GEO, lng, lat, driverId);

            const driverMeta = {
                status: metadata.status || 'online',
                heading: metadata.heading || 0,
                speed: metadata.speed || 0,
                currentTripId: metadata.currentTripId || null,
                lastUpdate: Date.now(),
                ...metadata
            };
            pipeline.set(
                REDIS_KEYS.DRIVER_META(driverId),
                JSON.stringify(driverMeta),
                'EX',
                3600
            );

            await pipeline.exec();

            console.log(`✅ [LOCATION] Driver ${driverId} location updated successfully`);
            return { success: true, driverId, lat, lng };
        } catch (error) {
            console.error('❌ [LOCATION] Error updating driver location:', error.message);
            throw error;
        }
    }

    async removeDriverLocation(driverId) {
        try {
            console.log(`🗑️ [LOCATION] Removing driver ${driverId} from geo index`);

            const pipeline = redisClient.pipeline();
            pipeline.zrem(REDIS_KEYS.DRIVERS_GEO, driverId);
            pipeline.del(REDIS_KEYS.DRIVER_META(driverId));
            await pipeline.exec();

            console.log(`✅ [LOCATION] Driver ${driverId} removed successfully`);
            return { success: true, driverId };
        } catch (error) {
            console.error('❌ [LOCATION] Error removing driver location:', error.message);
            throw error;
        }
    }

    async findNearbyDrivers(lng, lat, radiusKm = null, limit = 50) {
        try {
            const radius = radiusKm || this.searchRadiusKm;

            console.log(`🔍 [LOCATION] Finding drivers within ${radius}km of [${lat}, ${lng}]`);

            const nearbyDrivers = await redisClient.georadius(
                REDIS_KEYS.DRIVERS_GEO,
                lng,
                lat,
                radius,
                'km',
                'WITHDIST',
                'ASC',
                'COUNT',
                limit
            );

            if (!nearbyDrivers || nearbyDrivers.length === 0) {
                console.log('⚠️ [LOCATION] No drivers found nearby');
                return [];
            }

            console.log(`📊 [LOCATION] Found ${nearbyDrivers.length} drivers nearby`);

            const driversWithMeta = [];

            for (const [driverId, distance] of nearbyDrivers) {
                const metaKey = REDIS_KEYS.DRIVER_META(driverId);
                const metadata = await redisClient.get(metaKey);

                if (metadata) {
                    const meta = JSON.parse(metadata);

                    if (meta.status === 'online' && !meta.currentTripId) {
                        driversWithMeta.push({
                            driverId,
                            distance: parseFloat(distance),
                            status: meta.status,
                            heading: meta.heading,
                            speed: meta.speed,
                            lastUpdate: meta.lastUpdate
                        });
                    }
                }
            }

            console.log(`✅ [LOCATION] ${driversWithMeta.length} available drivers found`);
            return driversWithMeta;
        } catch (error) {
            console.error('❌ [LOCATION] Error finding nearby drivers:', error.message);
            throw error;
        }
    }

    async getDriverLocation(driverId) {
        try {
            const position = await redisClient.geopos(
                REDIS_KEYS.DRIVERS_GEO,
                driverId
            );

            if (!position || !position[0]) {
                console.log(`⚠️ [LOCATION] Driver ${driverId} location not found`);
                return null;
            }

            const [lng, lat] = position[0];
            const metadata = await redisHelpers.getJson(REDIS_KEYS.DRIVER_META(driverId));

            return {
                driverId,
                lng: parseFloat(lng),
                lat: parseFloat(lat),
                ...metadata
            };
        } catch (error) {
            console.error('❌ [LOCATION] Error getting driver location:', error.message);
            throw error;
        }
    }

    calculateDistance(lat1, lng1, lat2, lng2) {
        const R = 6371;
        const dLat = this._toRad(lat2 - lat1);
        const dLng = this._toRad(lng2 - lng1);

        const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(this._toRad(lat1)) *
            Math.cos(this._toRad(lat2)) *
            Math.sin(dLng / 2) *
            Math.sin(dLng / 2);

        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    async getAllOnlineDrivers() {
        try {
            const allDriverIds = await redisClient.zrange(REDIS_KEYS.DRIVERS_GEO, 0, -1);
            const onlineDrivers = [];

            for (const driverId of allDriverIds) {
                const driver = await this.getDriverLocation(driverId);
                if (driver && driver.status === 'online') {
                    onlineDrivers.push(driver);
                }
            }

            console.log(`📊 [LOCATION] Total online drivers: ${onlineDrivers.length}`);
            return onlineDrivers;
        } catch (error) {
            console.error('❌ [LOCATION] Error getting all online drivers:', error.message);
            throw error;
        }
    }

    async updateDriverStatus(driverId, status, currentTripId = null) {
        try {
            console.log(`🔄 [LOCATION] Updating driver ${driverId} status to: ${status}`);

            const metaKey = REDIS_KEYS.DRIVER_META(driverId);
            const metadata = await redisHelpers.getJson(metaKey);

            if (!metadata) {
                throw new Error('Driver metadata not found. Driver might be offline.');
            }

            metadata.status = status;
            metadata.currentTripId = currentTripId;
            metadata.lastUpdate = Date.now();

            await redisHelpers.setJson(metaKey, metadata, 3600);

            if (status === 'offline') {
                await this.removeDriverLocation(driverId);
            }

            console.log(`✅ [LOCATION] Driver ${driverId} status updated to ${status}`);
            return { success: true, driverId, status };
        } catch (error) {
            console.error('❌ [LOCATION] Error updating driver status:', error.message);
            throw error;
        }
    }

    async cleanupStaleDrivers(maxAgeMinutes = 10) {
        try {
            console.log('🧹 [LOCATION] Cleaning up stale drivers...');

            const allDriverIds = await redisClient.zrange(REDIS_KEYS.DRIVERS_GEO, 0, -1);
            const staleDrivers = [];
            const now = Date.now();
            const maxAge = maxAgeMinutes * 60 * 1000;

            for (const driverId of allDriverIds) {
                const metadata = await redisHelpers.getJson(REDIS_KEYS.DRIVER_META(driverId));

                if (metadata && (now - metadata.lastUpdate) > maxAge) {
                    await this.removeDriverLocation(driverId);
                    staleDrivers.push(driverId);
                }
            }

            console.log(`🧹 [LOCATION] Cleaned up ${staleDrivers.length} stale drivers`);
            return staleDrivers;
        } catch (error) {
            console.error('❌ [LOCATION] Error cleaning up stale drivers:', error.message);
            throw error;
        }
    }

    _isValidCoordinate(lng, lat) {
        return (
            typeof lng === 'number' &&
            typeof lat === 'number' &&
            lng >= -180 && lng <= 180 &&
            lat >= -90 && lat <= 90
        );
    }

    _toRad(degrees) {
        return degrees * (Math.PI / 180);
    }
}

module.exports = new LocationService();