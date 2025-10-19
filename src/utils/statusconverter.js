// src/utils/statusConverter.js

/**
 * ═══════════════════════════════════════════════════════════════════════
 * STATUS CONVERTER UTILITY
 * Converts backend UPPERCASE statuses to frontend lowercase statuses
 * ═══════════════════════════════════════════════════════════════════════
 */

// Backend (Database) ↔ Frontend (Flutter) Status Mapping
const STATUS_MAP = {
    // Backend Status → Frontend Status
    'DRAFT': 'draft',
    'SEARCHING': 'pending',              // Map SEARCHING → pending
    'MATCHED': 'matched',
    'DRIVER_ASSIGNED': 'matched',        // Fallback mapping
    'DRIVER_EN_ROUTE': 'driver_en_route',
    'DRIVER_ARRIVED': 'arrived_pickup',
    'IN_PROGRESS': 'in_progress',
    'COMPLETED': 'completed',
    'CANCELED': 'canceled',
    'NO_DRIVERS': 'no_drivers',
};

// Reverse mapping for converting frontend → backend if needed
const REVERSE_STATUS_MAP = {
    'draft': 'DRAFT',
    'pending': 'SEARCHING',
    'matched': 'MATCHED',
    'driver_en_route': 'DRIVER_EN_ROUTE',
    'arrived_pickup': 'DRIVER_ARRIVED',
    'in_progress': 'IN_PROGRESS',
    'completed': 'COMPLETED',
    'canceled': 'CANCELED',
    'no_drivers': 'NO_DRIVERS',
};

/**
 * Convert backend UPPERCASE status to frontend lowercase status
 * @param {string} backendStatus - The UPPERCASE status from database
 * @returns {string} - The lowercase status for frontend
 */
function toFrontendStatus(backendStatus) {
    if (!backendStatus) return null;

    // Try exact mapping first
    if (STATUS_MAP[backendStatus]) {
        return STATUS_MAP[backendStatus];
    }

    // Fallback: convert to lowercase with underscores
    return backendStatus.toLowerCase();
}

/**
 * Convert frontend lowercase status to backend UPPERCASE status
 * @param {string} frontendStatus - The lowercase status from frontend
 * @returns {string} - The UPPERCASE status for database
 */
function toBackendStatus(frontendStatus) {
    if (!frontendStatus) return null;

    // Try exact mapping first
    if (REVERSE_STATUS_MAP[frontendStatus]) {
        return REVERSE_STATUS_MAP[frontendStatus];
    }

    // Fallback: convert to uppercase
    return frontendStatus.toUpperCase();
}

/**
 * Convert trip object for frontend response
 * Converts all relevant fields including status
 * @param {Object} trip - The trip object from database
 * @returns {Object} - Trip object formatted for frontend
 */
function formatTripForFrontend(trip) {
    if (!trip) return null;

    return {
        id: trip.id,
        status: toFrontendStatus(trip.status),
        passengerId: trip.passengerId,
        driverId: trip.driverId,

        // Location data
        pickupLat: trip.pickupLat,
        pickupLng: trip.pickupLng,
        pickupAddress: trip.pickupAddress,
        dropoffLat: trip.dropoffLat,
        dropoffLng: trip.dropoffLng,
        dropoffAddress: trip.dropoffAddress,

        // Route data
        routePolyline: trip.routePolyline,
        distanceM: trip.distanceM,
        durationS: trip.durationS,

        // Fare data
        fareEstimate: trip.fareEstimate,
        fareFinal: trip.fareFinal,
        paymentMethod: trip.paymentMethod?.toLowerCase(), // Also convert to lowercase

        // Timestamps
        driverAssignedAt: trip.driverAssignedAt,
        driverEnRouteAt: trip.driverEnRouteAt,
        driverArrivedAt: trip.driverArrivedAt,
        tripStartedAt: trip.tripStartedAt,
        tripCompletedAt: trip.tripCompletedAt,
        canceledAt: trip.canceledAt,
        canceledBy: trip.canceledBy?.toLowerCase(), // Convert to lowercase
        cancelReason: trip.cancelReason,

        createdAt: trip.createdAt,
        updatedAt: trip.updatedAt,
    };
}

/**
 * Get user-friendly status message for frontend display
 * @param {string} backendStatus - The UPPERCASE status from database
 * @returns {string} - User-friendly message
 */
function getStatusMessage(backendStatus) {
    const messages = {
        'DRAFT': 'Draft trip',
        'SEARCHING': 'Searching for drivers...',
        'MATCHED': 'Driver assigned',
        'DRIVER_ASSIGNED': 'Driver assigned',
        'DRIVER_EN_ROUTE': 'Driver is on the way',
        'DRIVER_ARRIVED': 'Driver has arrived',
        'IN_PROGRESS': 'Trip in progress',
        'COMPLETED': 'Trip completed',
        'CANCELED': 'Trip canceled',
        'NO_DRIVERS': 'No drivers available',
    };

    return messages[backendStatus] || 'Unknown status';
}

// ═══════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════

module.exports = {
    toFrontendStatus,
    toBackendStatus,
    formatTripForFrontend,
    getStatusMessage,
    STATUS_MAP,
    REVERSE_STATUS_MAP,
};