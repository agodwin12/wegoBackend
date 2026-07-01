'use strict';

// ═══════════════════════════════════════════════════════════════════════
// RIDE STATE MACHINE — the single source of truth for trip transitions.
// ───────────────────────────────────────────────────────────────────────
// Replaces ad-hoc `trip.status = '...'` writes scattered across handlers.
// Every transition is validated here; illegal jumps throw. Pure + testable
// (no DB) so it can be unit-tested in isolation. The DB-applying helper
// `applyTransition` lives in services/tripState.service.js and uses this.
// ═══════════════════════════════════════════════════════════════════════

const STATES = Object.freeze({
    DRAFT:           'DRAFT',
    SEARCHING:       'SEARCHING',
    MATCHED:         'MATCHED',
    DRIVER_ASSIGNED: 'DRIVER_ASSIGNED',
    DRIVER_EN_ROUTE: 'DRIVER_EN_ROUTE',
    DRIVER_ARRIVED:  'DRIVER_ARRIVED',
    IN_PROGRESS:     'IN_PROGRESS',
    COMPLETED:       'COMPLETED',
    CANCELED:        'CANCELED',
    NO_DRIVERS:      'NO_DRIVERS',
    NO_SHOW:         'NO_SHOW',
});

// A ride can be cancelled from any pre-completion state.
const CANCELLABLE_FROM = [
    STATES.DRAFT, STATES.SEARCHING, STATES.MATCHED, STATES.DRIVER_ASSIGNED,
    STATES.DRIVER_EN_ROUTE, STATES.DRIVER_ARRIVED, STATES.IN_PROGRESS,
];

// Allowed forward transitions. CANCELED is added to every cancellable state below.
const TRANSITIONS = Object.freeze({
    [STATES.DRAFT]:           [STATES.SEARCHING],
    [STATES.SEARCHING]:       [STATES.MATCHED, STATES.NO_DRIVERS],
    [STATES.MATCHED]:         [STATES.DRIVER_ASSIGNED, STATES.DRIVER_EN_ROUTE],
    [STATES.DRIVER_ASSIGNED]: [STATES.DRIVER_EN_ROUTE],
    [STATES.DRIVER_EN_ROUTE]: [STATES.DRIVER_ARRIVED],
    [STATES.DRIVER_ARRIVED]:  [STATES.IN_PROGRESS, STATES.NO_SHOW],
    [STATES.IN_PROGRESS]:     [STATES.COMPLETED],
    // Terminal states — no outgoing transitions.
    [STATES.COMPLETED]:       [],
    [STATES.CANCELED]:        [],
    [STATES.NO_DRIVERS]:      [],
    [STATES.NO_SHOW]:         [],
});

const TERMINAL = new Set([STATES.COMPLETED, STATES.CANCELED, STATES.NO_DRIVERS, STATES.NO_SHOW]);

// Which Trip timestamp column to stamp on entering each state.
const STATUS_TIMESTAMP = Object.freeze({
    [STATES.MATCHED]:         'matchedAt',
    [STATES.DRIVER_EN_ROUTE]: 'driverEnRouteAt',
    [STATES.DRIVER_ARRIVED]:  'driverArrivedAt',
    [STATES.IN_PROGRESS]:     'tripStartedAt',
    [STATES.COMPLETED]:       'tripCompletedAt',
    [STATES.CANCELED]:        'canceledAt',
});

function isTerminal(state) {
    return TERMINAL.has(state);
}

function allowedFrom(from) {
    const forward = TRANSITIONS[from] || [];
    return CANCELLABLE_FROM.includes(from) ? [...forward, STATES.CANCELED] : forward;
}

function canTransition(from, to) {
    if (from === to) return false;            // no-op is not a transition
    if (!STATES[to] && !Object.values(STATES).includes(to)) return false;
    return allowedFrom(from).includes(to);
}

function assertTransition(from, to) {
    if (!Object.values(STATES).includes(from)) {
        const err = new Error(`Unknown trip state: "${from}"`);
        err.code = 'INVALID_STATE';
        throw err;
    }
    if (!canTransition(from, to)) {
        const err = new Error(`Illegal trip transition: ${from} → ${to}`);
        err.code = 'ILLEGAL_TRANSITION';
        err.from = from;
        err.to   = to;
        throw err;
    }
    return true;
}

module.exports = {
    STATES,
    TRANSITIONS,
    TERMINAL,
    STATUS_TIMESTAMP,
    isTerminal,
    allowedFrom,
    canTransition,
    assertTransition,
};
