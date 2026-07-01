'use strict';

// ═══════════════════════════════════════════════════════════════════════
// TRIP STATE SERVICE — the ONLY place trip.status should change.
// Validates the transition via the state machine, stamps the matching
// timestamp, persists, and logs a TripEvent (actor + from→to + timestamp).
// ═══════════════════════════════════════════════════════════════════════

const { v4: uuidv4 } = require('uuid');
const { assertTransition, STATUS_TIMESTAMP, STATES, canTransition } = require('../utils/tripStateMachine');
const { Trip, TripEvent } = require('../models');

/**
 * Validate + apply a trip state transition.
 *
 * @param {object} trip  a loaded Trip instance (mutated + saved)
 * @param {string} to    target state (STATES value)
 * @param {object} opts  { actor:'PASSENGER'|'DRIVER'|'SYSTEM', reason, meta, transaction }
 * @returns {object} the saved trip
 * @throws  Error{code:'ILLEGAL_TRANSITION'} on an invalid jump
 */
async function applyTransition(trip, to, opts = {}) {
    const from = trip.status;
    assertTransition(from, to); // throws on illegal jump

    const { actor = 'SYSTEM', reason = null, meta = null, transaction = null } = opts;
    const now = new Date();

    trip.status = to;
    const tsField = STATUS_TIMESTAMP[to];
    if (tsField) trip[tsField] = now;
    if (to === STATES.CANCELED) {
        if (reason) trip.cancelReason = reason;
        if (actor)  trip.canceledBy   = actor;
    }

    await trip.save({ transaction });

    // Audit log — never let a logging failure roll back the transition.
    try {
        await TripEvent.create({
            id:      uuidv4(),
            tripId:  trip.id,
            type:    `STATE:${to}`,
            payload: { from, to, actor, reason, meta, at: now.toISOString() },
        }, { transaction });
    } catch (e) {
        console.warn('⚠️  [TRIP STATE] event log failed:', e.message);
    }

    console.log(`🔀 [TRIP STATE] ${trip.id.substring(0, 8)} ${from} → ${to} (by ${actor})`);
    return trip;
}

module.exports = { applyTransition, canTransition, STATES };
