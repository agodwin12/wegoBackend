'use strict';

// Money-critical: validates the ride wallet settlement math.
// Run with:  npm test   (uses node --test)
//
// WeGo model: the passenger ALWAYS pays the driver directly (cash / MoMo / OM
// are all P2P and never touch WeGo). So every ride uses directToDriver=true —
// the fare is never credited to the wallet; WeGo only debits its commission
// and credits bonuses. We import only the pure helper (no DB/Redis needed).
const test   = require('node:test');
const assert = require('node:assert/strict');
const { computeSettlement } = require('../../utils/settlement');

test('every ride (directToDriver) debits commission only — no fare credit', () => {
    const r = computeSettlement({ grossFare: 5000, commissionAmount: 750, bonusTotal: 0, directToDriver: true });
    assert.equal(r.fareCredit, 0);          // fare was paid directly to the driver
    assert.equal(r.commission, 750);
    assert.equal(r.driverNet, -750);        // wallet goes DOWN by the commission owed
});

test('ride default is directToDriver (omitted flag behaves as a direct ride)', () => {
    const r = computeSettlement({ grossFare: 5000, commissionAmount: 750 });
    assert.equal(r.fareCredit, 0);
    assert.equal(r.driverNet, -750);
});

test('ride with a bonus nets bonus − commission into the wallet', () => {
    const r = computeSettlement({ grossFare: 5000, commissionAmount: 750, bonusTotal: 1000, directToDriver: true });
    assert.equal(r.fareCredit, 0);
    assert.equal(r.driverNet, 250);         // 1000 bonus - 750 commission
});

test('a driver is never credited the fare (regression for the double-pay bug)', () => {
    // The original bug credited the gross fare to the wallet, so a driver who
    // already pocketed 5000 directly also gained ~4250 in wallet. Guard it.
    const r = computeSettlement({ grossFare: 5000, commissionAmount: 750, directToDriver: true });
    assert.equal(r.fareCredit, 0);
    assert.ok(r.driverNet <= 0, 'a direct ride must not increase the wallet beyond bonuses');
});

test('amounts are rounded to integers and never negative for fare/commission/bonus', () => {
    const r = computeSettlement({ grossFare: 4999.6, commissionAmount: 749.4, bonusTotal: -10, directToDriver: true });
    assert.equal(r.fareCredit, 0);
    assert.equal(r.commission, 749);        // rounded
    assert.equal(r.bonus, 0);               // clamped from negative
    assert.equal(r.driverNet, -749);
});

// Contract test for the generic helper's reserved platform-collected path.
// (Not used by ride-hailing today — documents the math if WeGo ever collects.)
test('directToDriver=false credits the net fare (helper contract)', () => {
    const r = computeSettlement({ grossFare: 5000, commissionAmount: 750, bonusTotal: 1000, directToDriver: false });
    assert.equal(r.fareCredit, 5000);
    assert.equal(r.driverNet, 5250);        // 5000 - 750 + 1000
});
