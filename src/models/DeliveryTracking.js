'use strict';

const { Model, DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    class DeliveryTracking extends Model {
        static associate(models) {
            DeliveryTracking.belongsTo(models.Delivery, {
                foreignKey: 'delivery_id',
                as: 'delivery',
            });

            // driver_id → drivers.id (STRING 36)
            DeliveryTracking.belongsTo(models.Driver, {
                foreignKey: 'driver_id',
                targetKey: 'id',
                as: 'driver',
            });
        }

        /**
         * Record a location update — called by Socket.IO on every driver ping
         * Discards readings with GPS accuracy worse than 100 meters
         */
        static async record({ deliveryId, driverId, latitude, longitude, bearing, speedKmh, accuracyMeters, phase }) {
            if (accuracyMeters && accuracyMeters > 100) {
                debugPrint(`⚠️ [TRACKING] Discarding inaccurate point: accuracy=${accuracyMeters}m`);
                return null;
            }

            return DeliveryTracking.create({
                delivery_id: deliveryId,
                driver_id: driverId,       // STRING(36)
                latitude,
                longitude,
                bearing: bearing || null,
                speed_kmh: speedKmh || null,
                accuracy_meters: accuracyMeters || null,
                phase,
                recorded_at: new Date(),
            });
        }

        /**
         * Get latest driver position for live map
         */
        static async getLatestPosition(deliveryId) {
            return DeliveryTracking.findOne({
                where: { delivery_id: deliveryId },
                order: [['recorded_at', 'DESC']],
                attributes: ['latitude', 'longitude', 'bearing', 'speed_kmh', 'phase', 'recorded_at'],
            });
        }

        /**
         * Get full route for playback or dispute investigation
         */
        static async getFullRoute(deliveryId, phase = null) {
            const where = { delivery_id: deliveryId };
            if (phase) where.phase = phase;

            return DeliveryTracking.findAll({
                where,
                order: [['recorded_at', 'ASC']],
                attributes: ['latitude', 'longitude', 'bearing', 'phase', 'recorded_at'],
            });
        }
    }

    DeliveryTracking.init(
        {
            id: {
                type: DataTypes.BIGINT,
                autoIncrement: true,
                primaryKey: true,
            },
            delivery_id: {
                type: DataTypes.INTEGER,
                allowNull: false,
            },
            // STRING(36) — matches drivers.id
            driver_id: {
                type: DataTypes.STRING(36),
                allowNull: false,
            },
            latitude: { type: DataTypes.DECIMAL(10, 8), allowNull: false },
            longitude: { type: DataTypes.DECIMAL(11, 8), allowNull: false },
            bearing: { type: DataTypes.DECIMAL(6, 3), allowNull: true },
            speed_kmh: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
            accuracy_meters: { type: DataTypes.DECIMAL(8, 2), allowNull: true },
            phase: {
                type: DataTypes.ENUM('en_route_pickup', 'en_route_dropoff'),
                allowNull: false,
            },
            recorded_at: {
                type: DataTypes.DATE,
                allowNull: false,
                defaultValue: DataTypes.NOW,
            },
        },
        {
            sequelize,
            modelName: 'DeliveryTracking',
            tableName: 'delivery_tracking',
            underscored: true,
            timestamps: false, // uses recorded_at instead
        }
    );

    return DeliveryTracking;
};