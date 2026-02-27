// src/app.js
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const app = express();

// ═══════════════════════════════════════════════════════════════════════
// IMPORT ROUTES - BACKOFFICE (ADMIN)
// ═══════════════════════════════════════════════════════════════════════

const employeeRoutes = require("./routes/backoffice/employeeRoutes");
const backofficeAuthRoutes = require("./routes/backoffice/authRoutes");
const passengerRoutes = require('./routes/backoffice/passengerRoutes');
const driverRoutes = require('./routes/backoffice/driverRoutes');
const tripRoutes = require('./routes/backoffice/tripRoutes');
const couponRoutes = require('./routes/backoffice/couponRoutes');
const pricingRoutes = require('./routes/backoffice/pricingRoutes');
const supportRoutes = require('./routes/backoffice/supportRoutes');
const partnerRoutes = require('./routes/backoffice/partnerRoutes');
const vehicleRoutes = require('./routes/backoffice/vehicleRoutes');
const uploadRoutes = require('./routes/backoffice/uploadRoutes');
const vehicleRentalRoutes = require('./routes/backoffice/vehicleRentalRoutes');
const serviceAdminRoutes = require('./routes/backoffice/serviceAdmin.routes');
const serviceRequestAdminRoutes = require('./routes/backoffice/serviceRequestAdmin.routes');
const servicePaymentAdminRoutes = require('./routes/backoffice/servicePaymentAdmin.routes');
const serviceProviderAdminRoutes = require('./routes/backoffice/serviceProviderAdmin.routes');
const serviceReportsAdminRoutes = require('./routes/backoffice/serviceReportsAdmin.routes');
const serviceListingAdminRoutes = require('./routes/backoffice/serviceListingAdmin.routes');
const serviceDisputeAdminRoutes = require('./routes/backoffice/serviceDisputeAdmin.routes');
const employeeProfileRoutes = require('./routes/backoffice/employeeProfile.routes');

// ═══════════════════════════════════════════════════════════════════════
// IMPORT ROUTES - PUBLIC (MOBILE/WEB USERS)
// ═══════════════════════════════════════════════════════════════════════

// Authentication & User Management
const authRoutes = require('./routes/auth.routes');
const profileRoutes = require('./routes/profileRoutes');
const driverProfileRoutes = require('./routes/driverProfileRoutes');
const preferencesRoutes = require('./routes/preferencesRoutes');

// Ride Booking
const driverPublicRoutes = require('./routes/driver.routes');
const tripPublicRoutes = require('./routes/trip.routes');
const tripsPublicViewRoutes = require('./routes/public/trips.routes');  // ← NEW: Recent trips & details
const rentalRoutes = require('./routes/rentalRoutes');
const ratingRoutes = require('./routes/rating.routes');
const chatRoutes = require('./routes/chat.routes');
const fareRoutes = require('./routes/fareRoutes');

// Services Marketplace
const serviceCategoryRoutes = require('./routes/serviceCategory.routes');
const serviceListingRoutes = require('./routes/serviceListing.routes');
const serviceRequestRoutes = require('./routes/serviceRequest.routes');
const serviceRatingRoutes = require('./routes/serviceRating.routes');
const serviceDisputeRoutes = require('./routes/serviceDispute.routes');

// Support
const userSupportRoutes = require('./routes/supportRoutes');

// Public APIs (Mobile Dashboard)
const promotionRoutes = require('./routes/public/promotions.routes');
const statsRoutes = require('./routes/public/stats.routes');
const activityRoutes = require('./routes/activity/activity.routes');


// ═══════════════════════════════════════════════════════════════════════
// IMPORT JOBS
// ═══════════════════════════════════════════════════════════════════════

const { startCleanupJob } = require('./jobs/cleanup.job');

// ═══════════════════════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// Static files
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// ═══════════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        services: {
            ride_booking: 'active',
            services_marketplace: 'active',
            backoffice: 'active',
            public_api: 'active'
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════
// ROUTE REGISTRATION - PUBLIC ROUTES (Mobile/Web Users)
// ═══════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────
// Authentication & User Management
// ───────────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/users', profileRoutes);
app.use('/api/profile/driver', driverProfileRoutes);
app.use('/api/preferences', preferencesRoutes);

// ───────────────────────────────────────────────────────────────────────
// Public Dashboard APIs (Mobile/Web)
// ───────────────────────────────────────────────────────────────────────
app.use('/api/promotions', promotionRoutes);
app.use('/api/users/stats', statsRoutes);


// ───────────────────────────────────────────────────────────────────────
// Ride Booking
// ───────────────────────────────────────────────────────────────────────
app.use('/api/driver', driverPublicRoutes);

// ═══════════════════════════════════════════════════════════════════════
// CRITICAL: TRIPS ROUTES - Order Matters!
// ═══════════════════════════════════════════════════════════════════════
// Mount the viewing routes (recent, details) at /api/trips
// These routes handle: GET /api/trips/recent, GET /api/trips/:tripId
app.use('/api/trips', tripsPublicViewRoutes);  // ← FIRST: Handles GET /recent, GET /:tripId

app.use('/api/trips', fareRoutes);
app.use('/api/trips', tripPublicRoutes);  // ← SECOND: Handles POST, PATCH, DELETE

app.use('/api/rentals', rentalRoutes);
app.use('/api/ratings', ratingRoutes);
app.use('/api/chat', chatRoutes);

// ───────────────────────────────────────────────────────────────────────
// Services Marketplace (Public)
// ───────────────────────────────────────────────────────────────────────
app.use('/api/services/categories', serviceCategoryRoutes);
app.use('/api/services/moderation', serviceListingRoutes);
app.use('/api/services/requests', serviceRequestRoutes);
app.use('/api/services/ratings', serviceRatingRoutes);
app.use('/api/services/disputes', serviceDisputeRoutes);

// ───────────────────────────────────────────────────────────────────────
// Support
// ───────────────────────────────────────────────────────────────────────
app.use('/api/user/support', userSupportRoutes);
app.use('/api/activity', activityRoutes);


// ═══════════════════════════════════════════════════════════════════════
// ROUTE REGISTRATION - BACKOFFICE ROUTES (Admin Only)
// ═══════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────
// Employee Management & Authentication
// ───────────────────────────────────────────────────────────────────────
app.use('/api/backoffice/auth', backofficeAuthRoutes);
app.use('/api/backoffice/employees', employeeRoutes);
app.use('/api/employee/profile', employeeProfileRoutes);

// ───────────────────────────────────────────────────────────────────────
// User Management
// ───────────────────────────────────────────────────────────────────────
app.use('/api/backoffice/passengers', passengerRoutes);
app.use('/api/backoffice/drivers', driverRoutes);
app.use('/api/backoffice/partners', partnerRoutes);

// ───────────────────────────────────────────────────────────────────────
// Ride Booking Management
// ───────────────────────────────────────────────────────────────────────
app.use('/api/backoffice/trips', tripRoutes);
app.use('/api/backoffice/vehicles', vehicleRoutes);
app.use('/api/backoffice/vehicle-rentals', vehicleRentalRoutes);

// ───────────────────────────────────────────────────────────────────────
// Business Operations
// ───────────────────────────────────────────────────────────────────────
app.use('/api/backoffice/pricing', pricingRoutes);
app.use('/api/backoffice/coupons', couponRoutes);
app.use('/api/backoffice/support', supportRoutes);
app.use('/api/backoffice/upload', uploadRoutes);

// ───────────────────────────────────────────────────────────────────────
// Services Marketplace Management (Admin)
// ───────────────────────────────────────────────────────────────────────
app.use('/api/services/admin', serviceAdminRoutes);
app.use('/api/services/admin/listings', serviceListingAdminRoutes);
app.use('/api/services/admin/requests', serviceRequestAdminRoutes);
app.use('/api/services/admin/payments', servicePaymentAdminRoutes);
app.use('/api/services/admin/providers', serviceProviderAdminRoutes);
app.use('/api/services/admin/disputes', serviceDisputeAdminRoutes);
app.use('/api/services/admin/reports', serviceReportsAdminRoutes);
// ═══════════════════════════════════════════════════════════════════════
// ERROR HANDLERS
// ═══════════════════════════════════════════════════════════════════════

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Route not found',
        path: req.originalUrl,
        method: req.method,
        message: `Cannot ${req.method} ${req.originalUrl}`
    });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('❌ [GLOBAL ERROR HANDLER]');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('Error:', err.message);
    console.error('Stack:', err.stack);
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    res.status(err.status || 500).json({
        success: false,
        error: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong!',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
});

// ═══════════════════════════════════════════════════════════════════════
// START BACKGROUND JOBS
// ═══════════════════════════════════════════════════════════════════════

startCleanupJob();

module.exports = app;