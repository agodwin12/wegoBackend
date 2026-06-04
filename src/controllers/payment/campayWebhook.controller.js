'use strict';

const crypto                  = require('crypto');
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
} = require('../../models');

// ── Notification service (lazy — avoids circular dep at startup) ──────────────
const getNotificationService = () => require('../../services/NotificationService');

// ═══════════════════════════════════════════════════════════════════════════════
// WEBHOOK ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

exports.handleWebhook = async (req, res) => {
    const signatureValid = _validateSignature(req);
    if (!signatureValid) {
        console.error('🚨 [WEBHOOK] Rejected — invalid signature. Possible spoofed request.');
        return res.status(200).json({ received: true });
    }

    const payload = req.body;

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
            case 'trip':            await _finalizeTrip(payment, payload, io);           break;
            case 'delivery':        await _finalizeDelivery(payment, payload, io);       break;
            case 'service_request': await _finalizeServiceRequest(payment, payload, io); break;
            case 'rental':          await _finalizeRental(payment, payload, io);         break;
            case 'listing_fee':     await _finalizeListingFee(payment, payload, io);     break;
            case 'delivery_topup':  await _finalizeDeliveryTopUp(payment, payload, io);  break;
            default:
                console.log(`ℹ️  [POLL FINALIZER] No finalizer for vertical "${payment.vertical}"`);
        }
    } catch (err) {
        console.error(`❌ [POLL FINALIZER] Failed for ${payment.vertical} #${payment.vertical_id}:`, err.message);
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// PRIVATE — MAIN PROCESSOR
// ═══════════════════════════════════════════════════════════════════════════════

async function _processWebhook(payload, io) {
    const externalRef  = payload.external_reference;
    const campayRef    = payload.reference;
    const campayStatus = payload.status;

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

    const newStatus = campayStatus === 'SUCCESSFUL' ? 'SUCCESSFUL' : 'FAILED';

    await payment.update({
        campay_ref:      campayRef,
        operator:        payload.operator || payment.operator,
        campay_response: payload,
        status:          newStatus,
        resolved_at:     new Date(),
        ...(newStatus === 'FAILED' && {
            failure_reason: payload.reason
                ? `${payload.reason} | operator: ${payload.operator || 'unknown'}`
                : `CamPay status: FAILED | operator: ${payload.operator || 'unknown'}`,
        }),
    });

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
            case 'trip':            await _finalizeTrip(payment, payload, io);           break;
            case 'delivery':        await _finalizeDelivery(payment, payload, io);       break;
            case 'service_request': await _finalizeServiceRequest(payment, payload, io); break;
            case 'rental':          await _finalizeRental(payment, payload, io);         break;
            case 'listing_fee':     await _finalizeListingFee(payment, payload, io);     break;
            case 'delivery_topup':  await _finalizeDeliveryTopUp(payment, payload, io);  break;
            default:
                console.log(`ℹ️  [WEBHOOK] vertical "${vertical}" has no finalizer — likely a disbursement.`);
        }
    } catch (err) {
        console.error(`❌ [WEBHOOK] Finalizer failed for ${vertical} #${vertical_id}:`, err.message);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// VERTICAL FINALIZERS — SUCCESS
// ═══════════════════════════════════════════════════════════════════════════════

// ── TRIP ──────────────────────────────────────────────────────────────────────

async function _finalizeTrip(payment, payload, io) {
    const tripId = payment.vertical_id;

    const trip = await Trip.findByPk(tripId);
    if (!trip) {
        console.error(`❌ [WEBHOOK][TRIP] Trip ${tripId} not found`);
        return;
    }

    await Payment.update(
        { status: 'settled', reference: payload.reference },
        { where: { tripId, status: 'pending' } }
    ).catch(() => {});

    if (trip.status === 'SEARCHING') {
        console.log(`🚕 [WEBHOOK][TRIP] Starting driver matching for trip ${tripId}`);
        tripMatchingService.broadcastTripToDrivers(tripId, io).catch(err => {
            console.error(`❌ [WEBHOOK][TRIP] broadcastTripToDrivers failed:`, err.message);
        });
    }

    _emitToUser(io, trip.passengerId, 'payment:confirmed', {
        vertical:   'trip',
        verticalId: tripId,
        amount:     payment.amount,
        operator:   payload.operator,
        message:    'Payment confirmed! Finding you a driver...',
    });

    console.log(`✅ [WEBHOOK][TRIP] Trip ${tripId} payment finalised`);
}

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

// ── SERVICE REQUEST ───────────────────────────────────────────────────────────

async function _finalizeServiceRequest(payment, payload, io) {
    await _finalizeListingFee(payment, payload, io);
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

    const adPayment = await ServiceAdPayment.findByPk(adPaymentId);
    if (!adPayment) {
        console.error(`❌ [WEBHOOK][LISTING_FEE] ServiceAdPayment ${adPaymentId} not found`);
        return;
    }

    const listing = await ServiceListing.findByPk(adPayment.listing_id);
    if (!listing) {
        console.error(`❌ [WEBHOOK][LISTING_FEE] ServiceListing ${adPayment.listing_id} not found`);
        return;
    }

    const now           = new Date();
    const planExpiresAt = new Date(
        now.getTime() + adPayment.duration_days_snapshot * 24 * 60 * 60 * 1000
    );
    const newAdStatus = adPayment.is_hero_placement_snapshot ? 'hero_pending' : 'active';

    await adPayment.update({
        status:          newAdStatus,
        wego_payment_id: payment.id,
        plan_starts_at:  now,
        plan_expires_at: planExpiresAt,
    });

    await listing.update({
        status:            'pending',
        current_plan_id:   adPayment.plan_id,
        plan_expires_at:   planExpiresAt,
        plan_activated_at: now,
        boost_priority:    adPayment.is_hero_placement_snapshot ? 2 : 1,
    });

    _emitToUser(io, adPayment.paid_by, 'listing:payment_confirmed', {
        vertical:        'listing_fee',
        ad_payment_id:   adPayment.id,
        listing_id:      listing.id,
        listing_status:  'pending',
        plan_key:        adPayment.plan_key_snapshot,
        plan_expires_at: planExpiresAt,
        is_hero:         adPayment.is_hero_placement_snapshot,
        amount:          payment.amount,
        operator:        payload.operator,
        message:         adPayment.is_hero_placement_snapshot
            ? 'Payment confirmed! Your listing is under review for hero placement.'
            : 'Payment confirmed! Your listing is under review and will be live soon.',
    });

    console.log(
        `✅ [WEBHOOK][LISTING_FEE] ServiceAdPayment ${adPaymentId} → ${newAdStatus}, ` +
        `listing ${listing.id} → pending`
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

        case 'trip':
            console.log(`ℹ️  [WEBHOOK][TRIP] Trip ${vertical_id} payment failed — stays SEARCHING`);
            break;

        case 'delivery':
            await Delivery.update(
                { payment_status: 'pending' },
                { where: { id: parseInt(vertical_id) } }
            ).catch(() => {});
            console.log(`ℹ️  [WEBHOOK][DELIVERY] Delivery ${vertical_id} payment failed — reset to pending`);
            break;

        case 'service_request':
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

        default:
            console.log(`ℹ️  [WEBHOOK] vertical "${vertical}" has no failure handler — likely a disbursement.`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function _validateSignature(req) {
    const secret = process.env.CAMPAY_WEBHOOK_SECRET;

    if (!secret) {
        if (process.env.NODE_ENV === 'production') {
            console.error('🚨 [WEBHOOK] CAMPAY_WEBHOOK_SECRET not set in production!');
        } else {
            console.warn('⚠️  [WEBHOOK] CAMPAY_WEBHOOK_SECRET not set — skipping validation (DEV only).');
        }
        return true;
    }

    const receivedSig = req.headers['signature'] || req.headers['x-campay-signature'];

    if (!receivedSig) {
        if (process.env.NODE_ENV !== 'production') {
            console.warn('⚠️  [WEBHOOK] No signature header — allowing in non-production (sandbox mode).');
            return true;
        }
        console.warn('⚠️  [WEBHOOK] No signature header in production — rejecting.');
        return false;
    }

    const rawBody     = req.rawBody || JSON.stringify(req.body);
    const expectedSig = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex');

    try {
        return crypto.timingSafeEqual(
            Buffer.from(receivedSig,  'hex'),
            Buffer.from(expectedSig, 'hex')
        );
    } catch {
        return false;
    }
}

function _emitToUser(io, userUuid, event, data) {
    if (!io || !userUuid) return;
    io.to(`passenger:${userUuid}`).emit(event, data);
    io.to(`user:${userUuid}`).emit(event, data);
}