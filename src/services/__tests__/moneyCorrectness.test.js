'use strict';

// Money-correctness guarantees that must never regress. Pure-logic tests
// (no DB) over the settlement math + the state machine — the two places where
// a bug silently loses money. Run with: npm test
const test   = require('node:test');
const assert = require('node:assert/strict');
const { computeSettlement } = require('../../utils/settlement');
const { assertTransition, canTransition, STATES } = require('../../utils/tripStateMachine');

// ── No-show / cancel must NEVER reach COMPLETED ─────────────────────────────
// Settlement (the only code that debits commission) runs ONLY on the
// IN_PROGRESS → COMPLETED transition. If a no-show or cancelled trip could
// reach COMPLETED, a driver could be charged commission for a ride that earned
// nothing. The state machine forbids it — encode that as a guarantee.
test('a NO_SHOW trip can never be completed (so it can never be charged commission)', () => {
    assert.equal(canTransition(STATES.NO_SHOW, STATES.COMPLETED), false);
    assert.throws(() => assertTransition(STATES.NO_SHOW, STATES.COMPLETED),
        (e) => e.code === 'ILLEGAL_TRANSITION');
});

test('a CANCELED trip can never be completed (no commission on a cancel)', () => {
    assert.equal(canTransition(STATES.CANCELED, STATES.COMPLETED), false);
    assert.throws(() => assertTransition(STATES.CANCELED, STATES.COMPLETED),
        (e) => e.code === 'ILLEGAL_TRANSITION');
});

// ── Double-complete protection (state-machine backstop for idempotency) ─────
test('a COMPLETED trip cannot be completed again (backs the unique-receipt idempotency)', () => {
    assert.equal(canTransition(STATES.COMPLETED, STATES.COMPLETED), false);
    assert.throws(() => assertTransition(STATES.COMPLETED, STATES.COMPLETED),
        (e) => e.code === 'ILLEGAL_TRANSITION');
});

// ── Commission scales off the (server-stored) fare, deterministically ───────
test('commission scales with the fare and the wallet is debited that amount', () => {
    for (const [fare, commission] of [[1000, 150], [5000, 750], [12345, 1851]]) {
        const r = computeSettlement({ grossFare: fare, commissionAmount: commission, directToDriver: true });
        assert.equal(r.fareCredit, 0, 'fare is never credited (P2P)');
        assert.equal(r.commission, commission);
        assert.equal(r.driverNet, -commission, 'wallet goes down by exactly the commission');
    }
});

test('settlement is deterministic — same inputs give the same result (idempotency-safe)', () => {
    const a = computeSettlement({ grossFare: 5000, commissionAmount: 750, bonusTotal: 200, directToDriver: true });
    const b = computeSettlement({ grossFare: 5000, commissionAmount: 750, bonusTotal: 200, directToDriver: true });
    assert.deepEqual(a, b);
});

// ── A direct ride never increases the wallet beyond bonuses ─────────────────
test('with no bonus, a completed ride strictly reduces the wallet by commission', () => {
    const r = computeSettlement({ grossFare: 8000, commissionAmount: 1200, bonusTotal: 0, directToDriver: true });
    assert.ok(r.driverNet < 0);
    assert.equal(r.driverNet, -1200);
});

// ── Full legal lifecycle is traversable; the only money step is the last one ─
test('the lifecycle reaches COMPLETED only through the single legal path', () => {
    const path = [STATES.SEARCHING, STATES.MATCHED, STATES.DRIVER_EN_ROUTE,
                  STATES.DRIVER_ARRIVED, STATES.IN_PROGRESS, STATES.COMPLETED];
    for (let i = 0; i < path.length - 1; i++) {
        assert.equal(canTransition(path[i], path[i + 1]), true, `${path[i]} → ${path[i + 1]}`);
    }
    // and you cannot skip straight to COMPLETED from anywhere earlier
    assert.equal(canTransition(STATES.MATCHED, STATES.COMPLETED), false);
    assert.equal(canTransition(STATES.DRIVER_ARRIVED, STATES.COMPLETED), false);
});
