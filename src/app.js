// src/app.js
'use strict';

const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');
const path    = require('path');

const app = express();


//upload
const uploadRoutesMobile = require('./routes/upload.routes');


// ═══════════════════════════════════════════════════════════════════════════════
// IMPORT ROUTES — BACKOFFICE (ADMIN / EMPLOYEE)
// ═══════════════════════════════════════════════════════════════════════════════

const employeeRoutes              = require('./routes/backoffice/employeeRoutes');
const backofficeAuthRoutes        = require('./routes/backoffice/authRoutes');
const passengerRoutes             = require('./routes/backoffice/passengerRoutes');
const driverRoutes                = require('./routes/backoffice/driverRoutes');
const tripRoutes                  = require('./routes/backoffice/tripRoutes');
const couponRoutes                = require('./routes/backoffice/couponRoutes');
const pricingRoutes               = require('./routes/backoffice/pricingRoutes');
const supportRoutes               = require('./routes/backoffice/supportRoutes');
const partnerRoutes               = require('./routes/backoffice/partnerRoutes');
const vehicleRoutes               = require('./routes/backoffice/vehicleRoutes');
const uploadRoutes                = require('./routes/backoffice/uploadRoutes');
const vehicleRentalRoutes         = require('./routes/backoffice/vehicleRentalRoutes');
const serviceAdminRoutes          = require('./routes/backoffice/serviceAdmin.routes');
const serviceRequestAdminRoutes   = require('./routes/backoffice/serviceRequestAdmin.routes');
const servicePaymentAdminRoutes   = require('./routes/backoffice/servicePaymentAdmin.routes');
const serviceProviderAdminRoutes  = require('./routes/backoffice/serviceProviderAdmin.routes');
const serviceReportsAdminRoutes   = require('./routes/backoffice/serviceReportsAdmin.routes');
const serviceListingAdminRoutes   = require('./routes/backoffice/serviceListingAdmin.routes');
const serviceDisputeAdminRoutes   = require('./routes/backoffice/serviceDisputeAdmin.routes');
const employeeProfileRoutes       = require('./routes/backoffice/employeeProfile.routes');
const adminEarningsRoutes         = require('./routes/backoffice/adminEarnings.routes');
const payoutRoutes                = require('./routes/backoffice/payout.routes');
const dashboardRoutes             = require('./routes/backoffice/dashboard.routes');

// Delivery backoffice routes
const deliveryAdminRoutes         = require('./routes/backoffice/deliveryAdmin.routes');
const deliveryLiveRoutes          = require('./routes/backoffice/deliveryLiveMonitor.routes');
const deliveryDisputesRoutes      = require('./routes/backoffice/deliveryDisputes.routes');
const deliveryAnalyticsRoutes     = require('./routes/backoffice/deliveryAnalytics.routes');
const deliveryOverviewRoutes      = require('./routes/backoffice/deliveryOverview.routes');
const deliveryWalletsRoutes       = require('./routes/backoffice/deliveryWallets.routes');
const deliveryCategoriesRoutes    = require('./routes/backoffice/deliveryCategories.routes');
const deliveryAgentsRoutes        = require('./routes/backoffice/deliveryAgents.routes');
const deliveryHistoryRoutes       = require('./routes/backoffice/deliveryHistory.routes');
const agentHistoryRoutes = require('./routes/delivery/agentDeliveryHistory.routes');
const agentProfileRoutes = require('./routes/delivery/agentProfile.routes');

// ═══════════════════════════════════════════════════════════════════════════════
// IMPORT ROUTES — PUBLIC (MOBILE / WEB USERS)
// ═══════════════════════════════════════════════════════════════════════════════
//SWITCH MODE
const switchModeRoutes = require('./routes/switchMode.routes');

// Auth & profiles
const authRoutes                  = require('./routes/auth.routes');
const profileRoutes               = require('./routes/profileRoutes');
const driverProfileRoutes         = require('./routes/driverProfileRoutes');
const preferencesRoutes           = require('./routes/preferencesRoutes');

// Ride booking
const driverPublicRoutes          = require('./routes/driver.routes');
const tripPublicRoutes            = require('./routes/trip.routes');
const tripsPublicViewRoutes       = require('./routes/public/trips.routes');
const rentalRoutes                = require('./routes/rentalRoutes');
const ratingRoutes                = require('./routes/rating.routes');
const chatRoutes                  = require('./routes/chat.routes');
const fareRoutes                  = require('./routes/fareRoutes');
const driverPayoutRoutes          = require('./routes/driverPayout.routes');
const driverTopUpRoutes = require('./routes/driverTopUp.routes');

// ── DELIVERY ─────────────────────────────────────────────────────────────────

const deliveryRoutes              = require('./routes/delivery.routes');

// Backoffice top-up admin router (separate router from delivery.routes.js)
const { adminRouter: topUpAdminRouter } = require('./routes/delivery/walletTopUp.routes');

// ── Services marketplace ──────────────────────────────────────────────────────
const serviceCategoryRoutes       = require('./routes/serviceCategory.routes');
const serviceListingRoutes        = require('./routes/serviceListing.routes');
const serviceRequestRoutes        = require('./routes/serviceRequest.routes');
const serviceRatingRoutes         = require('./routes/serviceRating.routes');
const serviceDisputeRoutes        = require('./routes/serviceDispute.routes');

// Support & public
const userSupportRoutes           = require('./routes/supportRoutes');
const promotionRoutes             = require('./routes/public/promotions.routes');
const statsRoutes                 = require('./routes/public/stats.routes');
const activityRoutes              = require('./routes/activity/activity.routes');
const driverEarningsRoutes        = require('./routes/driverEarnings.routes');

// ═══════════════════════════════════════════════════════════════════════════════
// IMPORT BACKGROUND JOBS
// ═══════════════════════════════════════════════════════════════════════════════

const { startCleanupJob } = require('./jobs/cleanup.job');
const balanceSheetCron    = require('./services/balanceSheetCron');

// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════════

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// ═══════════════════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
    res.json({
        status:    'ok',
        timestamp: new Date().toISOString(),
        services:  {
            ride_booking:         'active',
            delivery:             'active',
            delivery_wallet:      'active',
            services_marketplace: 'active',
            backoffice:           'active',
            public_api:           'active',
            payout_system:        'active',
        },
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE REGISTRATION — PUBLIC (Mobile / Web)
// ═══════════════════════════════════════════════════════════════════════════════

//uploadRoutes Delivery Mobile
app.use('/api/upload', uploadRoutesMobile);


//SWITHC MODE
app.use('/api/auth', switchModeRoutes);

// Auth & user management
app.use('/api/auth',             authRoutes);
app.use('/api/users',            profileRoutes);
app.use('/api/profile/driver',   driverProfileRoutes);
app.use('/api/preferences',      preferencesRoutes);

// Public dashboard
app.use('/api/promotions',       promotionRoutes);
app.use('/api/users/stats',      statsRoutes);

// Ride booking
app.use('/api/driver',                  driverPublicRoutes);
app.use('/api/request/payout/driver',   driverPayoutRoutes);
app.use('/api/driver/wallet', driverTopUpRoutes);

// ─── DELIVERY — PUBLIC ROUTES ────────────────────────────────────────────────
//

app.use('/api/deliveries', deliveryRoutes);
app.use('/api/deliveries/agent', agentHistoryRoutes);

// ─── TRIPS (critical order — most specific first) ────────────────────────────
app.use('/api/trips', tripsPublicViewRoutes);
app.use('/api/trips', fareRoutes);
app.use('/api/trips', tripPublicRoutes);

app.use('/api/rentals', rentalRoutes);
app.use('/api/ratings', ratingRoutes);
app.use('/api/chat',    chatRoutes);

// Services marketplace (public)
app.use('/api/services/categories', serviceCategoryRoutes);
app.use('/api/services/listings', serviceListingRoutes);
app.use('/api/services/requests',   serviceRequestRoutes);
app.use('/api/services/ratings',    serviceRatingRoutes);
app.use('/api/services/disputes',   serviceDisputeRoutes);

// Support & activity
app.use('/api/user/support', userSupportRoutes);
app.use('/api/activity',     activityRoutes);

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE REGISTRATION — BACKOFFICE (Employee / Admin)
// ═══════════════════════════════════════════════════════════════════════════════

// Employee management
app.use('/api/backoffice/auth',      backofficeAuthRoutes);
app.use('/api/backoffice/employees', employeeRoutes);
app.use('/api/employee/profile',     employeeProfileRoutes);

// Earnings
app.use('/api/earnings/driver', driverEarningsRoutes);
app.use('/api/admin/earnings',  adminEarningsRoutes);
app.use('/api/admin/payouts',   payoutRoutes);

// User management
app.use('/api/backoffice/passengers', passengerRoutes);
app.use('/api/backoffice/drivers',    driverRoutes);
app.use('/api/backoffice/partners',   partnerRoutes);

// Ride operations
app.use('/api/backoffice/trips',          tripRoutes);
app.use('/api/backoffice/vehicles',       vehicleRoutes);
app.use('/api/backoffice/vehicle-rentals', vehicleRentalRoutes);

// Business ops
app.use('/api/backoffice/pricing',   pricingRoutes);
app.use('/api/backoffice/coupons',   couponRoutes);
app.use('/api/backoffice/support',   supportRoutes);
app.use('/api/backoffice/upload',    uploadRoutes);
app.use('/api/backoffice/dashboard', dashboardRoutes);

// ─── DELIVERY BACKOFFICE ─────────────────────────────────────────────────────

app.use('/api/backoffice/delivery/topups',     topUpAdminRouter);       // ← FIRST (most specific)
app.use('/api/backoffice/delivery/agents',     deliveryAgentsRoutes);
app.use('/api/backoffice/delivery/live',       deliveryLiveRoutes);
app.use('/api/backoffice/delivery/history',    deliveryHistoryRoutes);
app.use('/api/backoffice/delivery/disputes',   deliveryDisputesRoutes);
app.use('/api/backoffice/delivery/analytics',  deliveryAnalyticsRoutes);
app.use('/api/backoffice/delivery/overview',   deliveryOverviewRoutes);
app.use('/api/backoffice/delivery/categories', deliveryCategoriesRoutes);
app.use('/api/services/admin/delivery',        deliveryAdminRoutes);    // pricing + surge
app.use('/api/backoffice/delivery',            deliveryWalletsRoutes);  // ← LAST (catch-all)
app.use('/api/deliveries/agent', agentProfileRoutes);


// Services marketplace management
app.use('/api/services/admin',           serviceAdminRoutes);
app.use('/api/services/admin/listings',  serviceListingAdminRoutes);
app.use('/api/services/admin/requests',  serviceRequestAdminRoutes);
app.use('/api/services/admin/payments',  servicePaymentAdminRoutes);
app.use('/api/services/admin/providers', serviceProviderAdminRoutes);
app.use('/api/services/admin/disputes',  serviceDisputeAdminRoutes);
app.use('/api/services/admin/reports',   serviceReportsAdminRoutes);

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

// 404 — no route matched
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error:   'Route not found',
        path:    req.originalUrl,
        method:  req.method,
        message: `Cannot ${req.method} ${req.originalUrl}`,
    });
});

// Global error handler
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('❌ [GLOBAL ERROR HANDLER]');
    console.error('   Error:', err.message);
    console.error('   Path: ', req.originalUrl);
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    res.status(err.status || 500).json({
        success: false,
        error:   process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong!',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BACKGROUND JOBS
// ═══════════════════════════════════════════════════════════════════════════════

startCleanupJob();
balanceSheetCron.start();

module.exports = app;