// src/services/driverModeState.service.js
//
// ═══════════════════════════════════════════════════════════════════════
// DRIVER MODE STATE — single source of truth for mutating a driver's
// operating mode.
// ═══════════════════════════════════════════════════════════════════════
//
// Three endpoints need to change a driver's mode:
//   - POST /api/auth/switch-mode                    (user-initiated, full flow)
//   - POST /deliveries/driver/mode                   (legacy mobile reaffirm ping)
//   - PATCH /api/backoffice/delivery/agents/:id/mode (admin override)
//
// Previously each reimplemented this independently, and only the first kept
// Driver.current_mode (read by the ride/delivery MATCHING engines) in sync
// with Account.active_mode (read by ALL authorization middleware, and baked
// into the JWT). The other two touched Driver.current_mode alone, so a call
// to either could silently desync the two — the driver's session/UI would
// still say they're in mode X while the matching engine quietly stopped
// offering them jobs of type X, with no error surfaced anywhere.
//
// setDriverMode() is now the ONLY place either field is written. It also
// refuses unconditionally while the driver has a live job (status='busy') —
// there is NO exception for admin-triggered switches, because forcing a busy
// driver's mode is exactly the scenario that orphans a real passenger or
// package mid-trip/mid-delivery.
//
// Account.active_mode is the authorization source of truth; a caller that
// changes it without also rotating the caller's OWN JWT (the legacy and
// admin paths do not) relies on the existing stale-token detection in
// auth.middleware.js (MODE_TOKEN_STALE) — the driver's app already retries
// via /refresh-token on that response code, which re-fetches the Account row
// fresh from the DB, so the new active_mode is picked up automatically on
// the driver's next authenticated request. No new client plumbing needed.
// ═══════════════════════════════════════════════════════════════════════

'use strict';

const { Account, Driver, DeliveryWallet } = require('../models');
const { redisClient, REDIS_KEYS }         = require('../config/redis');

class ModeSwitchBlockedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ModeSwitchBlockedError';
        this.code = 'ACTIVE_JOB_IN_PROGRESS';
    }
}

// Account.active_mode ('DRIVER' | 'DELIVERY_AGENT' | 'PASSENGER') → the
// Driver.current_mode value ('ride' | 'delivery') that should accompany it.
const DRIVER_MODE_FOR_ACTIVE_MODE = {
    DRIVER:         'ride',
    DELIVERY_AGENT: 'delivery',
    PASSENGER:      'ride', // reset to the baseline default when going passenger
};

async function _cleanRedisPresence(accountUuid) {
    try {
        const id = accountUuid.toString();
        await Promise.all([
            redisClient.zrem(REDIS_KEYS.DRIVERS_GEO,      id),
            redisClient.srem(REDIS_KEYS.ONLINE_DRIVERS,    id),
            redisClient.srem(REDIS_KEYS.AVAILABLE_DRIVERS, id),
            redisClient.del(REDIS_KEYS.DRIVER_META(accountUuid)),
            redisClient.del(`driver:location:${accountUuid}`),
        ]);
        console.log('✅ [DRIVER-MODE] Redis presence cleared for:', accountUuid);
    } catch (e) {
        console.warn('⚠️  [DRIVER-MODE] Redis cleanup failed (non-fatal):', e.message);
    }
}

/**
 * Switch an account's operating mode. Throws ModeSwitchBlockedError if the
 * driver currently has a live job (status === 'busy').
 *
 * @param {string} accountUuid   Account.uuid. NOT necessarily the Driver PK:
 *                                Driver.id === Account.uuid only for ride
 *                                drivers created via driver.controller.js's
 *                                goOnline findOrCreate. Delivery agents are
 *                                created via createDeliveryAgent.controller.js
 *                                with an INDEPENDENTLY generated Driver.id —
 *                                Driver.userId is the only field guaranteed to
 *                                hold the account uuid for every driver, so
 *                                that is what this looks the row up by. Every
 *                                use of the Driver row's OWN identity below
 *                                (e.g. keying DeliveryWallet.driver_id, which
 *                                is a real FK to Driver.id — confirmed against
 *                                every consumer in the codebase) uses the
 *                                resolved driver.id, never the raw accountUuid.
 * @param {'DRIVER'|'DELIVERY_AGENT'|'PASSENGER'} targetActiveMode
 */
async function setDriverMode(accountUuid, targetActiveMode) {
    const driverMode = DRIVER_MODE_FOR_ACTIVE_MODE[targetActiveMode] || 'ride';

    // findOrCreate (not findOne): a DRIVER-type account that switches mode
    // before ever calling goOnline() has no Driver row yet. Mirrors
    // goOnline's own convention for a freshly-created row (id === account
    // uuid) — see driver.controller.js. This also guarantees driver.id is
    // always available below for the DeliveryWallet FK.
    const [driver] = await Driver.findOrCreate({
        where:    { userId: accountUuid },
        defaults: {
            id:           accountUuid,
            userId:       accountUuid,
            status:       'offline',
            current_mode: driverMode,
        },
    });

    if (driver.status === 'busy') {
        throw new ModeSwitchBlockedError(
            'Cannot switch mode while you have an active trip or delivery in progress.'
        );
    }

    await _cleanRedisPresence(accountUuid);

    try {
        await driver.update({ status: 'offline', current_mode: driverMode });
        console.log(`✅ [DRIVER-MODE] Driver.current_mode = ${driverMode} (status: offline) for ${accountUuid}`);
    } catch (e) {
        console.warn('⚠️  [DRIVER-MODE] Driver row update failed (non-fatal):', e.message);
    }

    await Account.update({ active_mode: targetActiveMode }, { where: { uuid: accountUuid } });
    console.log(`✅ [DRIVER-MODE] Account.active_mode = ${targetActiveMode} for ${accountUuid}`);

    if (targetActiveMode === 'DELIVERY_AGENT') {
        try {
            const [wallet, created] = await DeliveryWallet.findOrCreate({
                where:    { driver_id: driver.id },
                defaults: {
                    driver_id:             driver.id,
                    balance:               0.00,
                    total_earned:          0.00,
                    total_cash_collected:  0.00,
                    total_commission_owed: 0.00,
                    total_commission_paid: 0.00,
                    total_withdrawn:       0.00,
                    pending_withdrawal:    0.00,
                    status:                'active',
                },
            });
            console.log(created
                ? '✅ [DRIVER-MODE] DeliveryWallet auto-created for driver: ' + driver.id
                : 'ℹ️  [DRIVER-MODE] DeliveryWallet already exists — balance: ' + wallet.balance + ' XAF');
        } catch (e) {
            console.warn('⚠️  [DRIVER-MODE] DeliveryWallet findOrCreate failed (non-fatal):', e.message);
        }
    }
}

module.exports = { setDriverMode, ModeSwitchBlockedError };
