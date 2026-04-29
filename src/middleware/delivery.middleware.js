// src/middleware/delivery.middleware.js
//
// ═══════════════════════════════════════════════════════════════════════════════
// DELIVERY MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════════
//
// Route-level guards for the delivery module.
//
// Exported middleware:
//
//   requireDeliveryWalletBalance
//     → Blocks a driver from accepting a job if their available wallet
//       balance is below the commission amount for that delivery.
//     → Must be used on POST /api/deliveries/:id/accept AFTER authenticate.
//     → Attaches req.deliveryWallet and req.deliveryDriver for the controller
//       to reuse — avoids a second DB round-trip.
//
//   validateDeliveryType
//     → Validates the delivery_type field in booking requests.
//     → Ensures only 'regular' and 'express' are accepted.
//     → Attaches req.deliveryType for the controller to read.
//
// Usage in routes:
//   router.post('/:id/accept',
//     authenticate,
//     requireDriver,          ← existing driver middleware
//     requireDeliveryWalletBalance,   ← NEW
//     ctrl.acceptDelivery
//   );
//
//   router.post('/book',
//     authenticate,
//     validateDeliveryType,   ← NEW
//     ctrl.bookDelivery
//   );
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const { Driver, Delivery, DeliveryWallet } = require('../models');

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_DELIVERY_TYPES = ['regular', 'express'];

// Express surcharge percentage added on top of base price (configurable via env)
// e.g. 0.20 = 20% premium for express tracking
const EXPRESS_SURCHARGE = parseFloat(process.env.EXPRESS_DELIVERY_SURCHARGE || 0.20);

// Minimum float required above commission (matches the service constant)
const MINIMUM_FLOAT_XAF = parseInt(process.env.COMMISSION_MINIMUM_FLOAT_XAF || 0, 10);

// ═══════════════════════════════════════════════════════════════════════════════
// requireDeliveryWalletBalance
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Verifies the calling driver has enough wallet balance to cover the
 * commission fee for the delivery they are attempting to accept.
 *
 * Flow:
 *   1. Resolve Driver from req.user.uuid
 *   2. Load the Delivery to get commission_amount
 *   3. Load the DeliveryWallet and compute available balance
 *   4. If balance < (commission + minimum float) → 402
 *   5. Otherwise attach req.deliveryDriver and req.deliveryWallet and pass through
 *
 * The actual reservation (incrementing reserved_balance) happens inside
 * deliveryCommission.service.reserveCommission(), called by the controller.
 * This middleware is a fast pre-flight check only.
 */
async function requireDeliveryWalletBalance(req, res, next) {
    try {
        const accountUuid = req.user?.uuid;
        if (!accountUuid) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required.',
                code:    'NOT_AUTHENTICATED',
            });
        }

        // ── Resolve driver ────────────────────────────────────────────────────
        const driver = await Driver.findOne({
            where:      { userId: accountUuid },
            attributes: ['id', 'userId', 'status', 'current_mode'],
        });

        if (!driver) {
            return res.status(404).json({
                success: false,
                message: 'Driver record not found.',
                code:    'DRIVER_NOT_FOUND',
            });
        }

        // Mode guard — must be in delivery mode
        if (driver.current_mode !== 'delivery') {
            return res.status(400).json({
                success: false,
                message: 'Switch to delivery mode before accepting deliveries.',
                code:    'WRONG_MODE',
            });
        }

        // ── Load delivery to get commission amount ────────────────────────────
        const deliveryId = parseInt(req.params.id);
        if (!deliveryId || isNaN(deliveryId)) {
            return res.status(400).json({ success: false, message: 'Invalid delivery ID.' });
        }

        const delivery = await Delivery.findByPk(deliveryId, {
            attributes: ['id', 'status', 'commission_amount', 'delivery_code', 'delivery_type'],
        });

        if (!delivery) {
            return res.status(404).json({
                success: false,
                message: 'Delivery not found.',
                code:    'DELIVERY_NOT_FOUND',
            });
        }

        if (delivery.status !== 'searching') {
            return res.status(409).json({
                success: false,
                message: 'This delivery is no longer available.',
                code:    'DELIVERY_NOT_AVAILABLE',
            });
        }

        const commission = parseFloat(delivery.commission_amount || 0);
        const required   = commission + MINIMUM_FLOAT_XAF;

        // ── Load wallet ───────────────────────────────────────────────────────
        const wallet = await DeliveryWallet.findOne({
            where:      { driver_id: driver.id },
            attributes: ['id', 'balance', 'reserved_balance', 'pending_withdrawal', 'status', 'frozen_reason'],
        });

        // No wallet at all means driver has never topped up
        if (!wallet) {
            return res.status(402).json({
                success:  false,
                message:  'You need to top up your wallet before accepting deliveries.',
                code:     'WALLET_NOT_FOUND',
                required: required,
                available: 0,
            });
        }

        if (wallet.status !== 'active') {
            return res.status(403).json({
                success:  false,
                message:  wallet.status === 'frozen'
                    ? `Your wallet is frozen: ${wallet.frozen_reason || 'Contact WeGo support.'}`
                    : 'Your wallet has been suspended. Contact WeGo support.',
                code:     'WALLET_INACTIVE',
                status:   wallet.status,
            });
        }

        const available = parseFloat(wallet.balance)
            - parseFloat(wallet.reserved_balance)
            - parseFloat(wallet.pending_withdrawal);

        if (available < required) {
            const shortfall = required - available;
            return res.status(402).json({
                success:   false,
                message:   `Insufficient wallet balance. Top up at least ${shortfall.toLocaleString()} XAF to accept this delivery.`,
                code:      'INSUFFICIENT_WALLET_BALANCE',
                required,
                available: Math.max(0, available),
                shortfall,
                commission,
                topup_hint: `You need ${shortfall.toLocaleString()} XAF more. Visit a WeGo office or use MoMo/Orange Money.`,
            });
        }

        // ── Pass through — attach to request for controller reuse ─────────────
        req.deliveryDriver = driver;
        req.deliveryWallet = wallet;
        req.deliveryCommission = commission;

        next();

    } catch (error) {
        console.error('❌ [DELIVERY MIDDLEWARE] requireDeliveryWalletBalance error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Failed to verify wallet balance. Please try again.',
        });
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// validateDeliveryType
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validates and normalises the delivery_type field sent by the booking app.
 *
 * - If delivery_type is missing, defaults to 'regular'
 * - Rejects unknown values with a clear 400
 * - Attaches req.deliveryType for the controller to use
 * - Also computes req.expressMultiplier (1.0 for regular, 1+surcharge for express)
 *
 * The controller uses req.deliveryType when creating the Delivery record
 * and req.expressMultiplier to adjust the price for express bookings.
 */
function validateDeliveryType(req, res, next) {
    const rawType = (req.body.delivery_type || 'regular').toLowerCase().trim();

    if (!VALID_DELIVERY_TYPES.includes(rawType)) {
        return res.status(400).json({
            success: false,
            message: `delivery_type must be 'regular' or 'express'. Got: '${rawType}'.`,
            code:    'INVALID_DELIVERY_TYPE',
            valid:   VALID_DELIVERY_TYPES,
        });
    }

    req.deliveryType       = rawType;
    req.expressMultiplier  = rawType === 'express' ? (1 + EXPRESS_SURCHARGE) : 1.0;
    req.isExpressDelivery  = rawType === 'express';

    next();
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
    requireDeliveryWalletBalance,
    validateDeliveryType,
    VALID_DELIVERY_TYPES,
    EXPRESS_SURCHARGE,
};