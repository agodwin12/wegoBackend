'use strict';

const { Model, DataTypes, Op } = require('sequelize');
const bcrypt = require('bcrypt');

// ─── Package category constants ───────────────────────────────────────────────
const PACKAGE_CATEGORIES = [
    'document',
    'food',
    'electronics',
    'clothing',
    'medicine',
    'fragile',
    'groceries',
    'other',
];

module.exports = (sequelize) => {
    class Delivery extends Model {
        static associate(models) {
            Delivery.belongsTo(models.Account, {
                foreignKey: 'sender_id',
                targetKey:  'uuid',
                as:         'sender',
            });
            Delivery.belongsTo(models.Driver, {
                foreignKey: 'driver_id',
                targetKey:  'id',
                as:         'driver',
            });
            Delivery.belongsTo(models.DeliveryPricing, {
                foreignKey: 'pricing_zone_id',
                as:         'pricingZone',
            });
            Delivery.belongsTo(models.DeliverySurgeRule, {
                foreignKey: 'surge_rule_id',
                as:         'surgeRule',
            });
            Delivery.hasMany(models.DeliveryTracking, {
                foreignKey: 'delivery_id',
                as:         'trackingPoints',
            });
            Delivery.hasOne(models.DeliveryDispute, {
                foreignKey: 'delivery_id',
                as:         'dispute',
            });
        }

        // ═══════════════════════════════════════════════════════════════════════
        // STATIC METHODS
        // ═══════════════════════════════════════════════════════════════════════

        // Expose categories so Flutter/backoffice can import the list
        static get PACKAGE_CATEGORIES() {
            return PACKAGE_CATEGORIES;
        }

        static async generateDeliveryCode() {
            const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            let attempts   = 0;
            while (attempts < 10) {
                const randomPart = String(Math.floor(Math.random() * 99999)).padStart(5, '0');
                const code       = `DLV-${datePart}-${randomPart}`;
                const existing   = await Delivery.findOne({ where: { delivery_code: code } });
                if (!existing) return code;
                attempts++;
            }
            return `DLV-${datePart}-${Date.now().toString().slice(-6)}`;
        }

        static async generateDeliveryPin() {
            const plain  = String(Math.floor(1000 + Math.random() * 9000));
            const hashed = await bcrypt.hash(plain, 10);
            return { plain, hashed };
        }

        static async verifyPin(delivery, enteredPin) {
            if (delivery.pin_verified_at) {
                return { success: false, message: 'PIN already verified for this delivery' };
            }
            if (delivery.pin_attempts >= 5) {
                return {
                    success: false,
                    message: 'Too many incorrect PIN attempts. Please contact support.',
                    locked:  true,
                };
            }

            const isCorrect = await bcrypt.compare(String(enteredPin), delivery.delivery_pin);
            if (!isCorrect) {
                await delivery.increment('pin_attempts');
                const remaining = 4 - delivery.pin_attempts;
                return {
                    success:      false,
                    message:      `Incorrect PIN. ${remaining >= 0 ? remaining : 0} attempts remaining.`,
                    attemptsUsed: delivery.pin_attempts + 1,
                };
            }

            await delivery.update({ pin_verified_at: new Date() });
            return { success: true, message: 'PIN verified successfully' };
        }

        static async getActiveForDriver(driverId) {
            return Delivery.findAll({
                where: {
                    driver_id: driverId,
                    status:    {
                        [Op.in]: ['accepted','en_route_pickup','arrived_pickup','picked_up','en_route_dropoff','arrived_dropoff'],
                    },
                },
                include: [{ association: 'sender', attributes: ['uuid','first_name','last_name','phone_e164','avatar_url'] }],
                order:   [['created_at', 'DESC']],
            });
        }

        static async getActiveForSender(senderUuid) {
            return Delivery.findAll({
                where: {
                    sender_id: senderUuid,
                    status:    {
                        [Op.in]: ['searching','accepted','en_route_pickup','arrived_pickup','picked_up','en_route_dropoff','arrived_dropoff'],
                    },
                },
                include: [{ association: 'driver', attributes: ['id','phone','rating','lat','lng','heading'] }],
                order:   [['created_at', 'DESC']],
            });
        }

        static async getAdminList({
                                      page = 1, limit = 20, status, paymentStatus,
                                      driverId, senderId, startDate, endDate, search,
                                  } = {}) {
            const offset = (page - 1) * limit;
            const where  = {};

            if (status)        where.status         = status;
            if (paymentStatus) where.payment_status = paymentStatus;
            if (driverId)      where.driver_id      = driverId;
            if (senderId)      where.sender_id      = senderId;

            if (startDate || endDate) {
                where.created_at = {};
                if (startDate) where.created_at[Op.gte] = new Date(startDate);
                if (endDate)   where.created_at[Op.lte] = new Date(endDate);
            }

            if (search) {
                where[Op.or] = [
                    { delivery_code:   { [Op.like]: `%${search}%` } },
                    { recipient_name:  { [Op.like]: `%${search}%` } },
                    { recipient_phone: { [Op.like]: `%${search}%` } },
                    { pickup_address:  { [Op.like]: `%${search}%` } },
                    { dropoff_address: { [Op.like]: `%${search}%` } },
                ];
            }

            const { count, rows } = await Delivery.findAndCountAll({
                where,
                include: [
                    { association: 'sender',     attributes: ['uuid','first_name','last_name','phone_e164'] },
                    { association: 'driver',     attributes: ['id','phone','rating'] },
                    { association: 'pricingZone',attributes: ['id','zone_name'] },
                    { association: 'surgeRule',  attributes: ['id','name','multiplier'] },
                ],
                order:  [['created_at', 'DESC']],
                limit:  parseInt(limit),
                offset,
            });

            return {
                deliveries: rows,
                pagination: {
                    total:      count,
                    page:       parseInt(page),
                    limit:      parseInt(limit),
                    totalPages: Math.ceil(count / limit),
                },
            };
        }

        // ═══════════════════════════════════════════════════════════════════════
        // INSTANCE METHODS
        // ═══════════════════════════════════════════════════════════════════════

        canTransitionTo(newStatus) {
            const transitions = {
                searching:        ['accepted', 'cancelled', 'expired'],
                accepted:         ['en_route_pickup', 'cancelled'],
                en_route_pickup:  ['arrived_pickup', 'cancelled'],
                arrived_pickup:   ['picked_up', 'cancelled'],
                picked_up:        ['en_route_dropoff', 'cancelled'],
                en_route_dropoff: ['arrived_dropoff', 'cancelled'],
                arrived_dropoff:  ['delivered', 'disputed'],
                delivered:        ['disputed'],
                cancelled:        [],
                disputed:         ['delivered', 'cancelled'],
                expired:          [],
            };
            return (transitions[this.status] || []).includes(newStatus);
        }

        async transitionTo(newStatus, extraFields = {}) {
            if (!this.canTransitionTo(newStatus)) {
                throw new Error(`Invalid status transition: ${this.status} → ${newStatus}`);
            }
            const timestampMap = {
                accepted:        { accepted_at: new Date() },
                arrived_pickup:  { arrived_pickup_at: new Date() },
                picked_up:       { picked_up_at: new Date() },
                arrived_dropoff: { arrived_dropoff_at: new Date() },
                delivered:       { delivered_at: new Date() },
                cancelled:       { cancelled_at: new Date() },
            };
            await this.update({ status: newStatus, ...(timestampMap[newStatus] || {}), ...extraFields });
            return this;
        }

        isTerminal() {
            return ['delivered', 'cancelled', 'expired'].includes(this.status);
        }

        isActive() {
            return [
                'accepted','en_route_pickup','arrived_pickup',
                'picked_up','en_route_dropoff','arrived_dropoff',
            ].includes(this.status);
        }

        // ✅ Updated to include package_category and package_photo_url
        toSocketPayload() {
            return {
                deliveryId:       this.id,
                deliveryCode:     this.delivery_code,
                status:           this.status,
                paymentStatus:    this.payment_status,
                paymentMethod:    this.payment_method,
                pickupAddress:    this.pickup_address,
                dropoffAddress:   this.dropoff_address,
                packageSize:      this.package_size,
                packageCategory:  this.package_category,   // ✅ NEW
                packagePhotoUrl:  this.package_photo_url,  // ✅ NEW
                totalPrice:       parseFloat(this.total_price),
                isSurging:        parseFloat(this.surge_multiplier_applied) > 1.00,
                surgeMultiplier:  parseFloat(this.surge_multiplier_applied),
                recipientName:    this.recipient_name,
                recipientPhone:   this.recipient_phone,
                updatedAt:        this.updated_at,
            };
        }
    }

    Delivery.init(
        {
            id:            { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            delivery_code: { type: DataTypes.STRING(30), allowNull: false, unique: true },

            sender_id: { type: DataTypes.CHAR(36),   allowNull: false },  // accounts.uuid
            driver_id: { type: DataTypes.STRING(36), allowNull: true  },  // drivers.id

            recipient_name: {
                type:      DataTypes.STRING(100),
                allowNull: false,
                validate: {
                    notEmpty: { msg: 'Recipient name is required' },
                    len:      { args: [2, 100], msg: 'Must be 2-100 chars' },
                },
            },
            recipient_phone: {
                type:      DataTypes.STRING(20),
                allowNull: false,
                validate: { notEmpty: { msg: 'Recipient phone is required' } },
            },
            recipient_note:   { type: DataTypes.STRING(500), allowNull: true },

            pickup_address:   { type: DataTypes.STRING(500), allowNull: false },
            pickup_latitude:  { type: DataTypes.DECIMAL(10, 8), allowNull: false },
            pickup_longitude: { type: DataTypes.DECIMAL(11, 8), allowNull: false },
            pickup_landmark:  { type: DataTypes.STRING(255), allowNull: true },

            dropoff_address:   { type: DataTypes.STRING(500), allowNull: false },
            dropoff_latitude:  { type: DataTypes.DECIMAL(10, 8), allowNull: false },
            dropoff_longitude: { type: DataTypes.DECIMAL(11, 8), allowNull: false },
            dropoff_landmark:  { type: DataTypes.STRING(255), allowNull: true },

            package_size: {
                type:      DataTypes.ENUM('small', 'medium', 'large'),
                allowNull: false,
                validate: {
                    isIn: { args: [['small','medium','large']], msg: 'Must be small, medium, or large' },
                },
            },

            // ✅ NEW — required, sender must choose before booking
            package_category: {
                type:         DataTypes.ENUM(...PACKAGE_CATEGORIES),
                allowNull:    false,
                defaultValue: 'other',
                validate: {
                    isIn: {
                        args: [PACKAGE_CATEGORIES],
                        msg:  `Must be one of: ${PACKAGE_CATEGORIES.join(', ')}`,
                    },
                },
            },

            package_description: { type: DataTypes.STRING(500), allowNull: true },

            // ✅ package_photo_url — already in DB, now enforced as required by controller
            package_photo_url: { type: DataTypes.STRING(1000), allowNull: true },
            pickup_photo_url:  { type: DataTypes.STRING(1000), allowNull: true },

            is_fragile:      { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            pricing_zone_id: { type: DataTypes.INTEGER, allowNull: true },

            distance_km:              { type: DataTypes.DECIMAL(8, 3),  allowNull: false },
            base_fee_applied:         { type: DataTypes.DECIMAL(10, 2), allowNull: false },
            per_km_rate_applied:      { type: DataTypes.DECIMAL(10, 2), allowNull: false },
            size_multiplier_applied:  { type: DataTypes.DECIMAL(4, 2),  allowNull: false, defaultValue: 1.00 },
            surge_multiplier_applied: { type: DataTypes.DECIMAL(4, 2),  allowNull: false, defaultValue: 1.00 },
            surge_rule_id:            { type: DataTypes.INTEGER, allowNull: true },

            subtotal:                      { type: DataTypes.DECIMAL(10, 2), allowNull: false },
            total_price:                   { type: DataTypes.DECIMAL(10, 2), allowNull: false },
            commission_percentage_applied: { type: DataTypes.DECIMAL(5, 2),  allowNull: false },
            commission_amount:             { type: DataTypes.DECIMAL(10, 2), allowNull: false },
            driver_payout:                 { type: DataTypes.DECIMAL(10, 2), allowNull: false },

            payment_method: {
                type:      DataTypes.ENUM('mtn_mobile_money', 'orange_money', 'cash'),
                allowNull: false,
            },
            payment_status: {
                type:         DataTypes.ENUM('pending','paid','cash_pending','cash_confirmed','refunded','failed'),
                allowNull:    false,
                defaultValue: 'pending',
            },
            payment_reference: { type: DataTypes.STRING(100), allowNull: true },
            paid_at:           { type: DataTypes.DATE, allowNull: true },

            delivery_pin:    { type: DataTypes.STRING(6), allowNull: true },
            pin_verified_at: { type: DataTypes.DATE, allowNull: true },
            pin_attempts:    { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

            status: {
                type: DataTypes.ENUM(
                    'searching','accepted','en_route_pickup','arrived_pickup',
                    'picked_up','en_route_dropoff','arrived_dropoff',
                    'delivered','cancelled','disputed','expired'
                ),
                allowNull:    false,
                defaultValue: 'searching',
            },
            cancelled_by:        { type: DataTypes.ENUM('sender','driver','admin'), allowNull: true },
            cancellation_reason: { type: DataTypes.STRING(500), allowNull: true },
            cancelled_at:        { type: DataTypes.DATE, allowNull: true },

            search_attempts:  { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
            search_radius_km: { type: DataTypes.DECIMAL(5, 2), allowNull: true },

            accepted_at:        { type: DataTypes.DATE, allowNull: true },
            arrived_pickup_at:  { type: DataTypes.DATE, allowNull: true },
            picked_up_at:       { type: DataTypes.DATE, allowNull: true },
            arrived_dropoff_at: { type: DataTypes.DATE, allowNull: true },
            delivered_at:       { type: DataTypes.DATE, allowNull: true },

            earnings_record_id: { type: DataTypes.INTEGER, allowNull: true },
            rating:             { type: DataTypes.DECIMAL(3, 2), allowNull: true },
            rating_comment:     { type: DataTypes.STRING(500), allowNull: true },
            rated_at:           { type: DataTypes.DATE, allowNull: true },
        },
        {
            sequelize,
            modelName:   'Delivery',
            tableName:   'deliveries',
            underscored: true,
            timestamps:  true,
        }
    );

    return Delivery;
};