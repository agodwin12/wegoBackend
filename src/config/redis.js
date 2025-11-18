// src/config/redis.js

const Redis = require('ioredis');

// ═══════════════════════════════════════════════════════════════════════
// REDIS CLIENT CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════

const redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB) || 0,
    retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
    },
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
});

redis.on('connect', () => {
    console.log('✅ [REDIS] Connected successfully');
});

redis.on('error', (err) => {
    console.error('❌ [REDIS] Connection error:', err.message);
});

redis.on('reconnecting', () => {
    console.log('🔄 [REDIS] Reconnecting...');
});

// ═══════════════════════════════════════════════════════════════════════
// REDIS KEY PATTERNS
// ═══════════════════════════════════════════════════════════════════════

const REDIS_KEYS = {
    // User/Driver keys
    DRIVER_META: (driverId) => `driver:${driverId}:metadata`,
    USER_SOCKET: (userId) => `user:socket:${userId}`,
    DRIVER_ONLINE: (driverId) => `driver:online:${driverId}`,
    DRIVER_LOCATION: (driverId) => `driver:location:${driverId}`,
    DRIVER_STATUS: (driverId) => `driver:status:${driverId}`,

    // Trip keys
    TRIP: (tripId) => `trip:${tripId}`,
    TRIP_LOCK: (tripId) => `trip:lock:${tripId}`,
    TRIP_DRIVER: (tripId) => `trip:${tripId}:driver`,
    TRIP_PASSENGER: (tripId) => `trip:${tripId}:passenger`,
    TRIP_OFFERS: (tripId) => `trip:${tripId}:offers`,
    TRIP_DECLINED: (tripId) => `trip:${tripId}:declined`,
    ACTIVE_TRIP: (tripId) => `trip:${tripId}`,
    ACTIVE_TRIP_BY_DRIVER: (driverId) => `driver:${driverId}:active_trip`,
    ACTIVE_TRIP_BY_PASSENGER: (passengerId) => `passenger:${passengerId}:active_trip`,

    // Geospatial keys
    DRIVERS_GEO: 'drivers:geo:locations',
    ONLINE_DRIVERS: 'drivers:online',
    AVAILABLE_DRIVERS: 'drivers:available',

    // Session keys
    SESSION: (sessionId) => `session:${sessionId}`,
    REFRESH_TOKEN: (token) => `refresh:${token}`,
};

// ═══════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

async function setJson(key, data, expirationSeconds = null) {
    try {
        const jsonData = JSON.stringify(data);
        if (expirationSeconds) {
            await redis.setex(key, expirationSeconds, jsonData);
        } else {
            await redis.set(key, jsonData);
        }
        console.log(`💾 [REDIS] JSON stored: ${key}`);
        return true;
    } catch (error) {
        console.error('❌ [REDIS] Error storing JSON:', error);
        return false;
    }
}

async function getJson(key) {
    try {
        const data = await redis.get(key);
        return data ? JSON.parse(data) : null;
    } catch (error) {
        console.error('❌ [REDIS] Error getting JSON:', error);
        return null;
    }
}

async function deleteKey(key) {
    try {
        await redis.del(key);
        console.log(`🗑️ [REDIS] Key deleted: ${key}`);
        return true;
    } catch (error) {
        console.error('❌ [REDIS] Error deleting key:', error);
        return false;
    }
}

/**
 * Store driver location in Redis (Geospatial)
 */
async function setDriverLocation(driverId, lat, lng, data = {}) {
    try {
        const multi = redis.multi();

        // Store in geospatial index
        multi.geoadd(REDIS_KEYS.DRIVERS_GEO, lng, lat, driverId);

        // Store detailed location data
        multi.hset(REDIS_KEYS.DRIVER_LOCATION(driverId), {
            lat: lat.toString(),
            lng: lng.toString(),
            heading: data.heading?.toString() || '0',
            speed: data.speed?.toString() || '0',
            accuracy: data.accuracy?.toString() || '0',
            timestamp: Date.now().toString(),
        });

        // Set expiration (5 minutes)
        multi.expire(REDIS_KEYS.DRIVER_LOCATION(driverId), 300);

        await multi.exec();

        console.log(`📍 [REDIS] Driver location stored: ${driverId} (${lat}, ${lng})`);
        return true;
    } catch (error) {
        console.error('❌ [REDIS] Error storing driver location:', error);
        return false;
    }
}

/**
 * Get driver location from Redis
 */
async function getDriverLocation(driverId) {
    try {
        const location = await redis.hgetall(REDIS_KEYS.DRIVER_LOCATION(driverId));

        if (!location || !location.lat || !location.lng) {
            return null;
        }

        return {
            lat: parseFloat(location.lat),
            lng: parseFloat(location.lng),
            heading: parseFloat(location.heading || 0),
            speed: parseFloat(location.speed || 0),
            accuracy: parseFloat(location.accuracy || 0),
            timestamp: parseInt(location.timestamp || Date.now()),
        };
    } catch (error) {
        console.error('❌ [REDIS] Error getting driver location:', error);
        return null;
    }
}

/**
 * Find nearby drivers using geospatial search
 */
async function findNearbyDrivers(lat, lng, radiusKm = 5) {
    try {
        console.log(`🔍 [REDIS] Searching for drivers within ${radiusKm}km of (${lat}, ${lng})`);

        // Search within radius (GEORADIUS returns array of driver IDs)
        const nearbyDrivers = await redis.georadius(
            REDIS_KEYS.DRIVERS_GEO,
            lng,
            lat,
            radiusKm,
            'km',
            'WITHDIST',
            'ASC' // Closest first
        );

        console.log(`✅ [REDIS] Found ${nearbyDrivers.length} nearby drivers`);

        // Format results
        const results = nearbyDrivers.map(([driverId, distance]) => ({
            driverId,
            distance: parseFloat(distance),
        }));

        // Filter out unavailable drivers
        const availableDrivers = [];
        for (const driver of results) {
            const isOnline = await redis.sismember(REDIS_KEYS.ONLINE_DRIVERS, driver.driverId);
            const isAvailable = await redis.sismember(REDIS_KEYS.AVAILABLE_DRIVERS, driver.driverId);

            if (isOnline && isAvailable) {
                availableDrivers.push(driver);
            }
        }

        console.log(`✅ [REDIS] ${availableDrivers.length} available drivers after filtering`);

        return availableDrivers;
    } catch (error) {
        console.error('❌ [REDIS] Error finding nearby drivers:', error);
        return [];
    }
}

/**
 * Mark driver as online
 */
async function setDriverOnline(driverId) {
    try {
        await redis.sadd(REDIS_KEYS.ONLINE_DRIVERS, driverId);
        await redis.sadd(REDIS_KEYS.AVAILABLE_DRIVERS, driverId);

        // Store online status with expiration
        await redis.setex(REDIS_KEYS.DRIVER_ONLINE(driverId), 3600, '1');

        console.log(`🟢 [REDIS] Driver marked online: ${driverId}`);
        return true;
    } catch (error) {
        console.error('❌ [REDIS] Error setting driver online:', error);
        return false;
    }
}

/**
 * Mark driver as offline
 */
async function setDriverOffline(driverId) {
    try {
        const multi = redis.multi();

        // Remove from online and available sets
        multi.srem(REDIS_KEYS.ONLINE_DRIVERS, driverId);
        multi.srem(REDIS_KEYS.AVAILABLE_DRIVERS, driverId);

        // Remove from geospatial index
        multi.zrem(REDIS_KEYS.DRIVERS_GEO, driverId);

        // Delete keys
        multi.del(REDIS_KEYS.DRIVER_ONLINE(driverId));
        multi.del(REDIS_KEYS.DRIVER_LOCATION(driverId));

        await multi.exec();

        console.log(`🔴 [REDIS] Driver marked offline: ${driverId}`);
        return true;
    } catch (error) {
        console.error('❌ [REDIS] Error setting driver offline:', error);
        return false;
    }
}

/**
 * Mark driver as unavailable (has active trip)
 */
async function setDriverUnavailable(driverId) {
    try {
        await redis.srem(REDIS_KEYS.AVAILABLE_DRIVERS, driverId);
        console.log(`⚠️ [REDIS] Driver marked unavailable: ${driverId}`);
        return true;
    } catch (error) {
        console.error('❌ [REDIS] Error setting driver unavailable:', error);
        return false;
    }
}

/**
 * Mark driver as available (trip completed)
 */
async function setDriverAvailable(driverId) {
    try {
        const isOnline = await redis.sismember(REDIS_KEYS.ONLINE_DRIVERS, driverId);

        if (isOnline) {
            await redis.sadd(REDIS_KEYS.AVAILABLE_DRIVERS, driverId);
            console.log(`✅ [REDIS] Driver marked available: ${driverId}`);
            return true;
        } else {
            console.log(`⚠️ [REDIS] Cannot mark offline driver as available: ${driverId}`);
            return false;
        }
    } catch (error) {
        console.error('❌ [REDIS] Error setting driver available:', error);
        return false;
    }
}

/**
 * Check if driver is online
 */
async function isDriverOnline(driverId) {
    try {
        return await redis.sismember(REDIS_KEYS.ONLINE_DRIVERS, driverId);
    } catch (error) {
        console.error('❌ [REDIS] Error checking driver online status:', error);
        return false;
    }
}

/**
 * Check if driver is available
 */
async function isDriverAvailable(driverId) {
    try {
        return await redis.sismember(REDIS_KEYS.AVAILABLE_DRIVERS, driverId);
    } catch (error) {
        console.error('❌ [REDIS] Error checking driver availability:', error);
        return false;
    }
}

/**
 * Get all online drivers count
 */
async function getOnlineDriversCount() {
    try {
        return await redis.scard(REDIS_KEYS.ONLINE_DRIVERS);
    } catch (error) {
        console.error('❌ [REDIS] Error getting online drivers count:', error);
        return 0;
    }
}

/**
 * Store trip in Redis
 */
async function storeTripInRedis(tripId, tripData, expirationSeconds = 3600) {
    try {
        await redis.setex(
            REDIS_KEYS.TRIP(tripId),
            expirationSeconds,
            JSON.stringify(tripData)
        );

        console.log(`💾 [REDIS] Trip stored: ${tripId}`);
        return true;
    } catch (error) {
        console.error('❌ [REDIS] Error storing trip:', error);
        return false;
    }
}

/**
 * Get trip from Redis
 */
async function getTripFromRedis(tripId) {
    try {
        const data = await redis.get(REDIS_KEYS.TRIP(tripId));
        return data ? JSON.parse(data) : null;
    } catch (error) {
        console.error('❌ [REDIS] Error getting trip:', error);
        return null;
    }
}

/**
 * Acquire lock (atomic operation to prevent race conditions)
 */
async function acquireLock(key, value, expirationSeconds = 10) {
    try {
        const result = await redis.set(key, value, 'NX', 'EX', expirationSeconds);
        return result === 'OK';
    } catch (error) {
        console.error('❌ [REDIS] Error acquiring lock:', error);
        return false;
    }
}

/**
 * Release lock
 */
async function releaseLock(key) {
    try {
        await redis.del(key);
        return true;
    } catch (error) {
        console.error('❌ [REDIS] Error releasing lock:', error);
        return false;
    }
}

/**
 * Store user socket ID
 */
async function storeUserSocket(userId, socketId) {
    try {
        await redis.setex(REDIS_KEYS.USER_SOCKET(userId), 3600, socketId);
        console.log(`🔌 [REDIS] User socket stored: ${userId} -> ${socketId}`);
        return true;
    } catch (error) {
        console.error('❌ [REDIS] Error storing user socket:', error);
        return false;
    }
}

/**
 * Get user socket ID
 */
async function getUserSocket(userId) {
    try {
        return await redis.get(REDIS_KEYS.USER_SOCKET(userId));
    } catch (error) {
        console.error('❌ [REDIS] Error getting user socket:', error);
        return null;
    }
}

/**
 * Remove user socket
 */
async function removeUserSocket(userId) {
    try {
        await redis.del(REDIS_KEYS.USER_SOCKET(userId));
        console.log(`🔌 [REDIS] User socket removed: ${userId}`);
        return true;
    } catch (error) {
        console.error('❌ [REDIS] Error removing user socket:', error);
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════
const redisHelpers = {
    setJson,
    getJson,
    deleteKey,
};


module.exports = {
    redis,
    redisClient: redis,  // ← Add this alias
    redisHelpers,        // ← Add this object
    REDIS_KEYS,

    // Driver location functions
    setDriverLocation,
    getDriverLocation,
    findNearbyDrivers,

    // Driver status functions
    setDriverOnline,
    setDriverOffline,
    setDriverUnavailable,
    setDriverAvailable,
    isDriverOnline,
    isDriverAvailable,
    getOnlineDriversCount,

    // Trip functions
    storeTripInRedis,
    getTripFromRedis,

    // Lock functions
    acquireLock,
    releaseLock,

    // Socket functions
    storeUserSocket,
    getUserSocket,
    removeUserSocket,
};