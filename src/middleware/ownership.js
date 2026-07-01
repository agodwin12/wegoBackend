'use strict';

// ═══════════════════════════════════════════════════════════════════════
// requireOwnership — reusable resource-ownership (IDOR) guard.
// ───────────────────────────────────────────────────────────────────────
// Loads the resource named by an :id route param and verifies the
// authenticated caller (req.user.uuid) owns it via one of the owner fields.
//   404 if the resource doesn't exist, 403 if the caller isn't an owner.
// On success the loaded row is attached to req[as] so the handler can reuse it.
//
// Example (a trip is owned by its passenger OR its assigned driver):
//   router.get('/:tripId',
//     authenticate,
//     requireOwnership(Trip, { idParam: 'tripId', ownerFields: ['passengerId', 'driverId'] }),
//     ctrl.getTripDetails);
// ═══════════════════════════════════════════════════════════════════════

function requireOwnership(model, opts = {}) {
    const {
        idParam     = 'id',
        ownerFields = ['userId'],
        as          = 'resource',
    } = opts;

    return async function ownershipGuard(req, res, next) {
        try {
            const id = req.params[idParam];
            if (!id) {
                return res.status(400).json({ success: false, error: `Missing ${idParam}` });
            }

            const row = await model.findByPk(id);
            if (!row) {
                return res.status(404).json({ success: false, error: 'Not found' });
            }

            const callerId = req.user && (req.user.uuid || req.user.id);
            const isOwner  = ownerFields.some(
                (f) => row[f] != null && String(row[f]) === String(callerId)
            );

            if (!isOwner) {
                return res.status(403).json({ success: false, error: 'Forbidden' });
            }

            req[as] = row;
            next();
        } catch (err) {
            next(err);
        }
    };
}

module.exports = { requireOwnership };
