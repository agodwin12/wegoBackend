'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE AD PAYMENT CONTROLLER
// controllers/serviceAdPayment_controller.js
//
// Manages listing plan activations — free and paid.
//
// ENDPOINTS:
//
//   Public / Provider:
//     GET  /api/services/plans                          → getAvailablePlans
//     POST /api/services/listings/:id/activate-free    → activateFreePlan
//     POST /api/services/listings/:id/initiate-payment → initiateAdPayment
//     GET  /api/services/listings/:id/ad-status        → getAdStatus
//     GET  /api/services/ad-payments/history           → getMyAdPaymentHistory
//
//   Admin / Employee:
//     GET  /api/admin/services/hero-queue              → getHeroQueue
//     POST /api/admin/services/hero-queue/:id/approve  → approveHeroPlacement
//     POST /api/admin/services/hero-queue/:id/reject   → rejectHeroPlacement
//
//   Internal (called by cron job — not an HTTP route):
//     expireListings()                                 → exported for cron
//
// FLOW SUMMARY:
//
//   Free plan:
//     POST activate-free
//       → validate listing ownership + status
//       → create ServiceAdPayment (status: active, wego_payment_id: null)
//       → update ServiceListing (status: pending_review or active)
//       → return immediately
//
//   Paid plan:
//     POST initiate-payment
//       → validate listing + plan
//       → create ServiceAdPayment (status: pending_payment)
//       → call campayService.initiateCollection(vertical: service_request, verticalId: adPayment.id)
//       → return { campayRef, ussdCode } — Flutter shows "check your phone"
//       → webhook fires → campayWebhook._finalizeServiceAd() activates listing
//
// ═══════════════════════════════════════════════════════════════════════════════

const campayService = require('../services/campay/campayService');

const {
    ServiceListingPlan,
    ServiceAdPayment,
    ServiceListing,
    sequelize,
} = require('../models');

const { Op } = require('sequelize');

// ─────────────────────────────────────────────────────────────────────────────
// GET AVAILABLE PLANS
// GET /api/services/plans
//
// Returns all active plans ordered by display_order.
// Flutter fetches this before showing the "publish your listing" screen.
// ─────────────────────────────────────────────────────────────────────────────

exports.getAvailablePlans = async (req, res) => {
    try {
        const plans = await ServiceListingPlan.findAll({
            where: { is_active: true },
            order: [['display_order', 'ASC'], ['price_xaf', 'ASC']],
            attributes: [
                'id',
                'plan_key',
                'label_en',
                'label_fr',
                'description_en',
                'description_fr',
                'price_xaf',
                'duration_days',
                'max_photos',
                'is_hero_placement',
                'requires_admin_approval',
                'boost_priority',
                'is_highlighted',
                'highlight_label_en',
                'highlight_label_fr',
                'display_order',
            ],
        });

        return res.status(200).json({
            success: true,
            message: 'Plans retrieved successfully',
            data: { plans },
        });

    } catch (err) {
        console.error('❌ [AD_PAYMENT] getAvailablePlans error:', err.message);
        return res.status(500).json({
            success: false,
            message: 'Unable to retrieve plans. Please try again.',
        });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVATE FREE PLAN
// POST /api/services/listings/:id/activate-free
//
// No CamPay call. Creates ServiceAdPayment immediately in active state.
// Only one free activation allowed per listing (no repeat free renewals).
// ─────────────────────────────────────────────────────────────────────────────

exports.activateFreePlan = async (req, res) => {
    const t = await sequelize.transaction();

    try {
        const listingId  = parseInt(req.params.id);
        const providerUuid = req.user.uuid;

        // ── Validate listing ──────────────────────────────────────────────────
        const listing = await ServiceListing.findOne({
            where: { id: listingId, provider_id: providerUuid },
            transaction: t,
        });

        if (!listing) {
            await t.rollback();
            return res.status(404).json({
                success: false,
                message: 'Listing not found or you do not have permission to activate it.',
            });
        }

        // Only draft or rejected listings can be activated
        if (!['draft', 'rejected'].includes(listing.status)) {
            await t.rollback();
            return res.status(400).json({
                success: false,
                message: `Cannot activate a listing with status "${listing.status}". Only draft or rejected listings can be published.`,
            });
        }

        // ── Find the active free plan ─────────────────────────────────────────
        const freePlan = await ServiceListingPlan.findOne({
            where: { plan_key: 'free', is_active: true },
        });

        if (!freePlan) {
            await t.rollback();
            return res.status(503).json({
                success: false,
                message: 'Free plan is currently unavailable. Please try a paid plan.',
            });
        }

        // ── Check: has this listing already used its free plan? ───────────────
        const previousFreeActivation = await ServiceAdPayment.findOne({
            where: {
                listing_id:        listingId,
                plan_key_snapshot: 'free',
                status:            { [Op.in]: ['active', 'expired'] },
            },
        });

        if (previousFreeActivation) {
            await t.rollback();
            return res.status(409).json({
                success: false,
                message: 'This listing has already used its free plan. Please choose a paid plan to republish.',
                code:    'FREE_PLAN_ALREADY_USED',
            });
        }

        // ── Check: no pending_payment record blocking this listing ────────────
        const pendingPayment = await ServiceAdPayment.findOne({
            where: { listing_id: listingId, status: 'pending_payment' },
        });

        if (pendingPayment) {
            await t.rollback();
            return res.status(409).json({
                success: false,
                message: 'A payment is already in progress for this listing. Please complete or cancel it first.',
                code:    'PAYMENT_IN_PROGRESS',
            });
        }

        // ── Calculate validity window ─────────────────────────────────────────
        const now           = new Date();
        const planExpiresAt = new Date(now.getTime() + freePlan.duration_days * 24 * 60 * 60 * 1000);

        // ── Determine listing status ──────────────────────────────────────────
        // Free plan: goes to pending_review if requires_admin_approval,
        //            otherwise straight to active.
        const newListingStatus = freePlan.requires_admin_approval ? 'pending_review' : 'active';

        // ── Create ServiceAdPayment ───────────────────────────────────────────
        const adPayment = await ServiceAdPayment.create({
            listing_id:                  listingId,
            plan_id:                     freePlan.id,
            wego_payment_id:             null, // no CamPay call for free plan
            paid_by:                     providerUuid,
            plan_key_snapshot:           freePlan.plan_key,
            amount_paid_xaf:             0,
            duration_days_snapshot:      freePlan.duration_days,
            is_hero_placement_snapshot:  false,
            plan_starts_at:              now,
            plan_expires_at:             planExpiresAt,
            status:                      'active',
        }, { transaction: t });

        // ── Update listing ────────────────────────────────────────────────────
        await listing.update({
            status:            newListingStatus,
            current_plan_id:   freePlan.id,
            plan_expires_at:   planExpiresAt,
            plan_activated_at: now,
            boost_priority:    freePlan.boost_priority,
        }, { transaction: t });

        await t.commit();

        console.log(`✅ [AD_PAYMENT] Free plan activated for listing #${listingId} → ${newListingStatus}, expires ${planExpiresAt.toISOString()}`);

        return res.status(200).json({
            success: true,
            message: newListingStatus === 'pending_review'
                ? 'Your listing has been submitted for review. It will go live once approved by our team.'
                : 'Your listing is now live in the marketplace.',
            data: {
                listing_id:      listingId,
                ad_payment_id:   adPayment.id,
                plan_key:        freePlan.plan_key,
                listing_status:  newListingStatus,
                plan_expires_at: planExpiresAt,
                duration_days:   freePlan.duration_days,
            },
        });

    } catch (err) {
        await t.rollback();
        console.error('❌ [AD_PAYMENT] activateFreePlan error:', err.message);
        return res.status(500).json({
            success: false,
            message: 'Unable to activate free plan. Please try again.',
        });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// INITIATE AD PAYMENT (Paid plans)
// POST /api/services/listings/:id/initiate-payment
//
// Body: { plan_id, phone }
//
// Creates a ServiceAdPayment in pending_payment state, then calls
// campayService.initiateCollection so CamPay fires a USSD prompt.
// The webhook finalizes the listing once payment is confirmed.
// ─────────────────────────────────────────────────────────────────────────────

exports.initiateAdPayment = async (req, res) => {
    const t = await sequelize.transaction();

    try {
        const listingId    = parseInt(req.params.id);
        const providerUuid = req.user.uuid;
        const { plan_id, phone } = req.body;

        // ── Input validation ──────────────────────────────────────────────────
        if (!plan_id || isNaN(plan_id)) {
            await t.rollback();
            return res.status(400).json({
                success: false,
                message: 'plan_id is required. Please select a plan.',
            });
        }

        if (!phone) {
            await t.rollback();
            return res.status(400).json({
                success: false,
                message: 'phone is required for payment.',
            });
        }

        // ── Validate listing ownership ────────────────────────────────────────
        const listing = await ServiceListing.findOne({
            where: { id: listingId, provider_id: providerUuid },
            transaction: t,
        });

        if (!listing) {
            await t.rollback();
            return res.status(404).json({
                success: false,
                message: 'Listing not found or you do not have permission.',
            });
        }

        // Listing must be in a publishable state
        const publishableStatuses = ['draft', 'rejected', 'expired', 'inactive'];
        if (!publishableStatuses.includes(listing.status)) {
            await t.rollback();
            return res.status(400).json({
                success: false,
                message: `Cannot initiate payment for a listing with status "${listing.status}".`,
            });
        }

        // ── Validate plan ─────────────────────────────────────────────────────
        const plan = await ServiceListingPlan.findOne({
            where: { id: plan_id, is_active: true },
        });

        if (!plan) {
            await t.rollback();
            return res.status(404).json({
                success: false,
                message: 'Selected plan not found or is no longer available.',
            });
        }

        // Reject free plan through this endpoint — use activate-free instead
        if (plan.price_xaf === 0) {
            await t.rollback();
            return res.status(400).json({
                success: false,
                message: 'Use the free plan activation endpoint for free plans.',
                code:    'USE_FREE_ENDPOINT',
            });
        }

        // ── Check no duplicate pending_payment already exists ─────────────────
        const existingPending = await ServiceAdPayment.findOne({
            where: { listing_id: listingId, status: 'pending_payment' },
        });

        if (existingPending) {
            await t.rollback();
            // Return the existing one so Flutter can resume waiting
            return res.status(200).json({
                success:       true,
                resumed:       true,
                ad_payment_id: existingPending.id,
                message:       'A payment is already in progress. Please check your phone.',
                code:          'PAYMENT_ALREADY_PENDING',
            });
        }

        // ── Create ServiceAdPayment in pending_payment state ──────────────────
        const adPayment = await ServiceAdPayment.create({
            listing_id:                 listingId,
            plan_id:                    plan.id,
            wego_payment_id:            null, // filled by webhook after success
            paid_by:                    providerUuid,
            plan_key_snapshot:          plan.plan_key,
            amount_paid_xaf:            plan.price_xaf,
            duration_days_snapshot:     plan.duration_days,
            is_hero_placement_snapshot: plan.is_hero_placement,
            status:                     'pending_payment',
        }, { transaction: t });

        await t.commit();

        // ── Initiate CamPay collection ────────────────────────────────────────
        // vertical_id = adPayment.id (campayService resolves amount from this)
        let campayResult;
        try {
            campayResult = await campayService.initiateCollection({
                vertical:    'service_request',
                verticalId:  adPayment.id,
                phone,
                initiatedBy: providerUuid,
            });
        } catch (campayErr) {
            // CamPay call failed — cancel the adPayment record so user can retry
            await adPayment.update({
                status:              'cancelled',
                cancelled_at:        new Date(),
                cancellation_reason: `CamPay initiation failed: ${campayErr.message}`,
            });

            console.error('❌ [AD_PAYMENT] CamPay initiation failed:', campayErr.message);

            if (campayErr.campayCode) {
                const codeMap = {
                    ER101: 'Invalid phone number. Please check and try again.',
                    ER102: 'This phone number is not supported. Only MTN and Orange numbers are accepted.',
                    ER301: 'Payment service temporarily unavailable. Please try again shortly.',
                };
                return res.status(400).json({
                    success: false,
                    message: codeMap[campayErr.campayCode] || 'Payment initiation failed.',
                    code:    campayErr.campayCode,
                });
            }

            return res.status(500).json({
                success: false,
                message: 'Failed to initiate payment. Please try again.',
            });
        }

        console.log(`✅ [AD_PAYMENT] Paid plan payment initiated for listing #${listingId}, adPayment #${adPayment.id}`);

        return res.status(200).json({
            success:       true,
            resumed:       false,
            ad_payment_id: adPayment.id,
            payment_id:    campayResult.paymentId,
            campay_ref:    campayResult.campayRef,
            external_ref:  campayResult.externalRef,
            ussd_code:     campayResult.ussdCode,
            operator:      campayResult.operator,
            plan_key:      plan.plan_key,
            amount_xaf:    plan.price_xaf,
            status:        'PENDING',
            message:       'Payment initiated. Please check your phone and enter your PIN.',
        });

    } catch (err) {
        await t.rollback();
        console.error('❌ [AD_PAYMENT] initiateAdPayment error:', err.message);
        return res.status(500).json({
            success: false,
            message: 'Unable to initiate payment. Please try again.',
        });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET AD STATUS FOR LISTING
// GET /api/services/listings/:id/ad-status
//
// Returns the active plan status for a listing.
// Flutter uses this to show "Your ad expires in X days" on the provider dashboard.
// ─────────────────────────────────────────────────────────────────────────────

exports.getAdStatus = async (req, res) => {
    try {
        const listingId    = parseInt(req.params.id);
        const providerUuid = req.user.uuid;

        const listing = await ServiceListing.findOne({
            where: { id: listingId, provider_id: providerUuid },
            attributes: [
                'id', 'listing_id', 'status',
                'current_plan_id', 'plan_expires_at', 'plan_activated_at',
                'is_hero', 'hero_expires_at', 'boost_priority',
            ],
        });

        if (!listing) {
            return res.status(404).json({
                success: false,
                message: 'Listing not found.',
            });
        }

        // Most recent ad payment for this listing
        const latestAdPayment = await ServiceAdPayment.findOne({
            where:   { listing_id: listingId },
            order:   [['created_at', 'DESC']],
            include: [{ association: 'plan', attributes: ['plan_key', 'label_en', 'label_fr', 'price_xaf', 'duration_days'] }],
        });

        // Days remaining on current plan
        const daysRemaining = listing.plan_expires_at
            ? Math.max(0, Math.ceil((new Date(listing.plan_expires_at) - new Date()) / (1000 * 60 * 60 * 24)))
            : 0;

        return res.status(200).json({
            success: true,
            data: {
                listing_id:        listing.listing_id,
                listing_status:    listing.status,
                is_hero:           listing.is_hero,
                boost_priority:    listing.boost_priority,
                plan_expires_at:   listing.plan_expires_at,
                plan_activated_at: listing.plan_activated_at,
                days_remaining:    daysRemaining,
                is_expired:        daysRemaining === 0 && listing.status === 'expired',
                latest_payment:    latestAdPayment ? {
                    id:              latestAdPayment.id,
                    status:          latestAdPayment.status,
                    plan_key:        latestAdPayment.plan_key_snapshot,
                    amount_paid_xaf: latestAdPayment.amount_paid_xaf,
                    plan_starts_at:  latestAdPayment.plan_starts_at,
                    plan_expires_at: latestAdPayment.plan_expires_at,
                    plan:            latestAdPayment.plan,
                } : null,
            },
        });

    } catch (err) {
        console.error('❌ [AD_PAYMENT] getAdStatus error:', err.message);
        return res.status(500).json({
            success: false,
            message: 'Unable to retrieve ad status.',
        });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET MY AD PAYMENT HISTORY
// GET /api/services/ad-payments/history
//
// Paginated list of all ad payments made by the authenticated provider.
// ─────────────────────────────────────────────────────────────────────────────

exports.getMyAdPaymentHistory = async (req, res) => {
    try {
        const providerUuid = req.user.uuid;
        const page         = Math.max(1, parseInt(req.query.page)  || 1);
        const limit        = Math.min(50, parseInt(req.query.limit) || 20);
        const offset       = (page - 1) * limit;

        const { count, rows } = await ServiceAdPayment.findAndCountAll({
            where: { paid_by: providerUuid },
            include: [
                {
                    association: 'listing',
                    attributes:  ['id', 'listing_id', 'title', 'status'],
                },
                {
                    association: 'plan',
                    attributes:  ['plan_key', 'label_en', 'label_fr', 'price_xaf'],
                },
            ],
            order:  [['created_at', 'DESC']],
            limit,
            offset,
        });

        return res.status(200).json({
            success: true,
            data:    rows,
            pagination: {
                total:      count,
                page,
                limit,
                totalPages: Math.ceil(count / limit),
                hasNext:    page < Math.ceil(count / limit),
                hasPrev:    page > 1,
            },
        });

    } catch (err) {
        console.error('❌ [AD_PAYMENT] getMyAdPaymentHistory error:', err.message);
        return res.status(500).json({
            success: false,
            message: 'Unable to retrieve payment history.',
        });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET HERO QUEUE (Admin)
// GET /api/admin/services/hero-queue
//
// Lists all ServiceAdPayments in hero_pending status — these are listings
// where the provider paid for a hero plan and is waiting for admin approval.
// ─────────────────────────────────────────────────────────────────────────────

exports.getHeroQueue = async (req, res) => {
    try {
        const page   = Math.max(1, parseInt(req.query.page)  || 1);
        const limit  = Math.min(50, parseInt(req.query.limit) || 20);
        const offset = (page - 1) * limit;

        const { count, rows } = await ServiceAdPayment.findAndCountAll({
            where: {
                status:                     'hero_pending',
                is_hero_placement_snapshot: true,
            },
            include: [
                {
                    association: 'listing',
                    attributes:  ['id', 'listing_id', 'title', 'description', 'photos', 'city', 'status'],
                },
                {
                    association: 'payer',
                    attributes:  ['uuid', 'first_name', 'last_name', 'phone_e164', 'email'],
                },
                {
                    association: 'plan',
                    attributes:  ['plan_key', 'label_en', 'price_xaf', 'duration_days'],
                },
            ],
            order:  [['created_at', 'ASC']], // oldest first — FIFO queue
            limit,
            offset,
        });

        return res.status(200).json({
            success: true,
            message: 'Hero placement queue retrieved successfully',
            data:    rows,
            pagination: {
                total:      count,
                page,
                limit,
                totalPages: Math.ceil(count / limit),
                hasNext:    page < Math.ceil(count / limit),
                hasPrev:    page > 1,
            },
        });

    } catch (err) {
        console.error('❌ [AD_PAYMENT] getHeroQueue error:', err.message);
        return res.status(500).json({
            success: false,
            message: 'Unable to retrieve hero queue.',
        });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// APPROVE HERO PLACEMENT (Admin)
// POST /api/admin/services/hero-queue/:id/approve
//
// :id = ServiceAdPayment.id
// Approves the hero placement — listing becomes is_hero: true and status: active.
// ─────────────────────────────────────────────────────────────────────────────

exports.approveHeroPlacement = async (req, res) => {
    const t = await sequelize.transaction();

    try {
        const adPaymentId = parseInt(req.params.id);
        const employeeId  = req.user.id;

        const adPayment = await ServiceAdPayment.findByPk(adPaymentId, {
            transaction: t,
        });

        if (!adPayment) {
            await t.rollback();
            return res.status(404).json({
                success: false,
                message: 'Ad payment record not found.',
            });
        }

        if (adPayment.status !== 'hero_pending') {
            await t.rollback();
            return res.status(400).json({
                success: false,
                message: `Cannot approve — record is not in hero_pending state (current: ${adPayment.status}).`,
            });
        }

        const listing = await ServiceListing.findByPk(adPayment.listing_id, {
            transaction: t,
        });

        if (!listing) {
            await t.rollback();
            return res.status(404).json({
                success: false,
                message: 'Associated listing not found.',
            });
        }

        const now = new Date();

        // ── Approve: adPayment → active ───────────────────────────────────────
        await adPayment.update({
            status:            'active',
            hero_reviewed_by:  employeeId,
            hero_reviewed_at:  now,
            plan_starts_at:    now,
            // plan_expires_at already set by webhook finalizer — keep it
        }, { transaction: t });

        // ── Update listing: hero flags + go live ──────────────────────────────
        await listing.update({
            status:            'active',
            is_hero:           true,
            hero_approved_at:  now,
            hero_expires_at:   adPayment.plan_expires_at,
            boost_priority:    2, // Hero always gets max boost
        }, { transaction: t });

        await t.commit();

        console.log(`✅ [AD_PAYMENT] Hero placement approved: adPayment #${adPaymentId}, listing #${listing.id}`);

        return res.status(200).json({
            success: true,
            message: 'Hero placement approved. The listing is now live in the hero section.',
            data: {
                ad_payment_id:   adPayment.id,
                listing_id:      listing.id,
                listing_status:  listing.status,
                is_hero:         listing.is_hero,
                hero_expires_at: listing.hero_expires_at,
            },
        });

    } catch (err) {
        await t.rollback();
        console.error('❌ [AD_PAYMENT] approveHeroPlacement error:', err.message);
        return res.status(500).json({
            success: false,
            message: 'Unable to approve hero placement.',
        });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// REJECT HERO PLACEMENT (Admin)
// POST /api/admin/services/hero-queue/:id/reject
//
// Body: { reason }
// Rejects hero placement — listing falls back to regular active status.
// Provider keeps their money (they paid for a plan, just not hero placement).
// ─────────────────────────────────────────────────────────────────────────────

exports.rejectHeroPlacement = async (req, res) => {
    const t = await sequelize.transaction();

    try {
        const adPaymentId = parseInt(req.params.id);
        const employeeId  = req.user.id;
        const { reason }  = req.body;

        if (!reason || reason.trim().length < 10) {
            await t.rollback();
            return res.status(400).json({
                success: false,
                message: 'Rejection reason is required (minimum 10 characters).',
            });
        }

        const adPayment = await ServiceAdPayment.findByPk(adPaymentId, {
            transaction: t,
        });

        if (!adPayment) {
            await t.rollback();
            return res.status(404).json({
                success: false,
                message: 'Ad payment record not found.',
            });
        }

        if (adPayment.status !== 'hero_pending') {
            await t.rollback();
            return res.status(400).json({
                success: false,
                message: `Cannot reject — record is not in hero_pending state (current: ${adPayment.status}).`,
            });
        }

        const listing = await ServiceListing.findByPk(adPayment.listing_id, {
            transaction: t,
        });

        const now = new Date();

        // ── Reject: adPayment → hero_rejected ────────────────────────────────
        await adPayment.update({
            status:                'hero_rejected',
            hero_reviewed_by:     employeeId,
            hero_reviewed_at:     now,
            hero_rejection_reason: reason.trim(),
        }, { transaction: t });

        // ── Listing falls back to regular active (plan still running) ─────────
        // Provider paid for a plan — the listing stays active, just not in hero.
        if (listing) {
            await listing.update({
                status:       'active',
                is_hero:      false,
                // hero_expires_at: clear it — not a hero anymore
                hero_expires_at: null,
                // boost_priority: falls back to whatever the plan normally provides
                boost_priority: 1,
            }, { transaction: t });
        }

        await t.commit();

        console.log(`✅ [AD_PAYMENT] Hero placement rejected: adPayment #${adPaymentId}`);

        // TODO: Notify provider about rejection with reason

        return res.status(200).json({
            success: true,
            message: 'Hero placement rejected. The listing has been set to regular active status.',
            data: {
                ad_payment_id:  adPayment.id,
                listing_status: listing ? listing.status : null,
                reason:         adPayment.hero_rejection_reason,
            },
        });

    } catch (err) {
        await t.rollback();
        console.error('❌ [AD_PAYMENT] rejectHeroPlacement error:', err.message);
        return res.status(500).json({
            success: false,
            message: 'Unable to reject hero placement.',
        });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// EXPIRE LISTINGS (Internal — called by cron job)
//
// Finds all active ServiceAdPayments whose plan_expires_at has passed,
// sets them to expired, and hides the listing from the marketplace.
//
// Also sends 3-day expiry warnings.
//
// Call this from your cron job file:
//   const { expireListings } = require('../controllers/serviceAdPayment_controller');
//   cron.schedule('0 2 * * *', expireListings); // runs daily at 02:00
// ─────────────────────────────────────────────────────────────────────────────

exports.expireListings = async () => {
    console.log('\n⏰ [AD_EXPIRY CRON] Starting expiry job...');

    const now         = new Date();
    const in3Days     = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    let   expiredCount = 0;
    let   warningCount = 0;

    try {
        // ── 1. Find and expire overdue active plans ───────────────────────────
        const expiredPayments = await ServiceAdPayment.findAll({
            where: {
                status:          'active',
                plan_expires_at: { [Op.lt]: now },
            },
            include: [{
                association: 'listing',
                attributes:  ['id', 'status'],
            }],
        });

        for (const adPayment of expiredPayments) {
            const t = await sequelize.transaction();
            try {
                await adPayment.update({
                    status:                        'expired',
                    expired_notification_sent_at:  now,
                }, { transaction: t });

                if (adPayment.listing) {
                    await adPayment.listing.update({
                        status:      'expired',
                        is_hero:     false,
                        boost_priority: 0,
                    }, { transaction: t });
                }

                await t.commit();
                expiredCount++;

                // TODO: Push notification to provider — "Your listing has expired. Renew to stay visible."

            } catch (err) {
                await t.rollback();
                console.error(`❌ [AD_EXPIRY CRON] Failed to expire adPayment #${adPayment.id}:`, err.message);
            }
        }

        // ── 2. Send 3-day expiry warnings ─────────────────────────────────────
        const soonToExpire = await ServiceAdPayment.findAll({
            where: {
                status:                    'active',
                plan_expires_at:           { [Op.between]: [now, in3Days] },
                expiry_warning_sent_at:    null, // not yet warned
            },
        });

        for (const adPayment of soonToExpire) {
            await adPayment.update({ expiry_warning_sent_at: now });
            warningCount++;

            // TODO: Push notification — "Your listing expires in X days. Renew now."
        }

        console.log(`✅ [AD_EXPIRY CRON] Expired: ${expiredCount} listings | Warnings sent: ${warningCount}`);

    } catch (err) {
        console.error('❌ [AD_EXPIRY CRON] Job failed:', err.message);
    }
};

module.exports = exports;