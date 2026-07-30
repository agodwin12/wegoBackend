// src/services/etaService.js
//
// ═══════════════════════════════════════════════════════════════════════════
// ETA SERVICE — "N min away" for rides + deliveries, backoffice + mobile.
// ═══════════════════════════════════════════════════════════════════════════
// Given a driver/agent live position and a target (pickup or dropoff), returns
// an estimated time of arrival in minutes.
//
//   - Primary: LocationIQ (OSRM) road directions duration.
//   - Cache:   Redis, keyed on a ~110 m coarse grid of the FROM point + exact
//              TO point, TTL ~45 s. A driver moving at city speed triggers at
//              most ~1 provider call per ~110 m, so the live GPS stream (a ping
//              every few seconds) is almost entirely cache hits.
//   - Fallback: haversine distance × road-factor ÷ average city speed. Used on
//              any provider error/timeout so a live ETA is ALWAYS returned.
//
// Never throws — callers get a number or null and must not break on ETA.
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

const axios = require('axios');
const { redisClient } = require('../config/redis');

const LOCATIONIQ_KEY = process.env.LOCATIONIQ_KEY;
const AVG_SPEED_KMH  = parseFloat(process.env.ETA_AVG_SPEED_KMH || 22);   // urban Douala
const ROAD_FACTOR    = parseFloat(process.env.ETA_ROAD_FACTOR   || 1.3);  // crow-flies → road
const CACHE_TTL_S    = parseInt(process.env.ETA_CACHE_TTL_S     || 45, 10);
const PROVIDER_TIMEOUT_MS = parseInt(process.env.ETA_TIMEOUT_MS || 3000, 10);

function _isNum(n) { return typeof n === 'number' && isFinite(n); }

// Coerce to a finite number, but reject null/undefined/'' (Number(null) === 0,
// which would otherwise turn missing coords into a bogus (0,0) Gulf-of-Guinea ETA).
function _num(v) {
    if (v === null || v === undefined || v === '') return NaN;
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
}

function _toRad(d) { return (d * Math.PI) / 180; }

function _haversineKm(aLat, aLng, bLat, bLng) {
    const R = 6371;
    const dLat = _toRad(bLat - aLat);
    const dLng = _toRad(bLng - aLng);
    const s =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(_toRad(aLat)) * Math.cos(_toRad(bLat)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// Straight-line distance × road factor ÷ average speed. Always ≥ 1 min.
function _fallbackMinutes(fromLat, fromLng, toLat, toLng) {
    const km = _haversineKm(fromLat, fromLng, toLat, toLng) * ROAD_FACTOR;
    return Math.max(1, Math.round((km / AVG_SPEED_KMH) * 60));
}

// ~110 m grid on the moving FROM point; exact TO point.
function _cacheKey(fromLat, fromLng, toLat, toLng) {
    const r = (n) => Number(n).toFixed(3);
    return `eta:${r(fromLat)},${r(fromLng)}:${r(toLat)},${r(toLng)}`;
}

async function _roadMinutes(fromLat, fromLng, toLat, toLng) {
    // LocationIQ / OSRM wants lng,lat order in the path.
    const url =
        `https://us1.locationiq.com/v1/directions/driving/` +
        `${fromLng},${fromLat};${toLng},${toLat}`;
    const resp = await axios.get(url, {
        params:  { key: LOCATIONIQ_KEY, overview: 'false', steps: false, geometries: 'polyline' },
        timeout: PROVIDER_TIMEOUT_MS,
    });
    const route = resp.data?.routes?.[0];
    if (!route || (resp.data.code && resp.data.code !== 'Ok')) return null;
    return Math.max(1, Math.round(route.duration / 60));
}

/**
 * Estimated minutes from (fromLat,fromLng) to (toLat,toLng).
 * @returns {Promise<{minutes:number, source:'cache'|'road'|'estimate'}|null>}
 */
async function estimateMinutes(fromLat, fromLng, toLat, toLng) {
    fromLat = _num(fromLat); fromLng = _num(fromLng);
    toLat = _num(toLat);     toLng = _num(toLng);
    if ([fromLat, fromLng, toLat, toLng].some(Number.isNaN)) return null;

    const key = _cacheKey(fromLat, fromLng, toLat, toLng);

    try {
        const cached = await redisClient.get(key);
        if (cached !== null && cached !== undefined) {
            const m = parseInt(cached, 10);
            if (!Number.isNaN(m)) return { minutes: m, source: 'cache' };
        }
    } catch (_) { /* cache miss is non-fatal */ }

    // Try the road provider; on ANY failure fall back to the estimate so a live
    // ETA is always available.
    try {
        const roadMin = LOCATIONIQ_KEY ? await _roadMinutes(fromLat, fromLng, toLat, toLng) : null;
        if (roadMin != null) {
            redisClient.set(key, String(roadMin), 'EX', CACHE_TTL_S).catch(() => {});
            return { minutes: roadMin, source: 'road' };
        }
    } catch (_) { /* fall through to estimate */ }

    const est = _fallbackMinutes(fromLat, fromLng, toLat, toLng);
    // Cache the estimate briefly too, so a provider outage doesn't hammer it.
    redisClient.set(key, String(est), 'EX', Math.min(CACHE_TTL_S, 30)).catch(() => {});
    return { minutes: est, source: 'estimate' };
}

/**
 * Convenience: just the integer minutes (or null). May block up to the provider
 * timeout on a cache miss — use for one-off payloads (active-trip, backoffice),
 * NOT the per-ping live stream. Never throws.
 */
async function etaMinutes(fromLat, fromLng, toLat, toLng) {
    try {
        const r = await estimateMinutes(fromLat, fromLng, toLat, toLng);
        return r ? r.minutes : null;
    } catch (_) {
        return null;
    }
}

/**
 * NON-BLOCKING ETA for the live GPS stream. Returns instantly: a cached road ETA
 * if present, otherwise a haversine estimate — and kicks off a background road
 * refresh (debounced) so the next ping in the same ~110 m cell gets the accurate
 * value. This guarantees the live position emit is never delayed by the provider.
 * @returns {Promise<number|null>}
 */
async function liveEtaMinutes(fromLat, fromLng, toLat, toLng) {
    fromLat = _num(fromLat); fromLng = _num(fromLng);
    toLat = _num(toLat);     toLng = _num(toLng);
    if ([fromLat, fromLng, toLat, toLng].some(Number.isNaN)) return null;

    const key = _cacheKey(fromLat, fromLng, toLat, toLng);

    try {
        const cached = await redisClient.get(key);
        if (cached !== null && cached !== undefined) {
            const m = parseInt(cached, 10);
            if (!Number.isNaN(m)) return m;
        }
    } catch (_) { /* fall through */ }

    // Cache miss → instant haversine estimate now, and debounce a background road
    // refresh (a short-TTL estimate in the cache stops every ping re-firing it).
    const est = _fallbackMinutes(fromLat, fromLng, toLat, toLng);
    redisClient.set(key, String(est), 'EX', 8).catch(() => {});
    if (LOCATIONIQ_KEY) {
        (async () => {
            try {
                const roadMin = await _roadMinutes(fromLat, fromLng, toLat, toLng);
                if (roadMin != null) await redisClient.set(key, String(roadMin), 'EX', CACHE_TTL_S);
            } catch (_) { /* keep the estimate */ }
        })();
    }
    return est;
}

module.exports = { estimateMinutes, etaMinutes, liveEtaMinutes, _haversineKm, _fallbackMinutes };
