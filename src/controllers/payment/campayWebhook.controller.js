'use strict';

const jwt                     = require('jsonwebtoken');
const campayService           = require('../../services/campay/campayService');
const deliveryEarningsService = require('../../services/deliveryEarningsService');
const tripMatchingService     = require('../../services/tripMatchingService');
const walletTopUpService      = require('../../services/delivery/walletTopUp.service');
const { searchForDriver }     = require('../delivery.controller');

const {
    WegoPayment,
    Delivery,
    Trip,
    VehicleRental,
    Payment,
    ServiceAdPayment,
    ServiceListing,
    ServiceListingPlan,
    DriverWallet,
    DriverWalletTransaction,
    Account,
    sequelize,
} = require('../../models');

// ── Notification service (lazy — avoids circular dep at startup) ──────────────
const getNotificationService = () => require('../../services/NotificationService');

// ═══════════════════════════════════════════════════════════════════════════════
// WEBHOOK ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

exports.handleWebhook = async (req, res) => {
    const payload = req.body || {};

    // ── 1. Authenticate the webhook ───────────────────────────────────────────
    // CamPay signs every notification with a JWT in `payload.signature`, signed
    // with your app's Webhook Key (CAMPAY_WEBHOOK_SECRET). Verifying it proves
    // the request really came from CamPay.
    const signatureValid = _validateSignature(payload);
    if (!signatureValid) {
        console.error('🚨 [WEBHOOK] Rejected — invalid/missing signature. Possible spoofed request.');
        // 200 so CamPay does not hammer us with retries; we simply do not process it.
        return res.status(200).json({ received: true });
    }

    console.log('\n📨 [WEBHOOK] CamPay notification received');
    console.log(`   external_ref : ${payload.external_reference}`);
    console.log(`   campay_ref   : ${payload.reference}`);
    console.log(`   status       : ${payload.status}`);
    console.log(`   amount       : ${payload.amount} ${payload.currency}`);
    console.log(`   operator     : ${payload.operator}`);

    res.status(200).json({ received: true });

    _processWebhook(payload, req.app.get('io')).catch(err => {
        console.error('❌ [WEBHOOK] _processWebhook unhandled error:', err.message);
        console.error(err.stack);
    });
};

// ═══════════════════════════════════════════════════════════════════════════════
// POLL FINALIZER
// ═══════════════════════════════════════════════════════════════════════════════

exports._finalizeFromPoll = async (payment, payload, io) => {
    console.log(`🔄 [POLL FINALIZER] vertical: ${payment.vertical}, id: ${payment.vertical_id}`);
    try {
        switch (payment.vertical) {
            case 'delivery':       await _finalizeDelivery(payment, payload, io);      break;
            case 'rental':         await _finalizeRental(payment, payload, io);        break;
            case 'listing_fee':    await _finalizeListingFee(payment, payload, io);    break;
            case 'delivery_topup': await _finalizeDeliveryTopUp(payment, payload, io); break;
            case 'fleet_topup':    await _finalizeFleetTopUp(payment, payload, io);    break;
            default:
                console.log(`ℹ️  [POLL FINALIZER] No finalizer for vertical "${payment.vertical}"`);
        }
    } catch (err) {
        console.error(`❌ [POLL FINALIZER] Failed for ${payment.vertical} #${payment.vertical_id}:`, err.message);
        await _recordReconciliation(payment, err);
    }
};

// Same as _finalizeFromPoll but for a FAILED/EXPIRED outcome detected by polling.
// Without this, a poll-detected failure updates only the WegoPayment and leaves
// the vertical's pending record (e.g. a fleet TOP_UP transaction) stuck PENDING.
exports._finalizeFailedFromPoll = async (payment, payload, io) => {
    console.log(`🔄 [POLL FINALIZER] FAILED vertical: ${payment.vertical}, id: ${payment.vertical_id}`);
    try {
        await _finalizeFailed(payment, payload, io);
    } catch (err) {
        console.error(`❌ [POLL FINALIZER] Failure handler failed for ${payment.vertical} #${payment.vertical_id}:`, err.message);
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// PRIVATE — MAIN PROCESSOR
// ═══════════════════════════════════════════════════════════════════════════════

async function _processWebhook(payload, io) {
    const externalRef = payload.external_reference;
    const campayRef   = payload.reference;

    if (!externalRef) {
        console.error('❌ [WEBHOOK] Payload missing external_reference — cannot process.');
        return;
    }

    const payment = await WegoPayment.findOne({ where: { external_ref: externalRef } });
    if (!payment) {
        console.error(`❌ [WEBHOOK] No WegoPayment found for external_ref: ${externalRef}`);
        return;
    }

    if (payment.isResolved) {
        console.log(`ℹ️  [WEBHOOK] ${externalRef} already resolved (${payment.status}) — skipping duplicate.`);
        return;
    }

    // ── Independent verification — never trust the webhook payload blindly ─────
    // Re-query CamPay's own API for the authoritative status + amount. This
    // defeats spoofed/replayed/mismatched-amount webhooks even if signature
    // handling has an edge case, and is the single most important money safeguard.
    const reference = payment.campay_ref || campayRef;
    let authoritative;
    try {
        authoritative = await campayService.checkStatus(reference);
    } catch (err) {
        console.error(`❌ [WEBHOOK] Could not re-verify ${reference} with CamPay — NOT finalizing:`, err.message);
        return; // leave PENDING; the poll finalizer / expiry job will retry
    }

    const campayStatus = authoritative.status;
    if (campayStatus === 'PENDING') {
        console.log(`ℹ️  [WEBHOOK] CamPay still reports ${reference} as PENDING — ignoring premature webhook.`);
        return;
    }

    const newStatus = campayStatus === 'SUCCESSFUL' ? 'SUCCESSFUL' : 'FAILED';

    // ── Amount verification (only meaningful on success) ──────────────────────
    if (newStatus === 'SUCCESSFUL') {
        const paidAmount = Math.round(Number(authoritative.amount));
        if (!Number.isFinite(paidAmount) || paidAmount !== payment.amount) {
            console.error(
                `🚨 [WEBHOOK] AMOUNT MISMATCH for ${externalRef} — ` +
                `expected ${payment.amount} XAF, CamPay reports ${authoritative.amount}. Refusing to finalize.`
            );
            await payment.update({
                status:          'FAILED',
                resolved_at:     new Date(),
                campay_response: { ...authoritative, _reason: 'amount_mismatch' },
                failure_reason:  `amount_mismatch: expected ${payment.amount}, got ${authoritative.amount}`,
            }).catch(() => {});
            return;
        }
    }

    // ── Atomic resolve — only one of {webhook, poll} may win the transition ────
    // Conditional UPDATE ... WHERE status='PENDING' so a concurrent poll can't
    // double-run a finalizer.
    const [affected] = await WegoPayment.update(
        {
            campay_ref:      reference,
            operator:        authoritative.operator || payload.operator || payment.operator,
            campay_response: authoritative,
            status:          newStatus,
            resolved_at:     new Date(),
            ...(newStatus === 'FAILED' && {
                failure_reason: `CamPay status: FAILED | operator: ${authoritative.operator || payload.operator || 'unknown'}`,
            }),
        },
        { where: { id: payment.id, status: 'PENDING' } }
    );

    if (affected === 0) {
        console.log(`ℹ️  [WEBHOOK] ${externalRef} was resolved concurrently — skipping finalizer.`);
        return;
    }

    await payment.reload();
    console.log(`${newStatus === 'SUCCESSFUL' ? '✅' : '❌'} [WEBHOOK] WegoPayment ${externalRef} → ${newStatus}`);

    if (newStatus === 'SUCCESSFUL') {
        await _finalizeSuccessful(payment, payload, io);
    } else {
        await _finalizeFailed(payment, payload, io);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUCCESS ROUTER
// ═══════════════════════════════════════════════════════════════════════════════

async function _finalizeSuccessful(payment, payload, io) {
    const { vertical, vertical_id } = payment;
    console.log(`🔀 [WEBHOOK] Routing successful payment → vertical: ${vertical}, id: ${vertical_id}`);

    try {
        switch (vertical) {
            case 'delivery':       await _finalizeDelivery(payment, payload, io);      break;
            case 'rental':         await _finalizeRental(payment, payload, io);        break;
            case 'listing_fee':    await _finalizeListingFee(payment, payload, io);    break;
            case 'delivery_topup': await _finalizeDeliveryTopUp(payment, payload, io); break;
            case 'fleet_topup':    await _finalizeFleetTopUp(payment, payload, io);    break;
            default:
                console.log(`ℹ️  [WEBHOOK] vertical "${vertical}" has no finalizer — likely a disbursement.`);
        }
    } catch (err) {
        console.error(`❌ [WEBHOOK] Finalizer failed for ${vertical} #${vertical_id}:`, err.message);
        await _recordReconciliation(payment, err);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// VERTICAL FINALIZERS — SUCCESS
// ═══════════════════════════════════════════════════════════════════════════════

// ── TRIP — removed: rides are never paid through CamPay (fare is P2P). ─────────

// ── DELIVERY ──────────────────────────────────────────────────────────────────

async function _finalizeDelivery(payment, payload, io) {
    const deliveryId = parseInt(payment.vertical_id);

    const delivery = await Delivery.findByPk(deliveryId);
    if (!delivery) {
        console.error(`❌ [WEBHOOK][DELIVERY] Delivery ${deliveryId} not found`);
        return;
    }

    if (delivery.payment_status === 'paid') {
        console.log(`ℹ️  [WEBHOOK][DELIVERY] Delivery ${deliveryId} already paid — skipping.`);
        return;
    }

    await delivery.update({ payment_status: 'paid', paid_at: new Date() });

    searchForDriver(deliveryId, io).catch(err => {
        console.error(`❌ [WEBHOOK][DELIVERY] searchForDriver failed for ${deliveryId}:`, err.message);
    });

    _emitToUser(io, delivery.sender_id, 'payment:confirmed', {
        vertical:   'delivery',
        verticalId: deliveryId,
        amount:     payment.amount,
        operator:   payload.operator,
        message:    'Payment confirmed! Searching for a driver...',
    });

    console.log(`✅ [WEBHOOK][DELIVERY] Delivery ${deliveryId} payment finalised — driver search started`);
}

// ── RENTAL ────────────────────────────────────────────────────────────────────

async function _finalizeRental(payment, payload, io) {
    const rentalId = payment.vertical_id;

    const rental = await VehicleRental.findByPk(rentalId);
    if (!rental) {
        console.error(`❌ [WEBHOOK][RENTAL] VehicleRental ${rentalId} not found`);
        return;
    }

    await rental.update({
        paymentStatus:  'paid',
        paymentMethod:  payload.operator === 'MTN' ? 'mtn_momo' : 'orange_money',
        transactionRef: payload.reference,
    });

    _emitToUser(io, rental.userId, 'payment:confirmed', {
        vertical:   'rental',
        verticalId: rentalId,
        amount:     payment.amount,
        operator:   payload.operator,
        message:    'Payment confirmed! Your rental request is pending admin approval.',
    });

    console.log(`✅ [WEBHOOK][RENTAL] VehicleRental ${rentalId} payment finalised`);
}

// ── LISTING FEE ───────────────────────────────────────────────────────────────

async function _finalizeListingFee(payment, payload, io) {
    const adPaymentId = parseInt(payment.vertical_id);

    const adPayment = await ServiceAdPayment.findByPk(adPaymentId, {
        include: [{ model: ServiceListingPlan, as: 'plan' }],
    });
    if (!adPayment) {
        console.error(`❌ [WEBHOOK][LISTING_FEE] ServiceAdPayment ${adPaymentId} not found`);
        return;
    }

    // ── PROVIDER-LEVEL SUBSCRIPTION (listing_id = null) ──────────────────────
    // A paid subscription grants the provider a posting quota; there is no
    // single listing to activate. Just mark the subscription active + set its
    // validity window, then notify the provider.
    if (adPayment.listing_id == null) {
        const now  = new Date();
        const exp  = new Date(now.getTime() + adPayment.duration_days_snapshot * 24 * 60 * 60 * 1000);
        await adPayment.update({
            status:          'active',
            wego_payment_id: payment.id,
            plan_starts_at:  now,
            plan_expires_at: exp,
        });
        _emitToUser(io, adPayment.paid_by, 'subscription:activated', {
            ad_payment_id:   adPayment.id,
            plan_key:        adPayment.plan_key_snapshot,
            listing_quota:   adPayment.plan?.listing_quota ?? null,
            plan_expires_at: exp,
        });
        console.log(`✅ [WEBHOOK][SUBSCRIPTION] Subscription #${adPayment.id} activated for provider ${adPayment.paid_by} until ${exp.toISOString()}`);
        return;
    }

    const listing = await ServiceListing.findByPk(adPayment.listing_id);
    if (!listing) {
        console.error(`❌ [WEBHOOK][LISTING_FEE] ServiceListing ${adPayment.listing_id} not found`);
        return;
    }

    const plan          = adPayment.plan;
    const now           = new Date();
    const planExpiresAt = new Date(
        now.getTime() + adPayment.duration_days_snapshot * 24 * 60 * 60 * 1000
    );
    const newAdStatus = adPayment.is_hero_placement_snapshot ? 'hero_pending' : 'active';

    // Listing status: hero goes to hero_pending; paid non-hero respects admin approval flag;
    // free plans (no DB payment path here — handled by activateFreePlan) default to active.
    const requiresApproval = plan?.requires_admin_approval ?? true;
    const newListingStatus = adPayment.is_hero_placement_snapshot
        ? 'hero_pending'
        : requiresApproval ? 'pending_review' : 'active';

    const boostPriority = plan?.boost_priority ?? (adPayment.is_hero_placement_snapshot ? 2 : 1);

    await adPayment.update({
        status:          newAdStatus,
        wego_payment_id: payment.id,
        plan_starts_at:  now,
        plan_expires_at: planExpiresAt,
    });

    await listing.update({
        status:            newListingStatus,
        current_plan_id:   adPayment.plan_id,
        plan_expires_at:   planExpiresAt,
        plan_activated_at: now,
        boost_priority:    boostPriority,
    });

    _emitToUser(io, adPayment.paid_by, 'listing:payment_confirmed', {
        vertical:        'listing_fee',
        ad_payment_id:   adPayment.id,
        listing_id:      listing.id,
        listing_status:  newListingStatus,
        plan_key:        adPayment.plan_key_snapshot,
        plan_expires_at: planExpiresAt,
        is_hero:         adPayment.is_hero_placement_snapshot,
        amount:          payment.amount,
        operator:        payload.operator,
        message:         adPayment.is_hero_placement_snapshot
            ? 'Payment confirmed! Your listing is under review for hero placement.'
            : newListingStatus === 'active'
                ? 'Payment confirmed! Your listing is now live.'
                : 'Payment confirmed! Your listing is under review and will be live soon.',
    });

    console.log(
        `✅ [WEBHOOK][LISTING_FEE] ServiceAdPayment ${adPaymentId} → ${newAdStatus}, ` +
        `listing ${listing.id} → ${newListingStatus}`
    );
}

// ── DELIVERY AGENT WALLET TOP-UP ──────────────────────────────────────────────

async function _finalizeDeliveryTopUp(payment, payload, io) {
    const topUpId = parseInt(payment.vertical_id);

    console.log(`💰 [WEBHOOK][DELIVERY_TOPUP] Processing top-up #${topUpId}`);

    let result;
    try {
        result = await walletTopUpService.creditWalletAutomatically(topUpId);
    } catch (err) {
        console.error(
            `❌ [WEBHOOK][DELIVERY_TOPUP] creditWalletAutomatically failed for #${topUpId}:`,
            err.message
        );
        await walletTopUpService.failTopUp(topUpId, err.message).catch(() => {});

        // ── 🔔 NOTIFICATION: Top-up failed ───────────────────────────────
        // Try to find the driver account UUID for the notification
        try {
            const { Driver } = require('../../models');
            const topUpRecord = await require('../../models').DeliveryWalletTopUp?.findByPk(topUpId, { attributes: ['driver_id'] });
            if (topUpRecord) {
                const driverRecord = await Driver.findByPk(topUpRecord.driver_id, { attributes: ['userId'] });
                if (driverRecord?.userId) {
                    getNotificationService().send({
                        accountUuid: driverRecord.userId,
                        type:        'WALLET_TOPUP_FAILED',
                        title:       'Top-up failed',
                        body:        'Your wallet top-up could not be processed. Please try again.',
                        data:        { screen: 'wallet' },
                    }).catch(() => {});
                }
            }
        } catch (_) { /* non-critical */ }

        return;
    }

    if (result.alreadyCredited) {
        console.log(`ℹ️  [WEBHOOK][DELIVERY_TOPUP] Top-up #${topUpId} already credited — skipping duplicate.`);
        return;
    }

    // ── Resolve driver account UUID ───────────────────────────────────────────
    let driverAccountUuid = null;

    try {
        const topUp = result.topUp;
        if (topUp.driver?.userId) {
            driverAccountUuid = topUp.driver.userId;
        } else {
            const driver = await topUp.getDriver?.();
            if (driver?.userId) {
                driverAccountUuid = driver.userId;
            } else {
                const { Driver } = require('../../models');
                const driverRecord = await Driver.findByPk(topUp.driver_id, { attributes: ['userId'] });
                driverAccountUuid = driverRecord?.userId || null;
            }
        }
    } catch (lookupErr) {
        console.warn(`⚠️  [WEBHOOK][DELIVERY_TOPUP] Could not resolve driver UUID:`, lookupErr.message);
    }

    if (driverAccountUuid) {
        // ── Socket event ──────────────────────────────────────────────────────
        _emitToUser(io, driverAccountUuid, 'wallet:topped_up', {
            topup_code:      result.topUp.topup_code,
            amount:          result.creditAmount,
            balance_before:  result.balanceBefore,
            balance_after:   result.balanceAfter,
            operator:        payload.operator,
            payment_channel: result.topUp.payment_channel,
            message:         `${result.creditAmount.toLocaleString()} XAF added to your wallet.`,
        });

        // ── 🔔 NOTIFICATION: Top-up successful ────────────────────────────────
        getNotificationService().send({
            accountUuid: driverAccountUuid,
            type:        'WALLET_TOPUP_SUCCESS',
            title:       '💰 Wallet topped up!',
            body:        `${result.creditAmount.toLocaleString()} XAF has been added to your wallet. New balance: ${result.balanceAfter.toLocaleString()} XAF.`,
            data: {
                screen:        'wallet',
                amount:        String(result.creditAmount),
                balance_after: String(result.balanceAfter),
            },
        }).catch(e => console.warn('⚠️  [WEBHOOK] Top-up push failed:', e.message));

        console.log(`📡 [WEBHOOK][DELIVERY_TOPUP] Notifications sent to ${driverAccountUuid}`);
    }

    console.log(
        `✅ [WEBHOOK][DELIVERY_TOPUP] Top-up #${topUpId} credited — ` +
        `${result.creditAmount.toLocaleString()} XAF | ` +
        `balance: ${result.balanceBefore.toLocaleString()} → ${result.balanceAfter.toLocaleString()}`
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// FLEET_TOPUP — a fleet owner topped up a driver's wallet via CamPay.
// vertical_id = DriverWalletTransaction.id (the PENDING TOP_UP row).
// This is the ONLY path that credits a fleet driver's wallet. Fully ACID and
// idempotent: a duplicate webhook / poll finalisation is a no-op.
// ─────────────────────────────────────────────────────────────────────────────
async function _finalizeFleetTopUp(payment, payload, io) {
    const txnId = payment.vertical_id;
    console.log(`💰 [WEBHOOK][FLEET_TOPUP] Processing top-up transaction ${txnId}`);

    const t = await sequelize.transaction();
    try {
        // ── Lock the pending transaction row ──────────────────────────────────
        const txn = await DriverWalletTransaction.findOne({
            where: { id: txnId },
            lock:  t.LOCK.UPDATE,
            transaction: t,
        });

        if (!txn) {
            await t.rollback();
            console.error(`❌ [WEBHOOK][FLEET_TOPUP] Transaction ${txnId} not found`);
            return;
        }

        // Idempotency: already credited → no-op.
        if (txn.topUpStatus === 'COMPLETED') {
            await t.rollback();
            console.log(`ℹ️  [WEBHOOK][FLEET_TOPUP] Transaction ${txnId} already COMPLETED — skipping duplicate`);
            return;
        }
        if (txn.topUpStatus !== 'PENDING') {
            await t.rollback();
            console.log(`ℹ️  [WEBHOOK][FLEET_TOPUP] Transaction ${txnId} is '${txn.topUpStatus}', not PENDING — skipping`);
            return;
        }

        // ── Lock the wallet + apply the credit ────────────────────────────────
        const wallet = await DriverWallet.findOne({
            where: { id: txn.walletId },
            lock:  t.LOCK.UPDATE,
            transaction: t,
        });
        if (!wallet) {
            await t.rollback();
            console.error(`❌ [WEBHOOK][FLEET_TOPUP] Wallet ${txn.walletId} not found for transaction ${txnId}`);
            return;
        }

        const amount        = parseInt(txn.amount, 10);
        const balanceBefore  = parseInt(wallet.balance, 10) || 0;
        const balanceAfter   = balanceBefore + amount;

        await DriverWallet.update(
            {
                balance:     require('sequelize').literal(`balance + ${amount}`),
                totalTopUps: require('sequelize').literal(`totalTopUps + ${amount}`),
                lastTopUpAt: new Date(),
            },
            { where: { id: wallet.id }, transaction: t }
        );

        // Finalise the ledger row: mark COMPLETED and snapshot the real balance.
        const operator = payload.operator || null;
        const method   = operator === 'ORANGE' ? 'ORANGE_MONEY' : (operator === 'MTN' ? 'MTN_MOMO' : txn.topUpMethod);
        await txn.update({
            topUpStatus:  'COMPLETED',
            balanceAfter,
            ...(method ? { topUpMethod: method } : {}),
        }, { transaction: t });

        await t.commit();

        console.log(
            `✅ [WEBHOOK][FLEET_TOPUP] Transaction ${txnId} credited — ` +
            `${amount.toLocaleString()} XAF | balance: ${balanceBefore.toLocaleString()} → ${balanceAfter.toLocaleString()}`
        );

        // ── Notify the driver + the fleet owner ───────────────────────────────
        if (io) {
            _emitToUser(io, txn.driverId, 'wallet:credited', {
                transaction_id: txn.id, amount, new_balance: balanceAfter, source: 'fleet_topup',
            });
            const partnerId = txn.metadata?.partnerId || payment.initiated_by;
            if (partnerId) {
                _emitToUser(io, partnerId, 'fleet:topup_succeeded', {
                    transaction_id: txn.id, driver_uuid: txn.driverId, amount, new_balance: balanceAfter,
                });
            }
        }

        try {
            getNotificationService().send({
                accountUuid: txn.driverId,
                type:        'WALLET_TOPUP_SUCCESS',
                title:       'Wallet topped up',
                body:        `Your wallet was credited with ${amount.toLocaleString()} XAF by your fleet.`,
                data:        { screen: 'wallet' },
            }).catch(() => {});
        } catch (_) { /* non-critical */ }

    } catch (err) {
        try { await t.rollback(); } catch (_) {}
        console.error(`❌ [WEBHOOK][FLEET_TOPUP] Failed to credit transaction ${txnId}:`, err.message);
        throw err;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FAILURE ROUTER
// ═══════════════════════════════════════════════════════════════════════════════

async function _finalizeFailed(payment, payload, io) {
    const { vertical, vertical_id, initiated_by } = payment;

    console.log(`🔀 [WEBHOOK] Routing failed payment → vertical: ${vertical}, id: ${vertical_id}`);

    if (initiated_by) {
        _emitToUser(io, initiated_by, 'payment:failed', {
            vertical,
            verticalId: vertical_id,
            amount:     payment.amount,
            reason:     'Payment was declined or cancelled. Please try again.',
        });
    }

    switch (vertical) {

        case 'delivery':
            await Delivery.update(
                { payment_status: 'pending' },
                { where: { id: parseInt(vertical_id) } }
            ).catch(() => {});
            console.log(`ℹ️  [WEBHOOK][DELIVERY] Delivery ${vertical_id} payment failed — reset to pending`);
            break;

        case 'listing_fee':
            await ServiceAdPayment.update(
                { status: 'pending_payment' },
                { where: { id: parseInt(vertical_id) } }
            ).catch(() => {});
            console.log(`ℹ️  [WEBHOOK][${vertical.toUpperCase()}] ServiceAdPayment ${vertical_id} reset to pending_payment`);
            break;

        case 'rental':
            console.log(`ℹ️  [WEBHOOK][RENTAL] Rental ${vertical_id} payment failed — stays PENDING`);
            break;

        case 'delivery_topup': {
            const failReason = payload.reason || 'Payment was declined or cancelled.';
            await walletTopUpService.failTopUp(parseInt(vertical_id), failReason).catch(err => {
                console.error(`❌ [WEBHOOK][DELIVERY_TOPUP] failTopUp failed for #${vertical_id}:`, err.message);
            });
            console.log(`ℹ️  [WEBHOOK][DELIVERY_TOPUP] TopUp #${vertical_id} marked campay_failed`);

            // ── 🔔 NOTIFICATION: Top-up failed (via failure router) ───────────
            if (initiated_by) {
                getNotificationService().send({
                    accountUuid: initiated_by,
                    type:        'WALLET_TOPUP_FAILED',
                    title:       'Top-up failed',
                    body:        'Your wallet top-up was declined or cancelled. Please try again.',
                    data:        { screen: 'wallet' },
                }).catch(() => {});
            }
            break;
        }

        case 'fleet_topup': {
            // Mark the pending TOP_UP transaction FAILED. The wallet was never
            // touched, so there is nothing to reverse — just close the record.
            const txn = await DriverWalletTransaction.findByPk(vertical_id).catch(() => null);
            if (txn && txn.topUpStatus === 'PENDING') {
                await txn.update({ topUpStatus: 'FAILED' }).catch(() => {});
                console.log(`ℹ️  [WEBHOOK][FLEET_TOPUP] Transaction ${vertical_id} marked FAILED — nothing credited`);
                if (io && txn.driverId) {
                    _emitToUser(io, txn.driverId, 'wallet:topup_failed', {
                        transaction_id: txn.id, amount: parseInt(txn.amount, 10),
                    });
                }
            }
            if (initiated_by) {
                _emitToUser(io, initiated_by, 'fleet:topup_failed', {
                    transaction_id: vertical_id,
                    message: 'The mobile money payment was declined or cancelled. The driver was not credited.',
                });
            }
            break;
        }

        default:
            console.log(`ℹ️  [WEBHOOK] vertical "${vertical}" has no failure handler — likely a disbursement.`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

// CamPay signs each webhook with a JWT placed in the `signature` field of the
// payload, signed (HS256) with your application's Webhook Key. We verify that
// JWT with CAMPAY_WEBHOOK_SECRET. This is the documented CamPay mechanism — it
// is NOT an HMAC header. Regardless of the outcome here, _processWebhook also
// independently re-queries CamPay's API before crediting (defence in depth).
function _validateSignature(payload) {
    const secret = process.env.CAMPAY_WEBHOOK_SECRET;
    const isProd = process.env.NODE_ENV === 'production';

    // Fail CLOSED in production: never process an unauthenticated webhook.
    if (!secret) {
        if (isProd) {
            console.error('🚨 [WEBHOOK] CAMPAY_WEBHOOK_SECRET not set in production — rejecting.');
            return false;
        }
        console.warn('⚠️  [WEBHOOK] CAMPAY_WEBHOOK_SECRET not set — skipping validation (DEV only).');
        return true;
    }

    const token = payload && payload.signature;
    if (!token) {
        if (isProd) {
            console.warn('⚠️  [WEBHOOK] No signature in payload (production) — rejecting.');
            return false;
        }
        console.warn('⚠️  [WEBHOOK] No signature in payload — allowing in non-production (sandbox).');
        return true;
    }

    try {
        jwt.verify(token, secret); // throws on invalid signature/expiry
        return true;
    } catch (err) {
        console.error('🚨 [WEBHOOK] Signature JWT verification failed:', err.message);
        return false;
    }
}

// Durable record when a finalizer fails AFTER money is confirmed received.
// We never silently swallow these — the money moved, the vertical action did
// not. The error is stamped onto the payment's campay_response JSON so it is
// queryable (WHERE JSON_EXTRACT(campay_response,'$._finalizer_error') IS NOT NULL)
// and logged at error level for alerting.
async function _recordReconciliation(payment, err) {
    try {
        const existing = (payment.campay_response && typeof payment.campay_response === 'object')
            ? payment.campay_response
            : {};
        await payment.update({
            campay_response: {
                ...existing,
                _finalizer_error: err.message,
                _needs_reconciliation: true,
                _flagged_at: new Date().toISOString(),
            },
        });
        console.error(
            `🧾 [RECONCILIATION] payment=${payment.id} vertical=${payment.vertical} ` +
            `vertical_id=${payment.vertical_id} amount=${payment.amount} — MONEY RECEIVED but finalizer failed: ${err.message}`
        );
    } catch (e) {
        console.error('❌ [RECONCILIATION] Failed to record reconciliation flag:', e.message);
    }
}

function _emitToUser(io, userUuid, event, data) {
    if (!io || !userUuid) return;
    io.to(`passenger:${userUuid}`).emit(event, data);
    io.to(`user:${userUuid}`).emit(event, data);
}