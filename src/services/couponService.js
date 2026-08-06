// src/services/couponService.js
//
// Shared coupon evaluation. Always resolves the coupon via findByCode (a DB
// reload) so model defaults are present and isValid() is reliable.
//
// Returns { ok, discount, coupon, message }. Never throws — callers decide
// whether a bad code is fatal (booking) or ignorable (preview).

'use strict';

const models    = require('../models');
const sequelize = require('../config/database');
const { Coupon, CouponUsage } = models;

/**
 * @param {object}  opts
 * @param {string}  opts.code         - coupon code (case-insensitive)
 * @param {string}  opts.userUuid     - the redeeming user's account uuid
 * @param {number}  opts.grossAmount  - order/fare amount in XAF (pre-discount)
 * @param {number} [opts.maxDiscount] - hard cap on the discount (e.g. the ride
 *                                       commission, so WeGo never pays the driver)
 */
async function evaluate({ code, userUuid, grossAmount, maxDiscount = null }) {
    if (!code || !String(code).trim()) return { ok: false, discount: 0, coupon: null, message: 'No coupon' };
    if (!Coupon)                        return { ok: false, discount: 0, coupon: null, message: 'Coupons unavailable' };

    const coupon = await Coupon.findByCode(String(code).trim());
    if (!coupon)           return { ok: false, discount: 0, coupon: null, message: 'Invalid coupon code' };
    if (!coupon.isValid()) return { ok: false, discount: 0, coupon: null, message: 'This coupon has expired or is no longer active' };

    const usable = await coupon.canBeUsedByUser(userUuid, models);
    if (!usable)           return { ok: false, discount: 0, coupon: null, message: 'You are not eligible to use this coupon' };

    if (grossAmount < coupon.min_trip_amount) {
        return { ok: false, discount: 0, coupon: null, message: `Minimum amount of ${coupon.min_trip_amount} XAF required for this coupon` };
    }

    let discount = coupon.calculateDiscount(Math.round(grossAmount));
    if (maxDiscount != null) discount = Math.min(discount, Math.max(0, Math.floor(maxDiscount)));
    if (discount <= 0)     return { ok: false, discount: 0, coupon: null, message: 'Coupon gives no discount on this order' };

    return { ok: true, discount, coupon, message: 'Coupon applied' };
}

/**
 * Atomically redeem a coupon that already passed evaluate(). Must be called
 * AFTER evaluate() succeeds but BEFORE the caller commits to the discount
 * (i.e. before creating the Trip/Delivery row that bakes the discounted
 * price in) — otherwise a caller could apply a discount that this function
 * then refuses to record, leaving the coupon's bookkeeping understated
 * while the passenger/sender still got the money off.
 *
 * evaluate() reads the coupon and CouponUsage rows with no lock, so two
 * concurrent requests for the same (or a nearly-exhausted) coupon can both
 * pass it — that is the actual "check-then-act" race this closes. redeem()
 * re-validates under `SELECT ... FOR UPDATE` on the Coupon row: the second
 * concurrent caller blocks until the first transaction commits or rolls
 * back, then re-reads the now-current used_count / per-user usage count
 * before deciding, so a limited-use coupon can no longer be redeemed more
 * times than its usage_limit_total or usage_limit_per_user allows.
 *
 * `tripId`/`deliveryId` can be omitted when the caller doesn't have the
 * entity's id yet at redemption time (e.g. Delivery.id is DB-assigned,
 * generated only once the row is inserted). The returned `usageId` lets the
 * caller patch `CouponUsage.delivery_id` in afterward — that follow-up is
 * pure bookkeeping (which record this redemption is "for"), not part of the
 * atomicity guarantee, which is already fully committed by the time this
 * function returns.
 *
 * @param {object} opts
 * @param {string} opts.couponId
 * @param {string} opts.userUuid
 * @param {number} opts.discount   - discount amount to record (XAF), from evaluate()
 * @param {string} [opts.tripId]
 * @param {number} [opts.deliveryId]
 * @returns {Promise<{ ok: boolean, message?: string, usageId?: string }>}
 */
async function redeem({ couponId, userUuid, discount, tripId = null, deliveryId = null }) {
    if (!Coupon || !CouponUsage) return { ok: false, message: 'Coupons unavailable' };

    return sequelize.transaction(async (t) => {
        const coupon = await Coupon.findByPk(couponId, {
            transaction: t,
            lock:        t.LOCK.UPDATE,
        });
        if (!coupon)           return { ok: false, message: 'Invalid coupon code' };
        if (!coupon.isValid()) return { ok: false, message: 'This coupon has expired, is inactive, or has reached its usage limit' };

        // Per-user limit, re-checked under the coupon row lock — this is
        // what closes the gap between evaluate()'s unlocked read and this
        // write for the usage_limit_per_user case.
        const userUsageCount = await CouponUsage.count({
            where:       { coupon_id: coupon.id, user_id: userUuid },
            transaction: t,
        });
        if (userUsageCount >= coupon.usage_limit_per_user) {
            return { ok: false, message: 'You have already used this coupon the maximum number of times' };
        }

        const usage = await CouponUsage.create({
            coupon_id:        coupon.id,
            user_id:          userUuid,
            trip_id:          tripId,
            delivery_id:      deliveryId,
            discount_applied: discount,
        }, { transaction: t });

        coupon.used_count += 1;
        await coupon.save({ transaction: t });

        return { ok: true, usageId: usage.id };
    });
}

module.exports = { evaluate, redeem };
