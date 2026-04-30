'use strict';

const express = require('express');
const multer = require('multer');
const router = express.Router();

const ctrl = require('../controllers/delivery.controller');
const topUpCtrl = require('../controllers/delivery/walletTopUp.controller');
const categoriesCtrl = require('../controllers/deliveryCategories.public.controller');

const { authenticate } = require('../middleware/auth.middleware');

const {
    requireDriverAny,
    requireDeliveryAgent,
} = require('../middleware/driver.middleware');

const {
    validateDeliveryType,
    requireDeliveryWalletBalance,
} = require('../middleware/delivery.middleware');

const locationService = require('../services/locationService');
const { Driver } = require('../models');

// ─── Middleware chains ────────────────────────────────────────────────────────
const deliveryAgentAuth = [authenticate, requireDeliveryAgent];
const driverAuthAny = [authenticate, requireDriverAny];

// ─── Multer for top-up proof screenshot ──────────────────────────────────────
const proofUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter(_req, file, cb) {
        const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
        const isAllowed = allowed.includes(file.mimetype);

        cb(
            isAllowed ? null : new Error('Only JPEG/PNG/WEBP accepted'),
            isAllowed
        );
    },
});

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC / MAP
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/nearby-drivers', authenticate, async (req, res) => {
    try {
        const lat = parseFloat(req.query.lat);
        const lng = parseFloat(req.query.lng);
        const radius = parseFloat(req.query.radius || 5);

        if (isNaN(lat) || isNaN(lng)) {
            return res.status(400).json({
                success: false,
                message: 'lat and lng are required query parameters',
            });
        }

        const nearby = await locationService.findNearbyDrivers(lng, lat, radius, 50);

        if (!nearby.length) {
            return res.json({
                success: true,
                drivers: [],
            });
        }

        const ids = nearby.map(d => d.driverId);

        const deliveryDrivers = await Driver.findAll({
            where: {
                id: ids,
                current_mode: 'delivery',
            },
            attributes: ['id'],
        });

        const deliveryIds = new Set(deliveryDrivers.map(d => d.id));

        const drivers = nearby
            .filter(d => deliveryIds.has(d.driverId))
            .map(d => ({
                id: d.driverId,
                lat: d.lat,
                lng: d.lng,
                heading: d.heading || 0,
                distance: parseFloat(d.distance.toFixed(2)),
            }));

        return res.json({
            success: true,
            drivers,
        });

    } catch (error) {
        console.error('❌ [DELIVERY] nearby-drivers error:', error.message);

        return res.status(500).json({
            success: false,
            message: 'Failed to fetch nearby drivers',
        });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC — no auth required
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/categories', categoriesCtrl.getActiveCategories);

// ═══════════════════════════════════════════════════════════════════════════════
// DRIVER / DELIVERY AGENT WALLET
// Read-only routes use requireDriverAny
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/driver/wallet', driverAuthAny, ctrl.getWallet);

router.get('/driver/wallet/transactions', driverAuthAny, ctrl.getWalletTransactions);

router.get('/driver/wallet/topup', driverAuthAny, topUpCtrl.getMyTopUps);

router.get('/driver/wallet/topup/:id', driverAuthAny, topUpCtrl.getTopUpDetail);

router.post(
    '/driver/wallet/topup',
    driverAuthAny,
    proofUpload.single('proof'),
    topUpCtrl.submitTopUp
);

router.post('/driver/cashout', driverAuthAny, ctrl.requestCashout);

router.post('/driver/cashout/:requestId/cancel', driverAuthAny, ctrl.cancelCashout);

// ═══════════════════════════════════════════════════════════════════════════════
// DRIVER / DELIVERY AGENT OPERATIONAL
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/driver/mode', driverAuthAny, ctrl.toggleDriverMode);

/**
 * GET /api/deliveries/driver/history
 * Driver / delivery agent delivery history
 */
router.get('/driver/history', driverAuthAny, ctrl.getDriverDeliveries);

/**
 * GET /api/deliveries/agent/history
 * Delivery agent history
 *
 * Important:
 * This must NOT use requireDriver.
 * DELIVERY_AGENT users must be allowed here.
 */
router.get('/agent/history', driverAuthAny, ctrl.getDriverDeliveries);

// ═══════════════════════════════════════════════════════════════════════════════
// SENDER
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/estimate', authenticate, ctrl.getEstimate);

router.post('/book', authenticate, validateDeliveryType, ctrl.bookDelivery);

router.get('/my', authenticate, ctrl.getMyDeliveries);

// ═══════════════════════════════════════════════════════════════════════════════
// PARAMETERISED — DELIVERY AGENT ACTIONS
// ═══════════════════════════════════════════════════════════════════════════════

router.post(
    '/:id/accept',
    ...deliveryAgentAuth,
    requireDeliveryWalletBalance,
    ctrl.acceptDelivery
);

router.post('/:id/status', ...deliveryAgentAuth, ctrl.updateStatus);

router.post('/:id/verify-pin', ...deliveryAgentAuth, ctrl.verifyPin);

router.post('/:id/confirm-cash', ...deliveryAgentAuth, ctrl.confirmCash);

// ═══════════════════════════════════════════════════════════════════════════════
// PARAMETERISED — SENDER ACTIONS
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/:id/rate', authenticate, ctrl.rateDelivery);

// ═══════════════════════════════════════════════════════════════════════════════
// PARAMETERISED — SHARED
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/:id/cancel', authenticate, ctrl.cancelDelivery);


router.get('/agent/history/earnings', driverAuthAny, ctrl.getAgentDeliveryEarnings);
router.get('/agent/history/:id', driverAuthAny, ctrl.getAgentDeliveryDetail);
router.get('/agent/history', driverAuthAny, ctrl.getAgentDeliveryHistory);
/**
 * MUST BE LAST
 */
router.get('/:id', authenticate, ctrl.getDelivery);

module.exports = router;