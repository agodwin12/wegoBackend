'use strict';

// Validates the ride state machine: legal transitions pass, illegal jumps throw.
const test   = require('node:test');
const assert = require('node:assert/strict');
const { STATES, canTransition, assertTransition, isTerminal } = require('../../utils/tripStateMachine');

test('the happy path is fully traversable', () => {
    const path = [
        [STATES.SEARCHING, STATES.MATCHED],
        [STATES.MATCHED, STATES.DRIVER_EN_ROUTE],
        [STATES.DRIVER_EN_ROUTE, STATES.DRIVER_ARRIVED],
        [STATES.DRIVER_ARRIVED, STATES.IN_PROGRESS],
        [STATES.IN_PROGRESS, STATES.COMPLETED],
    ];
    for (const [from, to] of path) {
        assert.equal(canTransition(from, to), true, `${from} → ${to} should be allowed`);
    }
});

test('illegal jumps are rejected', () => {
    assert.equal(canTransition(STATES.SEARCHING, STATES.COMPLETED), false);
    assert.equal(canTransition(STATES.SEARCHING, STATES.IN_PROGRESS), false);
    assert.equal(canTransition(STATES.DRIVER_ARRIVED, STATES.MATCHED), false); // no going back
    assert.equal(canTransition(STATES.COMPLETED, STATES.IN_PROGRESS), false);  // terminal
});

test('a ride can be cancelled from any active state but not after completion', () => {
    for (const s of [STATES.SEARCHING, STATES.MATCHED, STATES.DRIVER_EN_ROUTE, STATES.DRIVER_ARRIVED, STATES.IN_PROGRESS]) {
        assert.equal(canTransition(s, STATES.CANCELED), true, `${s} should be cancellable`);
    }
    assert.equal(canTransition(STATES.COMPLETED, STATES.CANCELED), false);
    assert.equal(canTransition(STATES.CANCELED, STATES.CANCELED), false);
});

test('no-show only from DRIVER_ARRIVED', () => {
    assert.equal(canTransition(STATES.DRIVER_ARRIVED, STATES.NO_SHOW), true);
    assert.equal(canTransition(STATES.IN_PROGRESS, STATES.NO_SHOW), false);
});

test('terminal states are terminal', () => {
    for (const s of [STATES.COMPLETED, STATES.CANCELED, STATES.NO_DRIVERS, STATES.NO_SHOW]) {
        assert.equal(isTerminal(s), true);
    }
    assert.equal(isTerminal(STATES.IN_PROGRESS), false);
});

test('assertTransition throws a coded error on illegal jump', () => {
    assert.throws(
        () => assertTransition(STATES.SEARCHING, STATES.COMPLETED),
        (e) => e.code === 'ILLEGAL_TRANSITION',
    );
    assert.throws(
        () => assertTransition('BOGUS', STATES.MATCHED),
        (e) => e.code === 'INVALID_STATE',
    );
});
