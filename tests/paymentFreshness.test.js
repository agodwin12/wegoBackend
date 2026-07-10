'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { isPaymentStillInProgress, PAYMENT_FRESH_MS } =
    require('../src/utils/paymentFreshness');

const NOW = new Date('2026-07-07T12:00:00.000Z');
const minsAgo = (m) => new Date(NOW.getTime() - m * 60 * 1000).toISOString();

test('no WegoPayment → not in progress (stale, allow retry)', () => {
    assert.equal(isPaymentStillInProgress(null, NOW), false);
    assert.equal(isPaymentStillInProgress(undefined, NOW), false);
});

test('resolved payments → not in progress', () => {
    for (const status of ['SUCCESSFUL', 'FAILED', 'EXPIRED']) {
        assert.equal(
            isPaymentStillInProgress({ status, initiated_at: minsAgo(1) }, NOW),
            false,
            `${status} should be treated as stale`,
        );
    }
});

test('recent PENDING → in progress (block a duplicate charge)', () => {
    assert.equal(
        isPaymentStillInProgress({ status: 'PENDING', initiated_at: minsAgo(5) }, NOW),
        true,
    );
});

test('old PENDING (past freshness window) → stale, allow retry', () => {
    assert.equal(
        isPaymentStillInProgress({ status: 'PENDING', initiated_at: minsAgo(20) }, NOW),
        false,
    );
});

test('PENDING with missing/invalid initiated_at → stale', () => {
    assert.equal(isPaymentStillInProgress({ status: 'PENDING' }, NOW), false);
    assert.equal(isPaymentStillInProgress({ status: 'PENDING', initiated_at: null }, NOW), false);
    assert.equal(isPaymentStillInProgress({ status: 'PENDING', initiated_at: 'not-a-date' }, NOW), false);
});

test('exactly at the freshness boundary → stale (strictly greater-than)', () => {
    const atBoundary = new Date(NOW.getTime() - PAYMENT_FRESH_MS).toISOString();
    assert.equal(isPaymentStillInProgress({ status: 'PENDING', initiated_at: atBoundary }, NOW), false);
    const justInside = new Date(NOW.getTime() - PAYMENT_FRESH_MS + 1000).toISOString();
    assert.equal(isPaymentStillInProgress({ status: 'PENDING', initiated_at: justInside }, NOW), true);
});
