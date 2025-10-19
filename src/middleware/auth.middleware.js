// src/middleware/auth.middleware.js
const { verifyAccessToken } = require('../utils/jwt');
const { Account } = require('../models');

async function authenticate(req, res, next) {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            console.log('❌ [AUTH] No token provided');
            const err = new Error('Authentication required');
            err.status = 401;
            throw err;
        }

        const token = authHeader.substring(7);
        console.log('🔐 [AUTH] Token received');

        const decoded = verifyAccessToken(token);
        if (!decoded) {
            console.log('❌ [AUTH] Invalid or expired token');
            const err = new Error('Invalid or expired token');
            err.status = 401;
            throw err;
        }

        console.log('✅ [AUTH] Token verified for user:', decoded.uuid);

        const account = await Account.findOne({ where: { uuid: decoded.uuid } });

        if (!account) {
            console.log('❌ [AUTH] Account not found');
            const err = new Error('Account not found');
            err.status = 401;
            throw err;
        }

        if (account.status === 'DELETED') {
            console.log('❌ [AUTH] Account deleted');
            const err = new Error('Account has been deleted');
            err.status = 403;
            throw err;
        }

        if (account.status === 'SUSPENDED') {
            console.log('⚠️ [AUTH] Account suspended');
            const err = new Error('Account has been suspended');
            err.status = 403;
            throw err;
        }

        console.log('✅ [AUTH] User authenticated:', account.uuid);
        req.user = account;
        next();
    } catch (err) {
        next(err);
    }
}

module.exports = {
    authenticate,
};