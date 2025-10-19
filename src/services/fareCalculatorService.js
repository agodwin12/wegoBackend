const axios = require("axios");
const { PriceRule } = require("../models");
const { v4: uuidv4 } = require("uuid");

class FareCalculatorService {
    constructor() {
        this.googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY;
        this.defaultCity = process.env.DEFAULT_CITY || "Douala";
        this.defaultPricing = {
            base: 500,
            per_km: 150,
            per_min: 50,
            min_fare: 500,
            surge_mult: 1.0,
        };
    }

    // ===============================================================
    // 🔹 Get route details from Google Maps Directions API
    // ===============================================================
    async getRouteDetails(pickupLat, pickupLng, dropoffLat, dropoffLng) {
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.log("🗺️ [FARE] getRouteDetails() called");
        console.log(`📍 Origin: [${pickupLat}, ${pickupLng}]`);
        console.log(`🏁 Destination: [${dropoffLat}, ${dropoffLng}]`);

        try {
            const origin = `${pickupLat},${pickupLng}`;
            const destination = `${dropoffLat},${dropoffLng}`;

            console.log("🌍 [FARE] Requesting Google Maps Directions API...");

            const response = await axios.get(
                "https://maps.googleapis.com/maps/api/directions/json",
                {
                    params: {
                        origin,
                        destination,
                        mode: "driving",
                        key: this.googleMapsApiKey,
                        alternatives: false,
                        language: "fr",
                    },
                }
            );

            const status = response.data.status;
            console.log(`📡 [FARE] Google Maps API status: ${status}`);

            if (status !== "OK") {
                console.warn("⚠️ [FARE] Google Maps returned non-OK status:", status);

                let message;
                let httpCode = 400;

                switch (status) {
                    case "ZERO_RESULTS":
                        message = "No valid driving route found between these points.";
                        httpCode = 400;
                        break;
                    case "OVER_QUERY_LIMIT":
                        message = "Google Maps query limit exceeded. Please try again later.";
                        httpCode = 429;
                        break;
                    case "REQUEST_DENIED":
                        message = "Google Maps request denied (check API key).";
                        httpCode = 403;
                        break;
                    case "INVALID_REQUEST":
                        message = "Invalid request to Google Maps API. Check coordinates.";
                        httpCode = 400;
                        break;
                    default:
                        message = `Unexpected Google Maps API error: ${status}`;
                }

                const error = new Error(message);
                error.status = httpCode;
                throw error;
            }

            const route = response.data.routes[0];
            const leg = route.legs[0];

            const routeDetails = {
                distance_m: leg.distance.value,
                duration_s: leg.duration.value,
                distance_text: leg.distance.text,
                duration_text: leg.duration.text,
                polyline: route.overview_polyline.points,
                start_address: leg.start_address,
                end_address: leg.end_address,
            };

            console.log(
                `✅ [FARE] Route computed successfully: ${routeDetails.distance_text}, ${routeDetails.duration_text}`
            );
            return routeDetails;
        } catch (error) {
            console.error("❌ [FARE] Error in getRouteDetails():", error.message);
            // return a structured error object for graceful controller handling
            return {
                error: true,
                message: error.message,
                status: error.status || 500,
            };
        }
    }

    // ===============================================================
    // 🔹 Calculate fare based on distance, duration and city pricing
    // ===============================================================
    async calculateFare(distance_m, duration_s, city = null) {
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.log("💰 [FARE] calculateFare() called");

        try {
            const cityName = city || this.defaultCity;
            console.log(`🏙️ City: ${cityName}`);
            console.log(`📏 Distance: ${distance_m} m`);
            console.log(`⏱️ Duration: ${duration_s} s`);

            let pricing = await this._getPricingRules(cityName);

            if (!pricing) {
                console.warn("⚠️ [FARE] No city pricing found. Using defaults.");
                pricing = this.defaultPricing;
            }

            const distance_km = distance_m / 1000;
            const duration_min = duration_s / 60;

            console.log(
                `🧮 [FARE] base=${pricing.base}, per_km=${pricing.per_km}, per_min=${pricing.per_min}`
            );

            let fare =
                pricing.base +
                distance_km * pricing.per_km +
                duration_min * pricing.per_min;

            fare = Math.round(fare * pricing.surge_mult);

            if (fare < pricing.min_fare) {
                console.log(
                    `⚠️ [FARE] Fare ${fare} below min ${pricing.min_fare}. Adjusting.`
                );
                fare = pricing.min_fare;
            }

            console.log(`✅ [FARE] Final fare: ${fare} XAF`);
            return {
                fare_estimate: fare,
                breakdown: {
                    base: pricing.base,
                    distance_charge: Math.round(distance_km * pricing.per_km),
                    time_charge: Math.round(duration_min * pricing.per_min),
                    surge_multiplier: pricing.surge_mult,
                    min_fare: pricing.min_fare,
                },
            };
        } catch (error) {
            console.error("❌ [FARE] Error in calculateFare():", error.message);
            return {
                error: true,
                message: "Error calculating fare: " + error.message,
                status: 500,
            };
        }
    }

    // ===============================================================
    // 🔹 Combine route + fare for full trip estimate
    // ===============================================================
    async estimateFullTrip(pickupLat, pickupLng, dropoffLat, dropoffLng, city = null) {
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.log("🚀 [FARE] estimateFullTrip() called");

        try {
            const routeDetails = await this.getRouteDetails(
                pickupLat,
                pickupLng,
                dropoffLat,
                dropoffLng
            );

            if (routeDetails.error) {
                console.warn(
                    "⚠️ [FARE] Route details error → returning gracefully:",
                    routeDetails.message
                );
                return routeDetails; // graceful return, not throw
            }

            const fareData = await this.calculateFare(
                routeDetails.distance_m,
                routeDetails.duration_s,
                city
            );

            if (fareData.error) {
                console.warn("⚠️ [FARE] Fare calculation error:", fareData.message);
                return fareData;
            }

            const estimate = {
                ...routeDetails,
                ...fareData,
                currency: "XAF",
            };

            console.log("✅ [FARE] Trip estimate computed successfully");
            console.log(`💰 Fare: ${estimate.fare_estimate} XAF`);
            console.log(`📏 Distance: ${estimate.distance_text} (${estimate.duration_text})`);

            return estimate;
        } catch (error) {
            console.error("❌ [FARE] estimateFullTrip() failed:", error.message);
            return {
                error: true,
                message: "Error estimating full trip: " + error.message,
                status: 500,
            };
        }
    }

    // ===============================================================
    // 🔹 Retrieve pricing rule for a given city
    // ===============================================================
    async _getPricingRules(city) {
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.log(`🔍 [FARE] _getPricingRules() for city: ${city}`);

        try {
            const priceRule = await PriceRule.findOne({
                where: { city },
                order: [["createdAt", "DESC"]],
            });

            if (priceRule) {
                console.log(`✅ [FARE] Found pricing rule for ${city}`);
                return {
                    base: priceRule.base,
                    per_km: priceRule.per_km,
                    per_min: priceRule.per_min,
                    min_fare: priceRule.min_fare,
                    surge_mult: priceRule.surge_mult,
                };
            }

            console.warn(`⚠️ [FARE] No pricing rule found for ${city}`);
            return null;
        } catch (error) {
            console.error("❌ [FARE] _getPricingRules() error:", error.message);
            return null;
        }
    }

    // ===============================================================
    // 🔹 Create or update a price rule
    // ===============================================================
    async createOrUpdatePriceRule(city, pricing) {
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.log(`💾 [FARE] createOrUpdatePriceRule() for ${city}`);

        try {
            const [priceRule, created] = await PriceRule.findOrCreate({
                where: { city },
                defaults: {
                    id: uuidv4(),
                    city,
                    base: pricing.base || 500,
                    per_km: pricing.per_km || 150,
                    per_min: pricing.per_min || 50,
                    min_fare: pricing.min_fare || 500,
                    surge_mult: pricing.surge_mult || 1.0,
                },
            });

            if (!created) {
                console.log(`🧾 [FARE] Existing rule found, updating...`);
                await priceRule.update({
                    base: pricing.base ?? priceRule.base,
                    per_km: pricing.per_km ?? priceRule.per_km,
                    per_min: pricing.per_min ?? priceRule.per_min,
                    min_fare: pricing.min_fare ?? priceRule.min_fare,
                    surge_mult: pricing.surge_mult ?? priceRule.surge_mult,
                });
                console.log(`✅ [FARE] Updated price rule for ${city}`);
            } else {
                console.log(`✅ [FARE] Created new price rule for ${city}`);
            }

            return priceRule;
        } catch (error) {
            console.error("❌ [FARE] createOrUpdatePriceRule() error:", error.message);
            return {
                error: true,
                message: "Error creating/updating price rule: " + error.message,
                status: 500,
            };
        }
    }
}

module.exports = new FareCalculatorService();
