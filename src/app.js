// src/app.js
'use strict';

const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');
const path    = require('path');

const { corsOptions, globalLimiter, authLimiter } = require('./config/security');

const app = express();

// Behind the Caddy/nginx reverse proxy — trust the first proxy hop so
// req.ip, secure-cookie detection and rate-limiting all key on the real
// client IP instead of the proxy's.
app.set('trust proxy', 1);

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE IMPORTS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Upload ───────────────────────────────────────────────────────────────────
const uploadRoutesMobile          = require('./routes/upload.routes');

// ─── Auth & Identity ──────────────────────────────────────────────────────────
const authRoutes                  = require('./routes/auth.routes');
const switchModeRoutes            = require('./routes/switchMode.routes');
const profileRoutes               = require('./routes/profileRoutes');
const driverProfileRoutes         = require('./routes/driverProfileRoutes');
const preferencesRoutes           = require('./routes/preferencesRoutes');
const activityRoutes              = require('./routes/activity/activity.routes');

// ─── Ride Hailing (public) ────────────────────────────────────────────────────
const driverPublicRoutes          = require('./routes/driver.routes');
const fleetOwnerRoutes            = require('./routes/fleet.routes');
const tripsPublicViewRoutes       = require('./routes/public/trips.routes');
const fareRoutes                  = require('./routes/fareRoutes');
const tripPublicRoutes            = require('./routes/trip.routes');
const rentalRoutes                = require('./routes/rentalRoutes');
const ratingRoutes                = require('./routes/rating.routes');
const chatRoutes                  = require('./routes/chat.routes');
const driverTopUpRoutes           = require('./routes/driverTopUp.routes');         // ride-hailing driver wallet (top-up only)
const driverEarningsRoutes        = require('./routes/driverEarnings.routes');

// ─── Delivery (public / driver-facing) ───────────────────────────────────────
const deliveryRoutes              = require('./routes/delivery.routes');            // main delivery CRUD + driver actions
const agentHistoryRoutes          = require('./routes/delivery/agentDeliveryHistory.routes');
const agentProfileRoutes          = require('./routes/delivery/agentProfile.routes');
const {
    driverRouter: deliveryWalletDriverRouter,  // /api/deliveries/driver/wallet  ← agent top-up, balance, history
    adminRouter:  topUpAdminRouter,            // /api/backoffice/delivery/topups ← backoffice top-up queue
} = require('./routes/delivery/walletTopUp.routes');

// ─── Services Marketplace (public) ───────────────────────────────────────────
const serviceCategoryRoutes       = require('./routes/serviceCategory.routes');
const serviceListingRoutes        = require('./routes/serviceListing.routes');
const serviceRatingRoutes         = require('./routes/serviceRating.routes');
const serviceAdPaymentRoutes      = require('./routes/serviceAdPayment.routes');
const serviceSubscriptionRoutes   = require('./routes/serviceSubscription.routes');

// ─── CamPay Payments ──────────────────────────────────────────────────────────
// webhookRoutes MUST be imported before express.json() — raw body needed for
// HMAC signature validation. It captures req.rawBody internally.
const webhookRoutes               = require('./routes/webhook.routes');
const paymentRoutes               = require('./routes/payment.routes');

// ─── Support & Promotions ─────────────────────────────────────────────────────
const userSupportRoutes           = require('./routes/supportRoutes');
const promotionRoutes             = require('./routes/public/promotions.routes');
const statsRoutes                 = require('./routes/public/stats.routes');

// ─── Backoffice — Auth & Employee Management ──────────────────────────────────
const backofficeAuthRoutes        = require('./routes/backoffice/authRoutes');
const employeeRoutes              = require('./routes/backoffice/employeeRoutes');
const employeeProfileRoutes       = require('./routes/backoffice/employeeProfile.routes');

// ─── Backoffice — User Management ────────────────────────────────────────────
const passengerRoutes             = require('./routes/backoffice/passengerRoutes');
const driverRoutes                = require('./routes/backoffice/driverRoutes');
const partnerRoutes               = require('./routes/backoffice/partnerRoutes');
const fleetOwnerAdminRoutes       = require('./routes/backoffice/fleetOwnerRoutes');

// ─── Backoffice — Ride Hailing ────────────────────────────────────────────────
const tripRoutes                  = require('./routes/backoffice/tripRoutes');
const vehicleRoutes               = require('./routes/backoffice/vehicleRoutes');
const vehicleRentalRoutes         = require('./routes/backoffice/vehicleRentalRoutes');
const pricingRoutes               = require('./routes/backoffice/pricingRoutes');

// ─── Backoffice — Delivery ────────────────────────────────────────────────────
const deliveryAdminRoutes         = require('./routes/backoffice/Deliveryadmin.routes');     // pricing + surge
const deliveryAgentsRoutes        = require('./routes/backoffice/deliveryAgents.routes');
const deliveryLiveRoutes          = require('./routes/backoffice/deliveryLiveMonitor.routes');
const deliveryHistoryRoutes       = require('./routes/backoffice/deliveryHistory.routes');
const deliveryDisputesRoutes      = require('./routes/backoffice/deliveryDisputes.routes');
const deliveryAnalyticsRoutes     = require('./routes/backoffice/deliveryAnalytics.routes');
const deliveryOverviewRoutes      = require('./routes/backoffice/deliveryOverview.routes');
const deliveryCategoriesRoutes    = require('./routes/backoffice/deliveryCategories.routes');
const deliveryWalletsRoutes       = require('./routes/backoffice/deliveryWallets.routes');   // catch-all — MUST be last

// ─── Backoffice — Services Marketplace ───────────────────────────────────────
const serviceAdminRoutes          = require('./routes/backoffice/serviceAdmin.routes');
const serviceListingAdminRoutes   = require('./routes/backoffice/serviceListingAdmin.routes');
const serviceListingPlanRoutes    = require('./routes/backoffice/serviceListingPlan.routes');
const serviceProviderAdminRoutes  = require('./routes/backoffice/serviceProviderAdmin.routes');
const serviceReportsAdminRoutes   = require('./routes/backoffice/serviceReportsAdmin.routes');

// ─── Backoffice — Finance & Operations ───────────────────────────────────────
const adminEarningsRoutes         = require('./routes/backoffice/adminEarnings.routes');
const couponRoutes                = require('./routes/backoffice/couponRoutes');
const supportRoutes               = require('./routes/backoffice/supportRoutes');
const uploadRoutes                = require('./routes/backoffice/uploadRoutes');
const dashboardRoutes             = require('./routes/backoffice/dashboard.routes');

// ─── Background Jobs ──────────────────────────────────────────────────────────
const { startCleanupJob }  = require('./jobs/cleanup.job');
const paymentExpiryJob     = require('./jobs/paymentExpiry.job');
const cron                 = require('node-cron');
const { expireListings }   = require('./controllers/serviceAdPayment_controller');
const deviceTokenRoutes = require('./routes/deviceToken_routes');
const notificationRoutes = require('./routes/notification_routes');
const broadcastRoutes = require('./routes/backoffice/broadcast_routes');
// ═══════════════════════════════════════════════════════════════════════════════
// ⚠️  WEBHOOK — MUST BE MOUNTED BEFORE express.json()
// ═══════════════════════════════════════════════════════════════════════════════
// CamPay HMAC validation requires the raw request body.
// express.json() consumes the buffer, so this route handles its own body parsing.

app.use('/api/webhooks', webhookRoutes);

// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════════

app.use(helmet());
app.use(cors(corsOptions));
app.use(globalLimiter);
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
        services: {
            ride_hailing:           'active',
            delivery:               'active',
            delivery_agent_wallet:  'active',
            services_marketplace:   'active',
            car_rental:             'active',
            backoffice:             'active',
            payments:               'active',
        },
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC ROUTES  —  Mobile / Web
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Upload ───────────────────────────────────────────────────────────────────
app.use('/api/upload', uploadRoutesMobile);

// ─── Auth & Identity ──────────────────────────────────────────────────────────
app.use('/api/auth', switchModeRoutes);         // mode-switching endpoints live under /auth
app.use('/api/auth', authLimiter, authRoutes);  // stricter brute-force limit on login/otp/signup
app.use('/api/users',          profileRoutes);
app.use('/api/profile/driver', driverProfileRoutes);
app.use('/api/preferences',    preferencesRoutes);
app.use('/api/activity',       activityRoutes);

// ─── CamPay Payments ──────────────────────────────────────────────────────────
// Mounted early so payment initiation is reachable before vertical-specific routes.
app.use('/api/payments', paymentRoutes);

// ─── Ride Hailing ─────────────────────────────────────────────────────────────
app.use('/api/driver',                driverPublicRoutes);
app.use('/api/fleet',                 fleetOwnerRoutes);            // ride-hailing fleet-owner management
app.use('/api/driver/wallet',         driverTopUpRoutes);           // ride-hailing driver wallet top-up
app.use('/api/earnings/driver',       driverEarningsRoutes);

// Trips — most specific sub-paths first, catch-all last
app.use('/api/trips', tripsPublicViewRoutes);
app.use('/api/trips', fareRoutes);
app.use('/api/trips', tripPublicRoutes);

app.use('/api/rentals', rentalRoutes);
app.use('/api/ratings', ratingRoutes);
app.use('/api/chat',    chatRoutes);

// ─── Delivery (public) ───────────────────────────────────────────────────────
// Order matters: /deliveries/driver/wallet must be mounted BEFORE /deliveries
// so Express resolves wallet routes before the catch-all :id param routes
// inside deliveryRoutes swallow them.
app.use('/api/deliveries/driver/wallet', deliveryWalletDriverRouter); // agent wallet: balance, top-up, history
app.use('/api/deliveries/agent',         agentHistoryRoutes);         // agent delivery history
app.use('/api/deliveries',               deliveryRoutes);             // main delivery routes (catch-all last)

// ─── Services Marketplace ─────────────────────────────────────────────────────
app.use('/api/services/categories',   serviceCategoryRoutes);
app.use('/api/services/subscription', serviceSubscriptionRoutes);   // provider-level "buy plan then post"
app.use('/api/services/listings',     serviceListingRoutes);
app.use('/api/services/ratings',    serviceRatingRoutes);
app.use('/api/services',            serviceAdPaymentRoutes);          // ad payment (broad path — after specific ones)
app.use('/api/services/admin/plans', serviceListingPlanRoutes);

// ─── Support & Promotions ─────────────────────────────────────────────────────
app.use('/api/user/support', userSupportRoutes);
app.use('/api/promotions',   promotionRoutes);
app.use('/api/users/stats',  statsRoutes);

// ═══════════════════════════════════════════════════════════════════════════════
// BACKOFFICE ROUTES  —  Employee / Admin
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Auth & Employee Management ───────────────────────────────────────────────
app.use('/api/backoffice/auth',      authLimiter, backofficeAuthRoutes);
app.use('/api/backoffice/employees', employeeRoutes);
app.use('/api/employee/profile',     employeeProfileRoutes);

// ─── User Management ──────────────────────────────────────────────────────────
app.use('/api/backoffice/passengers', passengerRoutes);
app.use('/api/backoffice/drivers',    driverRoutes);
app.use('/api/backoffice/partners',   partnerRoutes);
app.use('/api/backoffice/fleet-owners', fleetOwnerAdminRoutes);   // ride-hailing fleet owners

// ─── Ride Hailing ─────────────────────────────────────────────────────────────
app.use('/api/backoffice/trips',           tripRoutes);
app.use('/api/backoffice/vehicles',        vehicleRoutes);
app.use('/api/backoffice/vehicle-rentals', vehicleRentalRoutes);
app.use('/api/backoffice/pricing',         pricingRoutes);

// ─── Delivery (backoffice) ────────────────────────────────────────────────────
// CRITICAL ORDER: specific sub-paths MUST be registered before the
// deliveryWalletsRoutes catch-all, otherwise Express swallows them.
app.use('/api/backoffice/delivery/topups',     topUpAdminRouter);        // agent wallet top-up queue
app.use('/api/backoffice/delivery/agents',     deliveryAgentsRoutes);
app.use('/api/backoffice/delivery/live',       deliveryLiveRoutes);
app.use('/api/backoffice/delivery/history',    deliveryHistoryRoutes);
app.use('/api/backoffice/delivery/disputes',   deliveryDisputesRoutes);
app.use('/api/backoffice/delivery/analytics',  deliveryAnalyticsRoutes);
app.use('/api/backoffice/delivery/overview',   deliveryOverviewRoutes);
app.use('/api/backoffice/delivery/categories', deliveryCategoriesRoutes);
app.use('/api/services/admin/delivery',        deliveryAdminRoutes);     // delivery pricing + surge rules
app.use('/api/backoffice/delivery',            deliveryWalletsRoutes);   // ← catch-all LAST

// ─── Services Marketplace (backoffice) ───────────────────────────────────────
app.use('/api/services/admin',           serviceAdminRoutes);
app.use('/api/services/admin/listings',  serviceListingAdminRoutes);
app.use('/api/services/admin/providers', serviceProviderAdminRoutes);
app.use('/api/services/admin/reports',   serviceReportsAdminRoutes);

// ─── Finance & Operations ─────────────────────────────────────────────────────
app.use('/api/admin/earnings',   adminEarningsRoutes);
app.use('/api/backoffice/coupons',   couponRoutes);
app.use('/api/backoffice/support',   supportRoutes);
app.use('/api/backoffice/upload',    uploadRoutes);
app.use('/api/backoffice/dashboard', dashboardRoutes);
app.use('/api/device-tokens', deviceTokenRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/backoffice/broadcasts', broadcastRoutes);

// ─── Agent Profile ────────────────────────────────────────────────────────────
// Mounted after all /api/deliveries/agent sub-paths to avoid catch-all cnflicts
app.use('/api/deliveries/agent', agentProfileRoutes);

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

// Single-runner guard: only the instance with RUN_JOBS !== 'false' executes
// cron jobs. Set RUN_JOBS=false on every extra API replica so payouts,
// cleanup and listing-expiry don't double-fire when scaled horizontally.
if (process.env.RUN_JOBS !== 'false') {
    console.log('🕒 [JOBS] RUN_JOBS enabled — starting background cron jobs');
    startCleanupJob();
    paymentExpiryJob.start();
    cron.schedule('0 2 * * *', expireListings); // daily 02:00 — expire stale listing plans
} else {
    console.log('🚫 [JOBS] RUN_JOBS=false — background cron jobs disabled on this instance');
}

module.exports = app;