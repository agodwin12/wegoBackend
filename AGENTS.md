# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

WEGO is a multi-vertical platform backend built with Node.js, Express, Socket.IO, Sequelize (MySQL), and Redis. It runs four business verticals from a single process: **ride-hailing**, **parcel delivery**, **services marketplace**, and **vehicle rentals**.

## Development Commands

```bash
# Start (development — root-level server.js is the real entry point)
node server.js
nodemon server.js

# The package.json scripts reference src/server.js which does not exist —
# always run from the project root using server.js directly.
```

### Environment Variables
Required in `.env`:
- `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASS`, `DB_PORT`
- `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` (optional)
- `JWT_SECRET`
- `MAPBOX_ACCESS_TOKEN`
- `EMAIL_PROVIDER`, `EMAIL_FROM`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`
- `CAMPAY_APP_USERNAME`, `CAMPAY_APP_PASSWORD`, `CAMPAY_BASE_URL`
- `FIREBASE_SERVICE_ACCOUNT_PATH` (default: `./google-services.json`)
- `CORS_ORIGIN` (default: `*`)
- `DRIVER_SEARCH_RADIUS_KM` (default: 5)

### Database
- Migrations: `src/migrations/` and `migrations/` (root-level)
- Models: `src/models/index.js` (all models and associations)
- Config: `src/config/database.js`
- No Sequelize CLI in package.json — run migrations manually
- `sequelize.sync({ alter: false })` runs on startup; schema changes require explicit migrations

## Architecture Overview

### Startup Sequence (`server.js`)
DB connect → sync models → init email → init Firebase Admin → start notification cleaner cron → start HTTP server + Socket.IO

Firebase init is non-fatal — if `google-services.json` is missing or invalid, push notifications are skipped but all other features continue.

### Route Structure (`src/app.js`)
Routes are organized into two top-level namespaces:

**Public/mobile** (`/api/*`):
- `/api/auth` — registration, login, OTP, token refresh, mode switching
- `/api/driver/*` — driver availability, wallet, earnings, payout
- `/api/trips/*` — fare estimation, trip requests, ride history
- `/api/deliveries/*` — delivery CRUD, agent actions, agent wallet
- `/api/services/*` — service categories, listings, requests, ratings, disputes, ad payments
- `/api/rentals/*` — vehicle rentals
- `/api/payments/*` — CamPay payment initiation
- `/api/webhooks/*` — CamPay HMAC webhooks (**MUST be mounted before `express.json()`**)
- `/api/notifications/*`, `/api/device-tokens` — push notification management

**Backoffice/admin** (`/api/backoffice/*`, `/api/admin/*`, `/api/services/admin/*`):
- Uses separate `authenticateEmployee` middleware (Employee model, not Account)
- Covers all verticals: ride-hailing, delivery, services, rentals, finance

**Route ordering is critical** — specific sub-paths must be registered before catch-all param routes (e.g., `/deliveries/driver/wallet` before `/deliveries`, backoffice delivery sub-routes before `deliveryWalletsRoutes`).

### User Types and Mode Switching

Accounts have a `user_type` (permanent: `PASSENGER`, `DRIVER`, `DELIVERY_AGENT`) and an `active_mode` (mutable). A `DRIVER` can switch to `DELIVERY_AGENT` mode and back via `/api/auth/switch-mode`.

The auth middleware (`src/middleware/auth.middleware.js`) exports:
- `authenticate` — standard mobile user auth; attaches `req.user` (Account) and `req.auth` (decoded claims + resolved `active_mode`)
- `requireRole(...roles)` — gates on `user_type` (permanent)
- `requireMode(...modes)` — gates on `active_mode` (current session mode)
- `requireVerified` — phone or email must be verified
- `requireDriverApproval` — driver profile must be `APPROVED`
- `optionalAuth` — attaches user if token present, otherwise continues

The backoffice uses a separate middleware (`src/middleware/employeeAuth.middleware.js`):
- `authenticateEmployee` — verifies employee JWT (token type `'employee'`), attaches `req.user` (Employee)
- `requireEmployeeRole(...roles)` — employee roles: `super_admin`, `admin`, `support`, etc.

**Token stale detection**: if `active_mode` in the JWT doesn't match the DB, the middleware returns `401 MODE_TOKEN_STALE` with `shouldRefresh: true` — clients should call the refresh endpoint and retry.

### Real-Time: Socket.IO (`src/sockets/index.js`)

Token passed via `socket.handshake.auth.token` (or `.query.token`). Decoded payload includes `uuid`, `user_type`, `active_mode`, `email`. Rooms:
- `user:{userId}` — all users
- `driver:{userId}` — DRIVER and DELIVERY_AGENT
- `passenger:{userId}` — PASSENGER
- `trip:{tripId}` — joined explicitly via `chat:join`

**On reconnect**, the server replays missed state from Redis. Replay is mode-gated — a driver reconnecting in `DELIVERY_AGENT` mode does not receive stale ride-trip state (prevents `invalid payload` crashes). All socket payloads pass through `_sanitize()` (strips `undefined` via JSON round-trip) before emit.

**Disconnect does NOT set driver offline** — Redis geo/online state persists through network blips. Drivers go offline only via explicit `driver:offline` event.

Driver/agent socket events: `driver:online`, `driver:offline`, `driver:location` / `driver:location_update`, `trip:accept`, `trip:decline`, `driver:en_route`, `driver:arrived` / `trip:arrived`, `trip:start`, `trip:complete`, `trip:cancel`

Chat socket events: `chat:join`, `chat:leave`, `chat:send`, `chat:typing`, `chat:mark_read`

### Ride-Hailing Trip Flow

1. Passenger POSTs `/api/trips/request` → fare calculated via Google Maps → stored in Redis (`trip:{id}`) with status `SEARCHING`
2. `tripMatchingService.broadcastTripToDrivers()` → `GEORADIUS` search → emits `trip:new_request` to nearby online+available drivers
3. Driver emits `trip:accept` → acquires Redis lock → saves to MySQL (`status: MATCHED`) → notifies passenger via `trip:driver_assigned`
4. Lifecycle: `SEARCHING` → `MATCHED` → `DRIVER_EN_ROUTE` → `DRIVER_ARRIVED` → `IN_PROGRESS` → `COMPLETED`/`CANCELED`
5. Each status change writes a `TripEvent` record

### Delivery System (`src/controllers/delivery/`, `src/sockets/delivery/`)

Delivery agents work similarly to drivers but use `DELIVERY_AGENT` mode. Key models: `Delivery`, `DeliveryTracking`, `DeliveryCategory`, `DeliveryPricing`, `DeliverySurgeRule`, `DeliveryDispute`, `DeliveryWallet`, `DeliveryWalletTopUp`, `DeliveryWalletTransaction`.

Agents have a `DeliveryWallet` for earnings. Top-ups go through CamPay (`delivery_topup` vertical). Payout requests are managed via `DeliveryPayoutRequest`.

### Services Marketplace (`src/controllers/serviceListing.controller.js`, etc.)

Providers create `ServiceListing`s under `ServiceCategory`s and optionally buy `ServiceListingPlan` ad placements (paid via CamPay `service_request` vertical → `ServiceAdPayment`). Customers create `ServiceRequest`s. Disputes go through `ServiceDispute`.

### Payments: CamPay (`src/services/campay/`)

CamPay handles Mobile Money (MTN/Orange) for Cameroon. Payment flow:
1. Client POSTs `/api/payments/initiate` → creates `WegoPayment` record → calls CamPay collection API
2. CamPay sends webhook to `/api/webhooks/campay` (HMAC-verified, raw body required — route mounted before `express.json()`)
3. Webhook handler updates `WegoPayment.status` and triggers vertical-specific completion logic

Verticals: `trip`, `delivery`, `rental`, `service_request` / `listing_fee` (alias → `ServiceAdPayment`), `delivery_topup`

Token management: `src/services/campay/campayTokenManager.js` caches OAuth tokens with auto-refresh.

### Push Notifications (`src/services/NotificationService.js`)

Firebase Admin SDK sends FCM push notifications. Device tokens stored in `DeviceToken` model via `/api/device-tokens`. Notification rows written to `Notification` model regardless of whether Firebase is initialized — FCM is best-effort. Background job `src/jobs/notification_cleaner.js` prunes old records.

### Background Jobs (node-cron)

Started from `src/app.js`:
- `src/jobs/cleanup.job.js` — cleans expired Redis trips, stale locks, etc.
- `src/services/balanceSheetCron.js` — writes `DailyBalanceSheet` records
- `src/jobs/paymentExpiry.job.js` — expires pending CamPay payments

Started from `server.js`:
- `src/jobs/notification_cleaner.js` — prunes old notifications

### Redis Data Structure

**Driver/Agent state**:
- `driver:online:{id}` — online flag (SETEX)
- `driver:location:{id}` — hash (lat, lng, heading, speed, accuracy, timestamp)
- `drivers:geo:locations` — geospatial index (GEOADD / GEORADIUS)
- `drivers:online`, `drivers:available` — sets

**Trip state**:
- `trip:{id}` (via `REDIS_KEYS.ACTIVE_TRIP(id)`) — full trip JSON
- `trip:lock:{id}` — distributed lock (10s TTL)
- `driver:pending_offers:{driverId}` — pending trip offers for reconnect replay
- `driver:active_trip:{driverId}`, `passenger:active_trip:{passengerId}`

**Socket mapping**:
- `user:socket:{userId}` → socket ID

Helper module: `src/config/redis.js` exports `redisClient`, `redisHelpers`, `REDIS_KEYS`, and named helpers (`setDriverOnline`, `acquireLock`, `releaseLock`, etc.).

### File Storage

Local uploads via Multer + Sharp → `uploads/` directory (served at `/uploads/*`). Cloudflare R2 uploads available via `src/utils/r2Upload.js` (`@aws-sdk/client-s3`).

## Important Patterns

### Auth Middleware Composition
```js
router.post('/route', authenticate, requireMode('DRIVER'), requireDriverApproval, controller);
// Backoffice:
router.get('/route', authenticateEmployee, requireEmployeeRole('admin', 'super_admin'), controller);
```

### Distributed Locks
Always wrap shared resource mutations (trips, driver status) in Redis locks:
```js
const lock = await acquireLock(REDIS_KEYS.TRIP_LOCK(tripId), 10);
try { /* modify */ } finally { await releaseLock(REDIS_KEYS.TRIP_LOCK(tripId)); }
```

### Code Conventions
- `async/await` throughout
- Console logs with emoji prefixes and `[TAG]` identifiers (e.g., `[SOCKET]`, `[AUTH]`, `[MATCHING]`)
- Temporary/ephemeral data in Redis; persistent data in MySQL
- UUIDs for all Account/Trip/Delivery PKs (`uuid.v4()`); integer PKs for backoffice models (Employee, etc.)
- Joi validators in `src/validators/`; applied via `src/middleware/validate.js`
- Idempotency keys (`src/middleware/idempotency.js`) on trip/delivery creation endpoints

## Debugging

```bash
# Redis state inspection
redis-cli SMEMBERS drivers:online
redis-cli SMEMBERS drivers:available
redis-cli HGETALL driver:location:{driverId}
redis-cli GEORADIUS drivers:geo:locations {lng} {lat} 5 km WITHDIST
redis-cli GET user:socket:{userId}

# Check active trip
redis-cli GET trip:{tripId}
```

Common issues:
- **"No drivers available"**: Redis geo index not populated — driver must emit `driver:online` after connecting
- **Trip not accepting**: Redis lock stuck — auto-expires in 10s; check `trip:lock:{tripId}`
- **Socket invalid payload**: `undefined` in emitted data — all payloads must pass through `_sanitize()`
- **MODE_TOKEN_STALE 401**: Client's JWT `active_mode` doesn't match DB — client should refresh token
- **CamPay webhook 400**: Raw body not available — confirm webhook route is mounted before `express.json()`
- **Firebase disabled**: `google-services.json` missing or malformed — push notifications skipped, rest of app unaffected
