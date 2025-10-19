const { IdempotencyKey } = require('../models');

/**
 * Idempotency middleware
 * - Prevents duplicate requests for the same Idempotency-Key.
 * - Must be used **after auth**, because it relies on `req.user.id`.
 */
module.exports = function idempotency(resultFetcher) {
    return async (req, res, next) => {
        // Ensure the user is authenticated
        if (!req.user || !req.user.id) {
            return res.status(401).json({ error: 'Unauthorized: auth middleware required before idempotency' });
        }

        const key = req.header('Idempotency-Key');
        if (!key) return next(); // optional; skip idempotency if no key provided

        const userId = req.user.id;

        try {
            // Check if key already exists
            const existing = await IdempotencyKey.findByPk(key);
            if (existing && existing.userId === userId) {
                const out = await resultFetcher(existing); // e.g., load Trip and return same response
                return res.status(201).json(out);
            }

            // Attach helper for controller to save result later
            req._idempotency = {
                key,
                async save(resultType, resultId) {
                    try {
                        await IdempotencyKey.create({ key, userId, resultType, resultId });
                    } catch (_) {
                        // Ignore duplicate insert races
                    }
                },
            };

            next();
        } catch (err) {
            next(err);
        }
    };
};
