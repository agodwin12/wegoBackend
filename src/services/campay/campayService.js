// services/campay/campayService.js
//
// ═══════════════════════════════════════════════════════════════════════════════
// CAMPAY SERVICE  —  WeGo Business Logic Layer
// ═══════════════════════════════════════════════════════════════════════════════
//
// CHANGELOG:
//   v2 — service_request vertical now resolves amount from ServiceAdPayment
//        (listing plan price) instead of ServiceRequest.final_amount.
//        vertical_id for service_request is now a ServiceAdPayment.id (integer).
//        ServiceRequest import removed; ServiceAdPayment added.
//
//   v3 — delivery_topup vertical added.
//        verticalId = DeliveryWalletTopUp.id
//        Resolves amount from DeliveryWalletTopUp.amount.
//        Used when delivery agents top up via MTN/Orange — no manual proof needed.
//        Duplicate ServiceAdPayment import in v2 fixed.
//        LISTING_FEE vertical merged into SERVICE_REQUEST (both resolve from
//        ServiceAdPayment) — LISTING_FEE kept as alias so existing callers don't break.
//
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const { v4: uuidv4 } = require('uuid');
const campayClient   = require('./campayClient');

const {
    WegoPayment,
    Trip,
    Delivery,
    ServiceAdPayment,
    VehicleRental,
    DeliveryWalletTopUp,
    DriverWalletTransaction,
} = require('../../models');

// ── Vertical identifiers ──────────────────────────────────────────────────────
// Must match WegoPayment.vertical ENUM exactly.
const VERTICALS = {
    DELIVERY:         'delivery',
    SERVICE_REQUEST:  'service_request',
    RENTAL:           'rental',
    LISTING_FEE:      'listing_fee',      // alias — resolves from ServiceAdPayment
    DELIVERY_TOPUP:   'delivery_topup',   // agent wallet reload via MoMo/Orange
    FLEET_TOPUP:      'fleet_topup',      // fleet owner reloads a driver's wallet via MoMo/Orange
};

// Disbursements (withdrawals) are intentionally NOT supported — WeGo is
// deposit/top-up only. Money only ever flows IN via collections.

// ─────────────────────────────────────────────────────────────────────────────

class CamPayService {

    // ═══════════════════════════════════════════════════════════════════════════
    // INITIATE COLLECTION
    //
    // Charge a customer/agent for one of WeGo's verticals.
    // Amount is always re-fetched from the DB — never trusted from the caller.
    //
    // For delivery_topup:
    //   verticalId = DeliveryWalletTopUp.id
    //   The DeliveryWalletTopUp record must already exist with status
    //   'campay_pending', created by walletTopUp.service before calling this.
    //
    // For service_request / listing_fee:
    //   verticalId = ServiceAdPayment.id
    //
    // @param {object} params
    //   @param {string} params.vertical      — see VERTICALS above
    //   @param {number} params.verticalId    — PK of the relevant record
    //   @param {string} params.phone         — payer phone (9 digits or 237xxxxxxxxx)
    //   @param {string} params.initiatedBy   — account UUID of the person paying
    //
    // @returns {object}
    //   { success: true, paymentId, campayRef, externalRef, ussdCode, operator, status: 'PENDING' }
    // ═══════════════════════════════════════════════════════════════════════════

    async initiateCollection({ vertical, verticalId, phone, initiatedBy }) {

        // ── 1. Validate vertical ──────────────────────────────────────────────
        if (!Object.values(VERTICALS).includes(vertical)) {
            throw new Error(
                `[CAMPAY SERVICE] Unknown vertical: "${vertical}". ` +
                `Must be one of: ${Object.values(VERTICALS).join(', ')}`
            );
        }

        // ── 2. Normalise phone → 237xxxxxxxxx ────────────────────────────────
        const normalisedPhone = _normalisePhone(phone);

        // ── 3. Fetch amount from DB (never trust the client) ──────────────────
        const { amount, description } = await _resolveAmountAndDescription(vertical, verticalId);

        // ── 4. Build unique external reference ────────────────────────────────
        // Format: WEGO-{VERTICAL_SHORT}-{ID}-{UUID_SHORT}
        // Traceable in logs, unique per attempt (UUID suffix), under 50 chars.
        const shortId      = String(verticalId).slice(0, 12);
        const shortUuid    = uuidv4().replace(/-/g, '').slice(0, 10).toUpperCase();
        const verticalCode = _verticalCode(vertical);
        const externalRef  = `WEGO-${verticalCode}-${shortId}-${shortUuid}`;

        console.log(`\n💳 [CAMPAY SERVICE] Initiating collection`);
        console.log(`   Vertical    : ${vertical} #${verticalId}`);
        console.log(`   Amount      : ${amount} XAF`);
        console.log(`   Phone       : ${normalisedPhone}`);
        console.log(`   ExternalRef : ${externalRef}`);

        // ── 5. Create WegoPayment record BEFORE calling CamPay ────────────────
        // If CamPay call fails we still have a PENDING record for the expiry
        // job to clean up. Full audit trail regardless of outcome.
        const payment = await WegoPayment.create({
            id:           uuidv4(),
            vertical,
            vertical_id:  String(verticalId),
            external_ref: externalRef,
            phone:        normalisedPhone,
            amount,
            direction:    'collect',
            status:       'PENDING',
            initiated_by: initiatedBy,
            initiated_at: new Date(),
        });

        // ── 6. Call CamPay ────────────────────────────────────────────────────
        let campayResponse;
        try {
            campayResponse = await campayClient.collect({
                amount:             String(amount),
                currency:           'XAF',
                from:               normalisedPhone,
                description,
                external_reference: externalRef,
            });
        } catch (campayErr) {
            await payment.update({
                status:         'FAILED',
                failure_reason: campayErr.message,
                campay_code:    campayErr.campayCode || null,
                resolved_at:    new Date(),
            });

            console.error(`❌ [CAMPAY SERVICE] CamPay collect call failed for ${externalRef}:`, campayErr.message);
            throw campayErr;
        }

        // ── 7. Update WegoPayment with CamPay's reference ─────────────────────
        // Status stays PENDING — webhook or poll will update to SUCCESSFUL/FAILED.
        await payment.update({
            campay_ref:      campayResponse.reference,
            campay_response: campayResponse,
        });

        console.log(`✅ [CAMPAY SERVICE] Collection initiated — campay_ref: ${campayResponse.reference}`);

        return {
            success:     true,
            paymentId:   payment.id,
            campayRef:   campayResponse.reference,
            externalRef,
            ussdCode:    campayResponse.ussd_code || null,
            operator:    campayResponse.operator  || null,
            status:      'PENDING',
        };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK PAYMENT STATUS
    //
    // Poll CamPay for the current status of a pending payment.
    // Used when the webhook hasn't arrived and Flutter is polling.
    //
    // @param {string} campayRef — the campay_ref stored on WegoPayment
    // @returns {object} { status: 'PENDING' | 'SUCCESSFUL' | 'FAILED', ... }
    // ═══════════════════════════════════════════════════════════════════════════

    async checkStatus(campayRef) {
        if (!campayRef) {
            throw new Error('[CAMPAY SERVICE] campayRef is required to check payment status');
        }

        console.log(`🔍 [CAMPAY SERVICE] Polling status for campay_ref: ${campayRef}`);

        const campayResponse = await campayClient.getTransaction(campayRef);

        return {
            campayRef,
            status:            campayResponse.status,
            operator:          campayResponse.operator           || null,
            operatorReference: campayResponse.operator_reference || null,
            amount:            campayResponse.amount             || null,
            currency:          campayResponse.currency           || 'XAF',
        };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // GET CAMPAY BALANCE
    //
    // Returns WeGo's CamPay wallet balance.
    // For the admin dashboard and pre-disbursement checks.
    // ═══════════════════════════════════════════════════════════════════════════

    async getBalance() {
        return campayClient.getBalance();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalise a phone number to CamPay's required format: 237xxxxxxxxx
 * Accepts: "670000000" (9 digits) or "237670000000" (already normalised)
 */
function _normalisePhone(phone) {
    const digits = String(phone).replace(/\D/g, '');

    if (/^237\d{9}$/.test(digits)) return digits;

    if (/^\d{9}$/.test(digits)) return `237${digits}`;

    throw new Error(
        `[CAMPAY SERVICE] Invalid phone number: "${phone}". ` +
        `Provide 9 digits (670000000) or full format (237670000000).`
    );
}

/**
 * Fetch the payable amount and a human-readable description from the correct
 * model for each vertical. This is the critical trust anchor — the amount
 * that goes to CamPay always comes from the database, never from the client.
 *
 * delivery_topup:
 *   verticalId = DeliveryWalletTopUp.id
 *   Amount = DeliveryWalletTopUp.amount (set when the record was created by the
 *   service layer from validated driver input)
 *
 * service_request / listing_fee:
 *   verticalId = ServiceAdPayment.id
 *   Amount = ServiceAdPayment.amount_snapshot (from the plan price at creation time)
 */
async function _resolveAmountAndDescription(vertical, verticalId) {
    switch (vertical) {

        // Rides are NOT paid through CamPay — the passenger pays the driver
        // directly (P2P). CamPay only handles driver wallet top-ups.

        case VERTICALS.DELIVERY: {
            const delivery = await Delivery.findByPk(verticalId, {
                attributes: ['id', 'total_price', 'payment_status', 'delivery_code'],
            });
            if (!delivery) throw new Error(`[CAMPAY SERVICE] Delivery #${verticalId} not found`);
            if (delivery.payment_status === 'paid') {
                throw new Error(`[CAMPAY SERVICE] Delivery #${verticalId} is already paid`);
            }
            const amount = parseFloat(delivery.total_price);
            if (!amount || amount <= 0) throw new Error(`[CAMPAY SERVICE] Delivery #${verticalId} has no price set`);
            return {
                amount:      _demoCap(Math.floor(amount)),
                description: `WeGo delivery payment (${delivery.delivery_code})`,
            };
        }

        // service_request and listing_fee both resolve from ServiceAdPayment.
        // listing_fee is kept as a distinct vertical string in the ENUM so the
        // admin dashboard can filter by type, but the resolution logic is identical.
        case VERTICALS.SERVICE_REQUEST:
        case VERTICALS.LISTING_FEE: {
            const adPayment = await ServiceAdPayment.findByPk(verticalId, {
                attributes: ['id', 'amount_snapshot', 'status', 'plan_key_snapshot', 'listing_id'],
            });
            if (!adPayment) {
                throw new Error(`[CAMPAY SERVICE] ServiceAdPayment #${verticalId} not found`);
            }
            if (adPayment.status !== 'pending_payment') {
                throw new Error(
                    `[CAMPAY SERVICE] ServiceAdPayment #${verticalId} is not in pending_payment state ` +
                    `(status: ${adPayment.status}). Payment may have already been processed.`
                );
            }
            const amount = parseFloat(adPayment.amount_snapshot);
            if (!amount || amount <= 0) {
                throw new Error(
                    `[CAMPAY SERVICE] ServiceAdPayment #${verticalId} has no payable amount. ` +
                    `Use the free plan activation endpoint instead.`
                );
            }
            return {
                amount:      _demoCap(amount),
                description: `WeGo listing ad — plan: ${adPayment.plan_key_snapshot} (listing #${adPayment.listing_id})`,
            };
        }

        case VERTICALS.RENTAL: {
            const rental = await VehicleRental.findByPk(verticalId, {
                attributes: ['id', 'totalPrice', 'paymentStatus', 'status'],
            });
            if (!rental) throw new Error(`[CAMPAY SERVICE] VehicleRental #${verticalId} not found`);
            if (rental.paymentStatus === 'paid') {
                throw new Error(`[CAMPAY SERVICE] VehicleRental #${verticalId} is already paid`);
            }
            const amount = parseFloat(rental.totalPrice);
            if (!amount || amount <= 0) throw new Error(`[CAMPAY SERVICE] VehicleRental #${verticalId} has no price set`);
            return {
                amount:      _demoCap(Math.floor(amount)),
                description: 'WeGo car rental payment',
            };
        }

        case VERTICALS.DELIVERY_TOPUP: {
            // verticalId = DeliveryWalletTopUp.id
            // The record was created by walletTopUp.service with status 'campay_pending'
            // BEFORE this function is called, so the amount is already locked in the DB.
            const topUp = await DeliveryWalletTopUp.findByPk(verticalId, {
                attributes: ['id', 'amount', 'status', 'payment_channel', 'driver_id'],
            });
            if (!topUp) {
                throw new Error(`[CAMPAY SERVICE] DeliveryWalletTopUp #${verticalId} not found`);
            }
            if (topUp.status !== 'campay_pending') {
                throw new Error(
                    `[CAMPAY SERVICE] DeliveryWalletTopUp #${verticalId} is not in campay_pending state ` +
                    `(status: ${topUp.status}). This top-up may have already been processed or was created ` +
                    `for the manual screenshot flow.`
                );
            }
            const amount = parseFloat(topUp.amount);
            if (!amount || amount <= 0) {
                throw new Error(`[CAMPAY SERVICE] DeliveryWalletTopUp #${verticalId} has no amount set`);
            }
            return {
                amount:      Math.floor(amount),
                description: `WeGo delivery wallet top-up (${amount.toLocaleString()} XAF)`,
            };
        }

        case VERTICALS.FLEET_TOPUP: {
            // verticalId = DriverWalletTransaction.id (CHAR 36 UUID)
            // The transaction row was created by fleetOwner.controller.topupDriver
            // with type='TOP_UP' and topUpStatus='PENDING' BEFORE this function is
            // called, so the amount is already locked in the DB.
            const txn = await DriverWalletTransaction.findByPk(verticalId, {
                attributes: ['id', 'amount', 'type', 'topUpStatus', 'driverId'],
            });
            if (!txn) {
                throw new Error(`[CAMPAY SERVICE] DriverWalletTransaction #${verticalId} not found`);
            }
            if (txn.type !== 'TOP_UP' || txn.topUpStatus !== 'PENDING') {
                throw new Error(
                    `[CAMPAY SERVICE] DriverWalletTransaction #${verticalId} is not a pending top-up ` +
                    `(type: ${txn.type}, topUpStatus: ${txn.topUpStatus}). It may already have been processed.`
                );
            }
            const amount = parseInt(txn.amount, 10);
            if (!amount || amount <= 0) {
                throw new Error(`[CAMPAY SERVICE] DriverWalletTransaction #${verticalId} has no amount set`);
            }
            return {
                amount,
                description: `WeGo fleet driver wallet top-up (${amount.toLocaleString()} XAF)`,
            };
        }

        default:
            throw new Error(
                `[CAMPAY SERVICE] _resolveAmountAndDescription: unknown vertical "${vertical}"`
            );
    }
}

/**
 * DEMO/sandbox amount cap. The CamPay demo rejects any amount above 25 XAF.
 * When CAMPAY_DEMO_MAX_XAF is set (e.g. 25), clamp pay-for-item charges so the
 * whole app is testable end-to-end on the sandbox. Applied ONLY to pay-for-item
 * verticals (delivery, rental, service) — NEVER to wallet top-ups, where the
 * amount charged must equal the amount credited (the user simply enters ≤25).
 * Leave CAMPAY_DEMO_MAX_XAF unset/0 in production to charge real amounts.
 */
function _demoCap(amount) {
    const cap = parseInt(process.env.CAMPAY_DEMO_MAX_XAF || '0', 10);
    if (cap > 0 && amount > cap) {
        console.log(`🧪 [CAMPAY DEMO] Capping amount ${amount} → ${cap} XAF (CAMPAY_DEMO_MAX_XAF)`);
        return cap;
    }
    return amount;
}

/**
 * Short uppercase code per vertical — used in external_ref for traceability.
 * Keep these short: the full external_ref must stay under 50 chars for CamPay.
 */
function _verticalCode(vertical) {
    const codes = {
        delivery:        'DLV',
        service_request: 'SVC',
        rental:          'RNT',
        listing_fee:     'LST',
        delivery_topup:  'DTUP',
        fleet_topup:     'FTUP',
    };
    return codes[vertical] || 'UNK';
}

// ── Export singleton ──────────────────────────────────────────────────────────
module.exports                = new CamPayService();
module.exports.VERTICALS      = VERTICALS;