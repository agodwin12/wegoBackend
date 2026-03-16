'use strict';

const { Model, DataTypes, Op } = require('sequelize');

module.exports = (sequelize) => {
    class DeliveryDispute extends Model {
        static associate(models) {
            DeliveryDispute.belongsTo(models.Delivery, {
                foreignKey: 'delivery_id',
                as: 'delivery',
            });

            // filed_by_user_id → accounts.uuid (CHAR 36)
            DeliveryDispute.belongsTo(models.Account, {
                foreignKey: 'filed_by_user_id',
                targetKey: 'uuid',
                as: 'filedByUser',
            });

            // filed_by_driver_id → drivers.id (STRING 36)
            DeliveryDispute.belongsTo(models.Driver, {
                foreignKey: 'filed_by_driver_id',
                targetKey: 'id',
                as: 'filedByDriver',
            });

            DeliveryDispute.belongsTo(models.Employee, {
                foreignKey: 'assigned_to_employee_id',
                as: 'assignedTo',
            });
        }

        // ─── STATIC METHODS ────────────────────────────────────────────────────────

        static async generateDisputeCode() {
            const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            let attempts = 0;
            while (attempts < 10) {
                const randomPart = String(Math.floor(Math.random() * 99999)).padStart(5, '0');
                const code = `DDSP-${datePart}-${randomPart}`;
                const existing = await DeliveryDispute.findOne({ where: { dispute_code: code } });
                if (!existing) return code;
                attempts++;
            }
            return `DDSP-${datePart}-${Date.now().toString().slice(-6)}`;
        }

        static async getAdminList({ page = 1, limit = 20, status, priority, assignedTo, search } = {}) {
            const offset = (page - 1) * limit;
            const where = {};

            if (status) where.status = status;
            if (priority) where.priority = priority;
            if (assignedTo) where.assigned_to_employee_id = assignedTo;

            if (search) {
                where[Op.or] = [
                    { dispute_code: { [Op.like]: `%${search}%` } },
                    { description: { [Op.like]: `%${search}%` } },
                ];
            }

            const { count, rows } = await DeliveryDispute.findAndCountAll({
                where,
                include: [
                    { association: 'delivery', attributes: ['id','delivery_code','total_price','payment_method'] },
                    { association: 'filedByUser', attributes: ['uuid','first_name','last_name','phone_e164'] },
                    { association: 'filedByDriver', attributes: ['id','phone','rating'] },
                    { association: 'assignedTo', attributes: ['id','first_name','last_name'] },
                ],
                order: [
                    [sequelize.literal(`FIELD(priority, 'urgent', 'high', 'medium', 'low')`)],
                    ['created_at', 'DESC'],
                ],
                limit: parseInt(limit),
                offset,
            });

            return {
                disputes: rows,
                pagination: { total: count, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(count / limit) },
            };
        }

        // ─── INSTANCE METHODS ──────────────────────────────────────────────────────

        async assignTo(employeeId) {
            await this.update({ assigned_to_employee_id: employeeId, status: 'investigating' });
            debugPrint(`🔍 [DISPUTE] ${this.dispute_code} assigned to employee #${employeeId}`);
            return this;
        }

        async resolve({ resolutionType, resolutionNotes, refundAmount = 0, adminNotes }) {
            const validResolutions = [
                'full_refund','partial_refund','no_refund','redelivery',
                'mutual_agreement','driver_warning','driver_suspended','sender_warned','dismissed',
            ];
            if (!validResolutions.includes(resolutionType)) {
                throw new Error(`Invalid resolution type: ${resolutionType}`);
            }
            await this.update({
                resolution_type: resolutionType,
                resolution_notes: resolutionNotes,
                refund_amount: refundAmount,
                admin_notes: adminNotes || this.admin_notes,
                status: 'resolved',
                resolved_at: new Date(),
            });
            debugPrint(`✅ [DISPUTE] ${this.dispute_code} resolved: ${resolutionType}`);
            return this;
        }

        async close() {
            await this.update({ status: 'closed', closed_at: new Date() });
            return this;
        }

        isOpen() {
            return ['open', 'investigating', 'awaiting_response'].includes(this.status);
        }
    }

    DeliveryDispute.init(
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
            dispute_code: { type: DataTypes.STRING(30), allowNull: false, unique: true },
            delivery_id: { type: DataTypes.INTEGER, allowNull: false },

            // CHAR(36) — matches accounts.uuid
            filed_by_user_id: { type: DataTypes.CHAR(36), allowNull: true },

            // STRING(36) — matches drivers.id
            filed_by_driver_id: { type: DataTypes.STRING(36), allowNull: true },

            assigned_to_employee_id: { type: DataTypes.INTEGER, allowNull: true },
            dispute_type: {
                type: DataTypes.ENUM(
                    'package_not_delivered','package_damaged','wrong_item_delivered',
                    'payment_issue','driver_behaviour','sender_behaviour',
                    'pin_issue','overcharge','other'
                ),
                allowNull: false,
            },
            description: {
                type: DataTypes.TEXT, allowNull: false,
                validate: { len: { args: [20, 5000], msg: 'Description must be 20-5000 characters' } },
            },
            evidence_urls: { type: DataTypes.JSON, allowNull: true },
            response_description: { type: DataTypes.TEXT, allowNull: true },
            response_evidence_urls: { type: DataTypes.JSON, allowNull: true },
            responded_at: { type: DataTypes.DATE, allowNull: true },
            admin_notes: { type: DataTypes.TEXT, allowNull: true },
            resolution_type: {
                type: DataTypes.ENUM(
                    'full_refund','partial_refund','no_refund','redelivery',
                    'mutual_agreement','driver_warning','driver_suspended','sender_warned','dismissed'
                ),
                allowNull: true,
            },
            resolution_notes: { type: DataTypes.TEXT, allowNull: true },
            refund_amount: { type: DataTypes.DECIMAL(10, 2), allowNull: true, defaultValue: 0.00 },
            status: {
                type: DataTypes.ENUM('open','investigating','awaiting_response','resolved','closed'),
                allowNull: false, defaultValue: 'open',
            },
            priority: {
                type: DataTypes.ENUM('low','medium','high','urgent'),
                allowNull: false, defaultValue: 'medium',
            },
            resolved_at: { type: DataTypes.DATE, allowNull: true },
            closed_at: { type: DataTypes.DATE, allowNull: true },
        },
        {
            sequelize,
            modelName: 'DeliveryDispute',
            tableName: 'delivery_disputes',
            underscored: true,
            timestamps: true,
        }
    );

    return DeliveryDispute;
};