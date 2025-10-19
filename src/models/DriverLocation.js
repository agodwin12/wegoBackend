// src/models/DriverLocation.js

const { DataTypes, Model, Op } = require('sequelize');
const sequelize = require('../config/database');

class DriverLocation extends Model {}

DriverLocation.init(
    {
        id: {
            type: DataTypes.BIGINT.UNSIGNED,
            autoIncrement: true,
            primaryKey: true,
        },

        driver_id: {
            type: DataTypes.CHAR(36), // ✅ matches Account.uuid
            allowNull: false,
            unique: true,
            references: {
                model: 'accounts',
                key: 'uuid',
            },
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE',
        },

        lat: {
            type: DataTypes.DECIMAL(10, 7),
            allowNull: false,
            validate: { min: -90, max: 90 },
        },

        lng: {
            type: DataTypes.DECIMAL(10, 7),
            allowNull: false,
            validate: { min: -180, max: 180 },
        },

        heading: {
            type: DataTypes.FLOAT,
            defaultValue: 0,
            comment: 'Direction in degrees (0-360)',
        },

        speed: {
            type: DataTypes.FLOAT,
            defaultValue: 0,
            comment: 'Speed in km/h',
        },

        accuracy: {
            type: DataTypes.FLOAT,
            comment: 'GPS accuracy in meters',
        },

        battery_level: {
            type: DataTypes.INTEGER,
            allowNull: true,
            comment: 'Battery level percentage (0-100)',
            validate: { min: 0, max: 100 },
        },

        app_version: {
            type: DataTypes.STRING(20),
            allowNull: true,
            comment: 'Driver app version',
        },

        is_online: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false,
        },

        is_available: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: true,
            comment: 'False when driver has active trip',
        },

        last_updated: {
            type: DataTypes.DATE,
            defaultValue: DataTypes.NOW,
            allowNull: false,
        },
    },
    {
        sequelize,
        modelName: 'DriverLocation',
        tableName: 'driver_locations',
        timestamps: true,
        underscored: true,
        indexes: [
            { unique: true, fields: ['driver_id'], name: 'driver_locations_driver_id_unique' },
            { fields: ['is_online'], name: 'driver_locations_is_online_idx' },
            { fields: ['is_available'], name: 'driver_locations_is_available_idx' },
            { fields: ['is_online', 'is_available'], name: 'driver_locations_online_available_idx' },
            { fields: ['lat', 'lng'], name: 'driver_locations_coordinates_idx' },
            { fields: ['last_updated'], name: 'driver_locations_last_updated_idx' },
        ],
    }
);

// ═══════════════════════════════════════════════════════════════════════
// INSTANCE METHODS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Check if driver is active (online and updated recently)
 */
DriverLocation.prototype.isActive = function () {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    return this.is_online && this.last_updated > fiveMinutesAgo;
};

/**
 * Get coordinates as object
 */
DriverLocation.prototype.getCoordinates = function () {
    return {
        lat: parseFloat(this.lat),
        lng: parseFloat(this.lng),
    };
};

// ═══════════════════════════════════════════════════════════════════════
// STATIC METHODS - CALLED BY SOCKET HANDLERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Upsert driver location (create or update)
 * Called by: driver.socket.js -> 'driver:location' event
 */
DriverLocation.upsertLocation = async function (driverId, locationData) {
    const { lat, lng, heading, speed, accuracy, battery_level, app_version } = locationData;

    console.log('📍 [DRIVER-LOCATION] Upserting location for driver:', driverId);

    const [location, created] = await this.findOrCreate({
        where: { driver_id: driverId },
        defaults: {
            driver_id: driverId,
            lat,
            lng,
            heading: heading || 0,
            speed: speed || 0,
            accuracy,
            battery_level,
            app_version,
            last_updated: new Date(),
        },
    });

    if (!created) {
        // Update existing record
        await location.update({
            lat,
            lng,
            heading: heading !== undefined ? heading : location.heading,
            speed: speed !== undefined ? speed : location.speed,
            accuracy: accuracy !== undefined ? accuracy : location.accuracy,
            battery_level: battery_level !== undefined ? battery_level : location.battery_level,
            app_version: app_version || location.app_version,
            last_updated: new Date(),
        });
    }

    console.log(`✅ [DRIVER-LOCATION] Location ${created ? 'created' : 'updated'}`);
    return location;
};

/**
 * Set driver as online
 * Called by: driver.socket.js -> 'driver:online' event
 */
DriverLocation.setOnline = async function (driverId) {
    console.log('🟢 [DRIVER-LOCATION] Setting driver online:', driverId);

    const [location, created] = await this.findOrCreate({
        where: { driver_id: driverId },
        defaults: {
            driver_id: driverId,
            lat: 0,
            lng: 0,
            is_online: true,
            is_available: true,
            last_updated: new Date(),
        },
    });

    if (!created) {
        await location.update({
            is_online: true,
            is_available: true,
            last_updated: new Date(),
        });
    }

    console.log('✅ [DRIVER-LOCATION] Driver is now online');
    return location;
};

/**
 * Set driver as offline
 * Called by: driver.socket.js -> 'driver:offline' event
 */
DriverLocation.setOffline = async function (driverId) {
    console.log('🔴 [DRIVER-LOCATION] Setting driver offline:', driverId);

    const result = await this.update(
        {
            is_online: false,
            is_available: false,
            last_updated: new Date(),
        },
        { where: { driver_id: driverId } }
    );

    console.log('✅ [DRIVER-LOCATION] Driver is now offline');
    return result;
};

/**
 * Find all online and available drivers
 */
DriverLocation.findOnlineDrivers = async function () {
    return await this.findAll({
        where: {
            is_online: true,
            is_available: true,
        },
        order: [['last_updated', 'DESC']],
    });
};

/**
 * Mark driver as offline (alias for backward compatibility)
 */
DriverLocation.markDriverOffline = async function (driverId) {
    return await this.setOffline(driverId);
};

/**
 * Mark driver as unavailable (has active trip)
 */
DriverLocation.markDriverUnavailable = async function (driverId) {
    console.log('🚫 [DRIVER-LOCATION] Marking driver unavailable:', driverId);

    return await this.update(
        { is_available: false },
        { where: { driver_id: driverId } }
    );
};

/**
 * Mark driver as available (trip completed/canceled)
 */
DriverLocation.markDriverAvailable = async function (driverId) {
    console.log('✅ [DRIVER-LOCATION] Marking driver available:', driverId);

    return await this.update(
        { is_available: true },
        { where: { driver_id: driverId, is_online: true } }
    );
};

/**
 * Get driver location by driver ID
 */
DriverLocation.getDriverLocation = async function (driverId) {
    return await this.findOne({
        where: { driver_id: driverId },
    });
};

/**
 * Clean up stale locations (drivers offline for > 1 hour)
 * Run this periodically with a cron job
 */
DriverLocation.cleanupStaleLocations = async function () {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    console.log('🧹 [DRIVER-LOCATION] Cleaning up stale locations...');

    const result = await this.update(
        { is_online: false, is_available: false },
        {
            where: {
                is_online: true,
                last_updated: { [Op.lt]: oneHourAgo },
            },
        }
    );

    console.log(`✅ [DRIVER-LOCATION] Cleaned up ${result[0]} stale locations`);
    return result;
};

/**
 * Get nearby drivers within radius (requires PostGIS or manual calculation)
 * This is a simplified version - for production use PostGIS
 */
DriverLocation.findNearbyDrivers = async function (lat, lng, radiusKm = 5) {
    console.log(`🔍 [DRIVER-LOCATION] Finding drivers within ${radiusKm}km of`, lat, lng);

    // Get all online and available drivers
    const drivers = await this.findAll({
        where: {
            is_online: true,
            is_available: true,
        },
    });

    // Calculate distance for each driver
    const driversWithDistance = drivers.map(driver => {
        const distance = this.calculateDistance(
            lat,
            lng,
            parseFloat(driver.lat),
            parseFloat(driver.lng)
        );

        return {
            ...driver.toJSON(),
            distance,
        };
    });

    // Filter by radius and sort by distance
    const nearbyDrivers = driversWithDistance
        .filter(driver => driver.distance <= radiusKm)
        .sort((a, b) => a.distance - b.distance);

    console.log(`✅ [DRIVER-LOCATION] Found ${nearbyDrivers.length} drivers nearby`);
    return nearbyDrivers;
};

/**
 * Calculate distance between two coordinates (Haversine formula)
 */
DriverLocation.calculateDistance = function (lat1, lon1, lat2, lon2) {
    const R = 6371; // Radius of Earth in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;

    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c;

    return distance;
};

module.exports = DriverLocation;