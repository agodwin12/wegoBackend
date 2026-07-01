// src/services/couponService.js
//
// Shared coupon evaluation. Always resolves the coupon via findByCode (a DB
// reload) so model defaults are present and isValid() is reliable.
//
// Returns { ok, discount, coupon, message }. Never throws — callers decide
// whether a bad code is fatal (booking) or ignorable (preview).

'use strict';

const models = require('../models');
const { Coupon } = models;

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

module.exports = { evaluate };
