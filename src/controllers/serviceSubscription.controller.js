// src/controllers/serviceSubscription.controller.js
//
// ═══════════════════════════════════════════════════════════════════════════
// SERVICE PROVIDER SUBSCRIPTIONS (provider-level, "buy a plan then post")
// ═══════════════════════════════════════════════════════════════════════════
//
// A provider buys a plan ONCE (free or paid). It grants a posting quota +
// validity window and is NOT tied to a single listing (ServiceAdPayment with
// listing_id = NULL). The createListing gate then reads this active plan.
//
//   • Free plan  → activated instantly, LOW priority (boost_priority 0).
//   • Paid plan  → CamPay USSD; activated by the webhook. HIGHER priority.
//
// This is distinct from the older per-listing activation
// (serviceAdPayment_controller) which stays for backward compatibility.
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

const { Op } = require('sequelize');
const { sequelize, ServiceAdPayment, ServiceListingPlan, ServiceListing, WegoPayment } = require('../models');
const campayService = require('../services/campay/campayService');

// A pending subscription payment only blocks a new attempt while its CamPay
// collection is still genuinely in progress (see the helper). Older/resolved
// attempts are stale and get released so the provider can retry.
const { isPaymentStillInProgress } = require('../utils/paymentFreshness');

// The provider's current active subscription (not expired), or null.
async function findActiveSubscription(providerUuid) {
    return ServiceAdPayment.findOne({
        where: {
            paid_by:         providerUuid,
            listing_id:      null,
            status:          'active',
            plan_expires_at: { [Op.gt]: new Date() },
        },
        include: [{ model: ServiceListingPlan, as: 'plan' }],
        order: [['plan_expires_at', 'DESC']],
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/services/subscription/mine — current subscription + quota usage
// ─────────────────────────────────────────────────────────────────────────────
exports.getMySubscription = async (req, res) => {
    try {
        const providerUuid = req.user.uuid;
        const sub  = await findActiveSubscription(providerUuid);
        const used = await ServiceListing.count({
            where: { provider_id: providerUuid, status: { [Op.ne]: 'deleted' } },
        });

        if (!sub) {
            return res.json({ success: true, data: { active: false, listings_used: used } });
        }
        const quota = sub.plan?.listing_quota ?? null;
        return res.json({
            success: true,
            data: {
                active:             true,
                plan_key:           sub.plan_key_snapshot,
                listing_quota:      quota,
                listings_used:      used,
                listings_remaining: quota != null ? Math.max(0, quota - used) : null,
                boost_priority:     sub.plan?.boost_priority ?? 0,
                plan_expires_at:    sub.plan_expires_at,
            },
        });
    } catch (err) {
        console.error('❌ [SUBSCRIPTION] getMySubscription:', err.message);
        return res.status(500).json({ success: false, message: 'Unable to load your subscription.' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/services/subscription/activate-free — instant free plan
// ─────────────────────────────────────────────────────────────────────────────
exports.activateFreeSubscription = async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const providerUuid = req.user.uuid;

        const existing = await findActiveSubscription(providerUuid);
        if (existing) {
            await t.rollback();
            return res.json({
                success: true,
                message: 'You already have an active plan.',
                data: { plan_key: existing.plan_key_snapshot, plan_expires_at: existing.plan_expires_at },
            });
        }

        const freePlan = await ServiceListingPlan.findOne({ where: { plan_key: 'free', is_active: true } });
        if (!freePlan) {
            await t.rollback();
            return res.status(503).json({ success: false, message: 'The free plan is currently unavailable. Please choose a paid plan.' });
        }

        const now = new Date();
        const exp = new Date(now.getTime() + freePlan.duration_days * 24 * 60 * 60 * 1000);

        await ServiceAdPayment.create({
            listing_id:                 null,   // provider-level subscription
            plan_id:                    freePlan.id,
            wego_payment_id:            null,
            paid_by:                    providerUuid,
            plan_key_snapshot:          freePlan.plan_key,
            amount_snapshot:            0,
            duration_days_snapshot:     freePlan.duration_days,
            is_hero_placement_snapshot: false,
            plan_starts_at:             now,
            plan_expires_at:            exp,
            status:                     'active',
        }, { transaction: t });

        await t.commit();
        console.log(`✅ [SUBSCRIPTION] Free plan activated for provider ${providerUuid} until ${exp.toISOString()}`);
        return res.status(201).json({
            success: true,
            message: 'Free plan activated. You can now post your services.',
            data: { plan_key: 'free', listing_quota: freePlan.listing_quota, plan_expires_at: exp },
        });
    } catch (err) {
        if (!t.finished) await t.rollback();
        console.error('❌ [SUBSCRIPTION] activateFreeSubscription:', err.message);
        return res.status(500).json({ success: false, message: 'Unable to activate the free plan. Please try again.' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/services/subscription/initiate-payment — buy a paid plan (CamPay)
// Body: { plan_id, phone }
// ─────────────────────────────────────────────────────────────────────────────
exports.initiateSubscription = async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const providerUuid = req.user.uuid;
        const { plan_id, phone } = req.body;

        if (!plan_id) { await t.rollback(); return res.status(400).json({ success: false, message: 'plan_id is required. Please select a plan.' }); }
        if (!phone)   { await t.rollback(); return res.status(400).json({ success: false, message: 'phone is required.' }); }

        const plan = await ServiceListingPlan.findOne({ where: { id: plan_id, is_active: true } });
        if (!plan) { await t.rollback(); return res.status(404).json({ success: false, message: 'Plan not found or inactive.' }); }
        if (!plan.price_xaf || plan.price_xaf <= 0) {
            await t.rollback();
            return res.status(400).json({ success: false, message: 'This is a free plan — use activate-free instead.' });
        }

        // A previous subscription attempt may have left a pending_payment record.
        // Only block if it is a GENUINELY in-progress CamPay collection (its
        // WegoPayment is still PENDING and recent). Otherwise the record is stale
        // (payment failed/expired, or CamPay was never reached) — cancel it and let
        // the provider retry, instead of dead-locking them behind a permanent 409.
        const pending = await ServiceAdPayment.findOne({
            where: { paid_by: providerUuid, listing_id: null, status: 'pending_payment' },
            order: [['created_at', 'DESC']],
        });
        if (pending) {
            const wp = await WegoPayment.findOne({
                where: { vertical: 'listing_fee', vertical_id: String(pending.id) },
                order: [['initiated_at', 'DESC']],
            });
            if (isPaymentStillInProgress(wp)) {
                await t.rollback();
                return res.status(409).json({
                    success: false,
                    message: 'A subscription payment is already in progress. Check your phone to complete it, or wait a few minutes and try again.',
                    code:    'PAYMENT_IN_PROGRESS',
                });
            }

            // Stale — release it so the provider can start a fresh payment.
            await pending.update({
                status:              'cancelled',
                cancelled_at:        new Date(),
                cancellation_reason: 'Superseded by a new payment attempt (previous attempt was not completed).',
            }, { transaction: t });
            console.log(`ℹ️  [SUBSCRIPTION] Released stale pending_payment #${pending.id} for provider ${providerUuid}`);
        }

        const now = new Date();
        const exp = new Date(now.getTime() + plan.duration_days * 24 * 60 * 60 * 1000);

        const sub = await ServiceAdPayment.create({
            listing_id:                 null,
            plan_id:                    plan.id,
            wego_payment_id:            null,
            paid_by:                    providerUuid,
            plan_key_snapshot:          plan.plan_key,
            amount_snapshot:            plan.price_xaf,
            duration_days_snapshot:     plan.duration_days,
            is_hero_placement_snapshot: plan.is_hero_placement || false,
            plan_starts_at:             now,
            plan_expires_at:            exp,
            status:                     'pending_payment',
        }, { transaction: t });

        await t.commit();

        let result;
        try {
            result = await campayService.initiateCollection({
                vertical:    'listing_fee',   // resolves amount from this ServiceAdPayment + routes to the (null-listing aware) finalizer
                verticalId:  sub.id,
                phone,
                initiatedBy: providerUuid,
            });
        } catch (campayErr) {
            await sub.update({ status: 'cancelled', cancelled_at: new Date(), cancellation_reason: `CamPay initiation failed: ${campayErr.message}` });
            console.error('❌ [SUBSCRIPTION] CamPay initiation failed:', campayErr.message);
            const codeMap = {
                ER101: 'Invalid phone number. Please check and try again.',
                ER102: 'This phone number is not supported. Only MTN and Orange numbers are accepted.',
                ER301: 'Payment service temporarily unavailable. Please try again shortly.',
            };
            if (campayErr.campayCode) {
                return res.status(400).json({ success: false, message: codeMap[campayErr.campayCode] || 'Payment initiation failed.', code: campayErr.campayCode });
            }
            return res.status(500).json({ success: false, message: 'Failed to initiate payment. Please try again.' });
        }

        console.log(`✅ [SUBSCRIPTION] Paid plan payment initiated for provider ${providerUuid}, adPayment #${sub.id}`);
        return res.json({
            success:       true,
            ad_payment_id: sub.id,
            payment_id:    result.paymentId,
            campay_ref:    result.campayRef,
            external_ref:  result.externalRef,
            ussd_code:     result.ussdCode,
            operator:      result.operator,
            plan_key:      plan.plan_key,
            amount_xaf:    plan.price_xaf,
            status:        'PENDING',
            message:       'Payment initiated. Please check your phone and enter your PIN.',
        });
    } catch (err) {
        if (!t.finished) await t.rollback();
        console.error('❌ [SUBSCRIPTION] initiateSubscription:', err.message);
        return res.status(500).json({ success: false, message: 'Unable to initiate payment. Please try again.' });
    }
};
