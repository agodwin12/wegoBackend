// src/controllers/fareController.js

'use strict';

const fareCalculatorService = require('../services/fareCalculatorService');

class FareController {

    // ═══════════════════════════════════════════════════════════════
    // POST /trips/fare-estimates
    // ═══════════════════════════════════════════════════════════════
    async getFareEstimates(req, res) {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('💰 [FARE_CTRL] getFareEstimates() called');
        console.log('👤 User:', req.user?.uuid || req.user?.id);

        try {
            // ── Validate input ──────────────────────────────────
            const { pickupLat, pickupLng, dropoffLat, dropoffLng } = req.body;

            const missing = [];
            if (pickupLat  === undefined || pickupLat  === null) missing.push('pickupLat');
            if (pickupLng  === undefined || pickupLng  === null) missing.push('pickupLng');
            if (dropoffLat === undefined || dropoffLat === null) missing.push('dropoffLat');
            if (dropoffLng === undefined || dropoffLng === null) missing.push('dropoffLng');

            if (missing.length) {
                console.warn('⚠️  [FARE_CTRL] Missing fields:', missing);
                return res.status(400).json({
                    success: false,
                    message: `Missing required fields: ${missing.join(', ')}`,
                });
            }

            const pLat = parseFloat(pickupLat);
            const pLng = parseFloat(pickupLng);
            const dLat = parseFloat(dropoffLat);
            const dLng = parseFloat(dropoffLng);

            if (isNaN(pLat) || isNaN(pLng) || isNaN(dLat) || isNaN(dLng)) {
                return res.status(400).json({
                    success: false,
                    message: 'All coordinates must be valid numbers.',
                });
            }

            if (pLat < -90  || pLat > 90  || dLat < -90  || dLat > 90) {
                return res.status(400).json({
                    success: false,
                    message: 'Latitude must be between -90 and 90.',
                });
            }

            if (pLng < -180 || pLng > 180 || dLng < -180 || dLng > 180) {
                return res.status(400).json({
                    success: false,
                    message: 'Longitude must be between -180 and 180.',
                });
            }

            if (pLat === dLat && pLng === dLng) {
                return res.status(400).json({
                    success: false,
                    message: 'Pickup and dropoff locations cannot be the same.',
                });
            }

            console.log(`📍 Pickup:  [${pLat}, ${pLng}]`);
            console.log(`🏁 Dropoff: [${dLat}, ${dLng}]`);

            // ── Call service ────────────────────────────────────
            const result = await fareCalculatorService.estimateAllVehicleTypes(
                pLat, pLng, dLat, dLng
            );

            // ── Handle service errors ───────────────────────────
            if (result.error) {
                console.error('❌ [FARE_CTRL] Service error:', result.message);
                return res.status(result.status || 500).json({
                    success: false,
                    message: result.message,
                });
            }

            // ── Success ─────────────────────────────────────────
            console.log('✅ [FARE_CTRL] Estimates ready:');
            for (const [type, est] of Object.entries(result.estimates)) {
                console.log(`   ${type}: ${est.fare_estimate} XAF`);
            }
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

            return res.status(200).json({
                success: true,
                message: 'Fare estimates calculated successfully.',
                data: {
                    city:          result.city,
                    currency:      result.currency,
                    distance_text: result.distance_text,
                    duration_text: result.duration_text,
                    distance_m:    result.distance_m,
                    duration_s:    result.duration_s,
                    polyline:      result.polyline,
                    start_address: result.start_address,
                    end_address:   result.end_address,
                    estimates:     result.estimates,
                },
            });

        } catch (error) {
            console.error('❌ [FARE_CTRL] Unexpected error:', error);
            return res.status(500).json({
                success: false,
                message: 'An unexpected error occurred. Please try again.',
            });
        }
    }
}

module.exports = new FareController();