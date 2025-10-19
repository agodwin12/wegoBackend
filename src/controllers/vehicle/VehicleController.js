// src/controllers/vehicle/VehicleController.js
const Joi = require('joi');
const { Vehicle, Driver, DriverProfile, DriverDocument } = require('../../models'); // adjust if your index exports differ
const sequelize = require('../../config/database');

const TAG = 'VehicleController';
const log = (msg, data) => console.log(`[${new Date().toISOString()}] [${TAG}] ${msg}`, data ?? {});

/**
 * Validation schemas
 */
const createVehicleSchema = Joi.object({
    plate: Joi.string().max(24).required(),
    makeModel: Joi.string().max(64).allow('', null),
    color: Joi.string().max(32).allow('', null),
    seats: Joi.number().integer().min(1).max(12).default(4),
});

const updateVehicleSchema = Joi.object({
    plate: Joi.string().max(24).optional(),
    makeModel: Joi.string().max(64).optional().allow('', null),
    color: Joi.string().max(32).optional().allow('', null),
    seats: Joi.number().integer().min(1).max(12).optional(),
});

/**
 * createVehicle
 * POST /api/vehicles
 * Body: { plate, makeModel, color, seats }
 * - Admin/Driver registration can use this endpoint. Caller must ensure proper auth/authorization.
 */
async function createVehicle(req, res) {
    try {
        const { error, value } = createVehicleSchema.validate(req.body);
        if (error) return res.status(400).json({ error: 'INVALID_PAYLOAD', details: error.details });

        // create id yourself or let DB do it (assuming string id required)
        const id = value.id || require('crypto').randomUUID();

        const vehicle = await Vehicle.create({
            id,
            plate: value.plate,
            makeModel: value.makeModel || null,
            color: value.color || null,
            seats: value.seats,
        });

        log('vehicle.created', { vehicleId: vehicle.id, plate: vehicle.plate });
        return res.status(201).json(vehicle);
    } catch (err) {
        console.error(`[${TAG}] createVehicle failed`, err);
        return res.status(500).json({ error: 'FAILED_TO_CREATE_VEHICLE' });
    }
}

/**
 * updateVehicle
 * PUT /api/vehicles/:vehicleId
 * Body: any updatable fields
 */
async function updateVehicle(req, res) {
    try {
        const vehicleId = req.params.vehicleId;
        const { error, value } = updateVehicleSchema.validate(req.body);
        if (error) return res.status(400).json({ error: 'INVALID_PAYLOAD', details: error.details });

        const vehicle = await Vehicle.findByPk(vehicleId);
        if (!vehicle) return res.status(404).json({ error: 'VEHICLE_NOT_FOUND' });

        await vehicle.update(value);

        log('vehicle.updated', { vehicleId: vehicle.id });
        return res.json(vehicle);
    } catch (err) {
        console.error(`[${TAG}] updateVehicle failed`, err);
        return res.status(500).json({ error: 'FAILED_TO_UPDATE_VEHICLE' });
    }
}

/**
 * getVehicle
 * GET /api/vehicles/:vehicleId
 */
async function getVehicle(req, res) {
    try {
        const vehicleId = req.params.vehicleId;
        const vehicle = await Vehicle.findByPk(vehicleId);
        if (!vehicle) return res.status(404).json({ error: 'VEHICLE_NOT_FOUND' });
        return res.json(vehicle);
    } catch (err) {
        console.error(`[${TAG}] getVehicle failed`, err);
        return res.status(500).json({ error: 'FAILED_TO_FETCH_VEHICLE' });
    }
}

/**
 * listVehicles
 * GET /api/vehicles
 * Query params: page, limit, q (plate/makeModel)
 * - Intended for admin/dispatcher. Paginated.
 */
async function listVehicles(req, res) {
    try {
        const page = Math.max(1, parseInt(req.query.page || '1', 10));
        const limit = Math.min(100, Math.max(10, parseInt(req.query.limit || '25', 10)));
        const q = req.query.q ? String(req.query.q).trim() : null;

        const where = {};
        if (q) {
            // simple search on plate and makeModel
            where[sequelize.Op.or] = [
                { plate: { [sequelize.Op.iLike]: `%${q}%` } },
                { makeModel: { [sequelize.Op.iLike]: `%${q}%` } },
            ];
        }

        const offset = (page - 1) * limit;
        const { count, rows } = await Vehicle.findAndCountAll({
            where,
            limit,
            offset,
            order: [['plate', 'ASC']],
        });

        return res.json({
            total: count,
            page,
            limit,
            vehicles: rows,
        });
    } catch (err) {
        console.error(`[${TAG}] listVehicles failed`, err);
        return res.status(500).json({ error: 'FAILED_TO_LIST_VEHICLES' });
    }
}

/**
 * assignVehicleToDriver
 * POST /api/drivers/:driverId/vehicle/:vehicleId/assign
 * - Links a vehicle to a driver (sets driver.vehicleId and the DriverProfile vehicle_plate, vehicle_type)
 */
async function assignVehicleToDriver(req, res) {
    const t = await sequelize.transaction();
    try {
        const driverId = req.params.driverId; // this should be the Driver.id (or userId depending on your system)
        const vehicleId = req.params.vehicleId;

        const driver = await Driver.findByPk(driverId, { transaction: t });
        if (!driver) {
            await t.rollback();
            return res.status(404).json({ error: 'DRIVER_NOT_FOUND' });
        }

        const vehicle = await Vehicle.findByPk(vehicleId, { transaction: t });
        if (!vehicle) {
            await t.rollback();
            return res.status(404).json({ error: 'VEHICLE_NOT_FOUND' });
        }

        // assign
        driver.vehicleId = vehicle.id;
        await driver.save({ transaction: t });

        // also update driver profile if exists (optional)
        try {
            const profile = await DriverProfile.findOne({ where: { account_id: driver.userId }, transaction: t });
            if (profile) {
                profile.vehicle_plate = vehicle.plate;
                profile.vehicle_type = vehicle.makeModel;
                await profile.save({ transaction: t });
            }
        } catch (e) {
            // ignore profile update failures (non-critical)
            console.warn('[VehicleController] profile update failed', e.message);
        }

        await t.commit();

        // notify driver via socket/io if needed (controller level shouldn't directly access io; do it in route if you prefer)
        log('vehicle.assigned', { vehicleId, driverId });
        return res.json({ ok: true, driverId: driver.id, vehicleId: vehicle.id });
    } catch (err) {
        await t.rollback();
        console.error(`[${TAG}] assignVehicleToDriver failed`, err);
        return res.status(500).json({ error: 'FAILED_TO_ASSIGN_VEHICLE' });
    }
}

/**
 * unassignVehicleFromDriver
 * POST /api/drivers/:driverId/vehicle/unassign
 */
async function unassignVehicleFromDriver(req, res) {
    const t = await sequelize.transaction();
    try {
        const driverId = req.params.driverId;
        const driver = await Driver.findByPk(driverId, { transaction: t });
        if (!driver) {
            await t.rollback();
            return res.status(404).json({ error: 'DRIVER_NOT_FOUND' });
        }

        const previousVehicleId = driver.vehicleId;
        driver.vehicleId = null;
        await driver.save({ transaction: t });

        // clear profile vehicle fields if present
        try {
            const profile = await DriverProfile.findOne({ where: { account_id: driver.userId }, transaction: t });
            if (profile) {
                profile.vehicle_plate = null;
                profile.vehicle_type = null;
                await profile.save({ transaction: t });
            }
        } catch (e) {
            console.warn('[VehicleController] profile clear failed', e.message);
        }

        await t.commit();
        log('vehicle.unassigned', { driverId, previousVehicleId });
        return res.json({ ok: true, previousVehicleId });
    } catch (err) {
        await t.rollback();
        console.error(`[${TAG}] unassignVehicleFromDriver failed`, err);
        return res.status(500).json({ error: 'FAILED_TO_UNASSIGN_VEHICLE' });
    }
}

/**
 * uploadVehicleDocument
 * POST /api/drivers/:driverId/vehicle/:vehicleId/documents
 * Expects multipart/form-data with file under 'file' and doc_type in body.
 * NOTE: This controller assumes you have an upload middleware (multer/s3 middleware) that returns `req.file`
 */
async function uploadVehicleDocument(req, res) {
    try {
        const driverId = req.params.driverId;
        const vehicleId = req.params.vehicleId;
        const docType = req.body.doc_type; // e.g., 'INSURANCE' or 'REGISTRATION'
        const file = req.file; // requires multer or similar

        if (!file) return res.status(400).json({ error: 'MISSING_FILE' });
        if (!docType) return res.status(400).json({ error: 'MISSING_DOC_TYPE' });

        // derive fileUrl depending on storage (if multer with diskStorage you'll have file.path, if S3, file.location)
        const fileUrl = file.location || file.path || (file.filename ? `/uploads/${file.filename}` : null);
        if (!fileUrl) return res.status(500).json({ error: 'UNABLE_TO_RESOLVE_FILE_URL' });

        // create driver document record (assuming table driver_documents uses account_id)
        const driver = await Driver.findByPk(driverId);
        if (!driver) return res.status(404).json({ error: 'DRIVER_NOT_FOUND' });

        const doc = await DriverDocument.create({
            account_id: driver.userId, // use driver.userId (account id)
            doc_type: docType,
            file_url: fileUrl,
            number: req.body.number || null,
            issued_at: req.body.issued_at || null,
            expires_at: req.body.expires_at || null,
            status: 'PENDING',
        });

        log('vehicle.document.uploaded', { driverId, vehicleId, docId: doc.id });
        return res.status(201).json(doc);
    } catch (err) {
        console.error(`[${TAG}] uploadVehicleDocument failed`, err);
        return res.status(500).json({ error: 'FAILED_TO_UPLOAD_DOCUMENT' });
    }
}

/**
 * setVehicleVisibility (optional): toggle whether vehicle is visible in matching pool
 * POST /api/vehicles/:vehicleId/visibility
 * Body: { visible: true|false }
 */
async function setVehicleVisibility(req, res) {
    try {
        const vehicleId = req.params.vehicleId;
        const visible = req.body.visible === true || req.body.visible === 'true';

        const vehicle = await Vehicle.findByPk(vehicleId);
        if (!vehicle) return res.status(404).json({ error: 'VEHICLE_NOT_FOUND' });

        // If you have a visibility column add it; otherwise use a no-op
        if (vehicle.setDataValue) {
            vehicle.setDataValue('visible', visible); // dynamic field (won't persist unless column exists)
        }
        await vehicle.save();

        return res.json({ ok: true, visible });
    } catch (err) {
        console.error(`[${TAG}] setVehicleVisibility failed`, err);
        return res.status(500).json({ error: 'FAILED_TO_SET_VISIBILITY' });
    }
}

module.exports = {
    createVehicle,
    updateVehicle,
    getVehicle,
    listVehicles,
    assignVehicleToDriver,
    unassignVehicleFromDriver,
    uploadVehicleDocument,
    setVehicleVisibility,
};
