// src/services/fareCalculatorService.js

'use strict';

const axios    = require('axios');
const { Op }   = require('sequelize');
const { PriceRule } = require('../models');

const VEHICLE_TYPES = ['economy', 'comfort', 'luxury'];

class FareCalculatorService {
    constructor() {
        // Maps stack: LocationIQ (OpenStreetMap) for routing + reverse geocoding.
        this.locationIqKey = process.env.LOCATIONIQ_KEY;
        this.defaultCity   = process.env.DEFAULT_CITY || 'Douala';
    }

    // ═══════════════════════════════════════════════════════════════
    // 🔹 Get route details from the LocationIQ Directions API (OSRM)
    // ═══════════════════════════════════════════════════════════════
    async getRouteDetails(pickupLat, pickupLng, dropoffLat, dropoffLng) {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🗺️  [FARE] getRouteDetails() called');
        console.log(`📍 Origin:      [${pickupLat}, ${pickupLng}]`);
        console.log(`🏁 Destination: [${dropoffLat}, ${dropoffLng}]`);

        try {
            // LocationIQ (OSRM) expects lng,lat order, coords in the path.
            const url = `https://us1.locationiq.com/v1/directions/driving/` +
                `${pickupLng},${pickupLat};${dropoffLng},${dropoffLat}`;

            const response = await axios.get(url, {
                params: {
                    key:        this.locationIqKey,
                    geometries: 'polyline',   // encoded polyline, factor 1e5 (same as before)
                    overview:   'full',
                    steps:      false,
                },
                timeout: 8000,
            });

            const routes = response.data.routes;
            if (response.data.code && response.data.code !== 'Ok') {
                const err  = new Error('No driving route found between these locations.');
                err.status = 400;
                throw err;
            }
            if (!routes || routes.length === 0) {
                const err    = new Error('No driving route found between these locations.');
                err.status   = 400;
                throw err;
            }

            const route = routes[0];

            const details = {
                distance_m:    route.distance,
                duration_s:    route.duration,
                distance_text: `${(route.distance / 1000).toFixed(1)} km`,
                duration_text: `${Math.ceil(route.duration / 60)} min`,
                polyline:      route.geometry,
                start_address: null,
                end_address:   null,
            };

            console.log(`✅ [FARE] Route OK: ${details.distance_text}, ${details.duration_text}`);
            return details;

        } catch (error) {
            if (error.status) throw error;

            const status = error.response?.status;
            if (status === 401 || status === 403) {
                const err    = new Error('LocationIQ key invalid or unauthorized.');
                err.status   = 403;
                throw err;
            }
            if (status === 429) {
                const err    = new Error('LocationIQ rate limit exceeded. Please try again later.');
                err.status   = 429;
                throw err;
            }

            console.error('❌ [FARE] getRouteDetails() failed:', error.message);
            return { error: true, message: error.message, status: error.status || 500 };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // 🔹 Reverse geocode coordinates → city name via LocationIQ
    // ═══════════════════════════════════════════════════════════════
    async detectCityFromCoords(lat, lng) {
        console.log(`🏙️  [FARE] detectCityFromCoords(${lat}, ${lng})`);
        try {
            const response = await axios.get('https://us1.locationiq.com/v1/reverse', {
                params: {
                    key:               this.locationIqKey,
                    lat,
                    lon:               lng,
                    format:            'json',
                    normalizeaddress:  1,
                    'accept-language': 'fr',
                },
                timeout: 5000,
            });

            const addr = response.data.address || {};
            // Prefer the most city-like field available.
            let city = addr.city || addr.town || addr.village || addr.municipality ||
                       addr.county || addr.state || this.defaultCity;

            // Cameroon cities come back as arrondissements ("Douala V", "Yaoundé III").
            // Strip a trailing Roman-numeral so it matches the PriceRule city ("Douala").
            city = String(city).replace(/\s+[IVX]+$/i, '').trim();

            console.log(`✅ [FARE] Detected city: "${city}"`);
            return city || this.defaultCity;

        } catch (error) {
            console.warn(`⚠️  [FARE] detectCityFromCoords() failed: ${error.message} — using DEFAULT_CITY`);
            return this.defaultCity;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // 🔹 Fetch pricing rules for a city
    // ═══════════════════════════════════════════════════════════════
    async _getPricingRulesForCity(city) {
        console.log(`🔍 [FARE] _getPricingRulesForCity("${city}")`);

        try {
            // Try exact city match first
            let rules = await PriceRule.findAll({
                where: { city, status: 'active' },
                order: [['vehicle_type', 'ASC']],
            });

            // Case-insensitive fallback
            if (!rules.length) {
                rules = await PriceRule.findAll({
                    where: {
                        city:   { [Op.like]: city },
                        status: 'active',
                    },
                    order: [['vehicle_type', 'ASC']],
                });
            }

            // Try DEFAULT_CITY as last resort
            if (!rules.length && city !== this.defaultCity) {
                console.warn(`⚠️  [FARE] No rules for "${city}" — trying DEFAULT_CITY "${this.defaultCity}"`);
                return await this._getPricingRulesForCity(this.defaultCity);
            }

            if (!rules.length) {
                console.error(`❌ [FARE] No PriceRule found for "${city}" or DEFAULT_CITY. Admin must configure pricing.`);
                return null;
            }

            // Map into { economy, comfort, luxury }
            const map = {};
            for (const rule of rules) {
                map[rule.vehicle_type] = rule;
            }

            console.log(`✅ [FARE] Rules loaded for "${city}": ${Object.keys(map).join(', ')}`);
            return map;

        } catch (error) {
            console.error('❌ [FARE] _getPricingRulesForCity() DB error:', error.message);
            return null;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // 🔹 Calculate fare for a single vehicle type
    // ═══════════════════════════════════════════════════════════════
    _calculateFareFromRule(rule, distance_m, duration_s) {
        const distance_km  = distance_m / 1000;
        const duration_min = duration_s / 60;

        const base         = parseFloat(rule.base);
        const distanceFare = distance_km  * parseFloat(rule.per_km);
        const timeFare     = duration_min * parseFloat(rule.per_min);
        const subtotal     = base + distanceFare + timeFare;
        const beforeSurge  = Math.max(subtotal, parseFloat(rule.min_fare));
        const total        = Math.round(beforeSurge * parseFloat(rule.surge_mult));

        console.log(
            `💰 [FARE] ${rule.vehicle_type}: ` +
            `base=${base} + dist=${Math.round(distanceFare)} + time=${Math.round(timeFare)} ` +
            `→ subtotal=${Math.round(subtotal)} → final=${total} XAF`
        );

        return {
            vehicle_type:     rule.vehicle_type,
            fare_estimate:    total,
            breakdown: {
                base_fare:        parseFloat(base.toFixed(2)),
                distance_fare:    parseFloat(distanceFare.toFixed(2)),
                time_fare:        parseFloat(timeFare.toFixed(2)),
                surge_multiplier: parseFloat(rule.surge_mult),
                min_fare:         parseFloat(rule.min_fare),
                distance_km:      parseFloat(distance_km.toFixed(2)),
                duration_min:     parseFloat(duration_min.toFixed(2)),
            },
        };
    }

    // ═══════════════════════════════════════════════════════════════
    // 🔹 MAIN: Estimate fares for ALL vehicle types in one call
    // ═══════════════════════════════════════════════════════════════
    async estimateAllVehicleTypes(pickupLat, pickupLng, dropoffLat, dropoffLng, cityOverride = null) {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🚀 [FARE] estimateAllVehicleTypes() called');

        try {
            // Step 1: Route from Mapbox (one call for all vehicle types)
            const route = await this.getRouteDetails(pickupLat, pickupLng, dropoffLat, dropoffLng);
            if (route.error) return route;

            // Step 2: Detect city from pickup GPS
            const city = cityOverride ?? await this.detectCityFromCoords(pickupLat, pickupLng);
            console.log(`🏙️  [FARE] City for pricing: "${city}"`);

            // Step 3: Load all 3 pricing rules for this city
            const rulesMap = await this._getPricingRulesForCity(city);
            if (!rulesMap) {
                const err    = new Error(`No pricing configured for "${city}". Please contact support.`);
                err.status   = 503;
                throw err;
            }

            // Step 4: Calculate fare for each available vehicle type
            const estimates = {};
            for (const type of VEHICLE_TYPES) {
                const rule = rulesMap[type];
                if (rule) {
                    estimates[type] = {
                        ...this._calculateFareFromRule(rule, route.distance_m, route.duration_s),
                        distance_text: route.distance_text,
                        duration_text: route.duration_text,
                    };
                } else {
                    console.warn(`⚠️  [FARE] No rule for vehicle type "${type}" in "${city}" — skipping`);
                }
            }

            const result = {
                city,
                currency:      'XAF',
                distance_text: route.distance_text,
                duration_text: route.duration_text,
                distance_m:    route.distance_m,
                duration_s:    route.duration_s,
                polyline:      route.polyline,
                start_address: route.start_address,
                end_address:   route.end_address,
                estimates,
            };

            console.log('✅ [FARE] All estimates computed:');
            for (const [type, est] of Object.entries(estimates)) {
                console.log(`   ${type}: ${est.fare_estimate} XAF`);
            }
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

            return result;

        } catch (error) {
            console.error('❌ [FARE] estimateAllVehicleTypes() failed:', error.message);
            return {
                error:   true,
                message: error.message,
                status:  error.status || 500,
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // 🔹 LEGACY: Single estimate (kept for createTrip compatibility)
    // ═══════════════════════════════════════════════════════════════
    async estimateFullTrip(pickupLat, pickupLng, dropoffLat, dropoffLng, cityOverride = null) {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🚀 [FARE] estimateFullTrip() called (legacy)');

        try {
            const route = await this.getRouteDetails(pickupLat, pickupLng, dropoffLat, dropoffLng);
            if (route.error) return route;

            const city     = cityOverride ?? await this.detectCityFromCoords(pickupLat, pickupLng);
            const rulesMap = await this._getPricingRulesForCity(city);

            if (!rulesMap || !rulesMap['economy']) {
                const err  = new Error(`No pricing configured for "${city}".`);
                err.status = 503;
                throw err;
            }

            // Legacy returns economy fare only
            const fareData = this._calculateFareFromRule(rulesMap['economy'], route.distance_m, route.duration_s);

            return {
                ...route,
                ...fareData,
                city,
                currency: 'XAF',
            };

        } catch (error) {
            console.error('❌ [FARE] estimateFullTrip() failed:', error.message);
            return { error: true, message: error.message, status: error.status || 500 };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // 🔹 Create or update a price rule (called from backoffice)
    // ═══════════════════════════════════════════════════════════════
    async createOrUpdatePriceRule(city, vehicleType, pricing, employeeId = null) {
        console.log(`💾 [FARE] createOrUpdatePriceRule("${city}", "${vehicleType}")`);

        try {
            if (!city || !city.trim())                                   throw new Error('City name is required');
            if (!VEHICLE_TYPES.includes(vehicleType))                    throw new Error(`vehicleType must be one of: ${VEHICLE_TYPES.join(', ')}`);
            if (pricing.base       !== undefined && pricing.base       < 0) throw new Error('base fare cannot be negative');
            if (pricing.per_km     !== undefined && pricing.per_km     < 0) throw new Error('per_km rate cannot be negative');
            if (pricing.per_min    !== undefined && pricing.per_min    < 0) throw new Error('per_min rate cannot be negative');
            if (pricing.min_fare   !== undefined && pricing.min_fare   < 0) throw new Error('min_fare cannot be negative');
            if (pricing.surge_mult !== undefined && pricing.surge_mult < 1) throw new Error('surge_mult must be >= 1.0');

            const [rule, created] = await PriceRule.findOrCreate({
                where: { city: city.trim(), vehicle_type: vehicleType },
                defaults: {
                    city:         city.trim(),
                    vehicle_type: vehicleType,
                    base:         pricing.base       ?? 500,
                    per_km:       pricing.per_km     ?? 150,
                    per_min:      pricing.per_min    ?? 20,
                    min_fare:     pricing.min_fare   ?? 500,
                    surge_mult:   pricing.surge_mult ?? 1.0,
                    status:       'active',
                    created_by:   employeeId,
                },
            });

            if (!created) {
                await rule.update({
                    base:       pricing.base       ?? rule.base,
                    per_km:     pricing.per_km     ?? rule.per_km,
                    per_min:    pricing.per_min    ?? rule.per_min,
                    min_fare:   pricing.min_fare   ?? rule.min_fare,
                    surge_mult: pricing.surge_mult ?? rule.surge_mult,
                    updated_by: employeeId,
                });
                console.log(`✅ [FARE] Updated PriceRule for "${city}" / ${vehicleType}`);
            } else {
                console.log(`✅ [FARE] Created PriceRule for "${city}" / ${vehicleType}`);
            }

            return rule;

        } catch (error) {
            console.error('❌ [FARE] createOrUpdatePriceRule() error:', error.message);
            return { error: true, message: error.message, status: error.status || 500 };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // 🔹 Get all price rules (backoffice listing)
    // ═══════════════════════════════════════════════════════════════
    async getAllPriceRules() {
        try {
            const rules = await PriceRule.findAll({
                order: [['city', 'ASC'], ['vehicle_type', 'ASC']],
            });
            console.log(`✅ [FARE] Fetched ${rules.length} price rules`);
            return rules;
        } catch (error) {
            console.error('❌ [FARE] getAllPriceRules() error:', error.message);
            return { error: true, message: error.message, status: 500 };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // 🔹 Update surge multiplier for a city
    // ═══════════════════════════════════════════════════════════════
    async updateSurgeMultiplier(city, surgeMult, vehicleType = null) {
        console.log(`⚡ [FARE] updateSurgeMultiplier("${city}", ${surgeMult}, ${vehicleType ?? 'all'})`);
        try {
            if (typeof surgeMult !== 'number' || surgeMult < 1) {
                throw new Error('surge_mult must be a number >= 1.0');
            }

            const where = { city };
            if (vehicleType) where.vehicle_type = vehicleType;

            const rules = await PriceRule.findAll({ where });
            if (!rules.length) {
                const err    = new Error(`No PriceRule found for city: "${city}"`);
                err.status   = 404;
                throw err;
            }

            await Promise.all(rules.map(r => r.update({ surge_mult: surgeMult })));
            console.log(`✅ [FARE] Surge updated for "${city}" ${vehicleType ?? '(all types)'} → ${surgeMult}x`);
            return rules;

        } catch (error) {
            console.error('❌ [FARE] updateSurgeMultiplier() error:', error.message);
            return { error: true, message: error.message, status: error.status || 500 };
        }
    }
}

module.exports = new FareCalculatorService();
