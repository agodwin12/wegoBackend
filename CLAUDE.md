# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WEGO is a ride-hailing platform backend built with Node.js, Express, Socket.IO, Sequelize (MySQL), and Redis. It supports real-time driver-passenger matching, trip management, vehicle rentals, and geospatial location tracking.

## Development Commands

### Running the Server
```bash
# Start server (development)
node server.js

# Start with nodemon (auto-restart)
nodemon server.js
```

### Database
- Database migrations are located in `src/migrations/`
- Sequelize models are in `src/models/`
- Database config: `src/config/database.js`
- No Sequelize CLI commands configured in package.json - run migrations manually if needed

### Environment Setup
- Copy environment variables from production or create `.env` file
- Required variables:
  - `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASS`, `DB_PORT`
  - `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` (optional)
  - `JWT_SECRET`
  - `GOOGLE_MAPS_API_KEY` (for route calculation)
  - `EMAIL_PROVIDER`, `EMAIL_FROM` (SendGrid or SMTP)
  - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (for SMS OTP)

## Architecture Overview

### Core Components

**Entry Point**: `server.js`
- Initializes database, email service, HTTP server, and Socket.IO
- Handles graceful shutdown (SIGTERM, SIGINT)
- Startup sequence: DB connect → sync models → init email → start server

**Application**: `src/app.js`
- Express middleware setup (helmet, cors, morgan, express.json)
- Routes mounted at `/api/auth`, `/api/driver`, `/api/trips`, `/api/rentals`
- Static file serving from `/uploads` directory

**Database Models**: `src/models/index.js`
- All Sequelize models and relationships defined here
- Key models: Account, DriverProfile, PassengerProfile, Trip, TripEvent, Vehicle, VehicleRental, DriverLocation
- Relationships:
  - Account (1:1) → PassengerProfile, DriverProfile, Employee
  - Trip (1:N) → TripEvent, ChatMessage
  - Trip (1:1) → Payment
  - Vehicle (N:1) → VehicleCategory
  - VehicleRental (N:1) → Vehicle, Account (user)

**Socket.IO Setup**: `src/sockets/index.js`
- JWT authentication middleware validates token from `socket.handshake.auth.token`
- User info attached to socket: `socket.userId`, `socket.userType`, `socket.email`
- Socket rooms: `user:{userId}`, `driver:{driverId}`, `passenger:{passengerId}`
- Driver events: `driver:online`, `driver:offline`, `driver:location`, `trip:accept`, `trip:decline`, `driver:en_route`, `driver:arrived`, `trip:start`, `trip:complete`, `trip:cancel`
- Passenger events: `trip:cancel`
- General events: `ping/pong`, `connection:test`
- On disconnect: removes socket from Redis, marks drivers offline

### Real-Time Trip Matching Flow

**Trip Request** (`src/controllers/tripController.js`):
1. Passenger sends pickup/dropoff coordinates via REST API
2. System calculates route and fare using Google Maps API (`src/services/fareCalculatorService.js`)
3. Trip stored in Redis with status `searching`
4. `tripMatchingService.broadcastTripToDrivers()` is called

**Trip Broadcasting** (`src/services/tripMatchingService.js`):
1. Finds nearby drivers using Redis geospatial search (`GEORADIUS`)
2. Filters for online AND available drivers
3. Emits `trip:new_request` to driver sockets with trip details and expiry time
4. Stores list of notified drivers in Redis
5. Sets timeout to check if trip was accepted

**Trip Acceptance**:
1. Driver accepts via Socket.IO event `trip:accept`
2. Acquires Redis lock to prevent race conditions
3. Saves trip to MySQL database with status `matched`
4. Creates `trip_created` and `driver_matched` events in TripEvent table
5. Updates driver status to `busy` in Redis
6. Notifies other drivers with `trip:request_expired`
7. Notifies passenger with `trip:driver_assigned`

**Trip Lifecycle**:
- `searching` → `matched` → `en_route` → `arrived` → `in_progress` → `completed`/`cancelled`
- Each status change creates a TripEvent record
- Driver location updates broadcast to passenger in real-time

### Redis Data Structure

**Driver Management**:
- `driver:online:{driverId}` - online status (SETEX)
- `driver:location:{driverId}` - location hash (lat, lng, heading, speed, accuracy, timestamp)
- `drivers:geo:locations` - geospatial index (GEOADD/GEORADIUS)
- `drivers:online` - set of online driver IDs
- `drivers:available` - set of available (not busy) driver IDs

**Trip Management**:
- `trip:{tripId}` - trip data JSON
- `trip:lock:{tripId}` - distributed lock for accepting trips
- `trip:{tripId}:offers` - list of notified drivers
- `passenger:{passengerId}:active_trip` - passenger's current trip ID

**Socket Management**:
- `user:socket:{userId}` - maps user ID to socket ID

**Helper Functions** (`src/config/redis.js`):
- `setDriverLocation()`, `getDriverLocation()`, `findNearbyDrivers()`
- `setDriverOnline()`, `setDriverOffline()`, `setDriverUnavailable()`, `setDriverAvailable()`
- `storeTripInRedis()`, `getTripFromRedis()`
- `acquireLock()`, `releaseLock()` - prevent race conditions
- `storeUserSocket()`, `getUserSocket()`, `removeUserSocket()`

### Authentication & Authorization

**REST API Auth** (`src/middleware/auth.middleware.js`):
- Uses `Authorization: Bearer <token>` header
- Validates JWT using `verifyAccessToken()` from `src/utils/jwt.js`
- Checks account exists and is not DELETED/SUSPENDED
- Attaches `req.user` (Account model instance)

**Socket.IO Auth**:
- Token passed in `socket.handshake.auth.token`
- Verified using `jwt.verify()` with `process.env.JWT_SECRET`
- Decoded payload contains: `uuid`, `user_type`, `email`

**OTP Flow** (`src/services/otp.service.js`, `src/services/auth.services.js`):
- OTP sent via SMS (Twilio) or email (SendGrid/SMTP)
- Stored in VerificationCode table with expiry
- Verified during registration/login

### Location Services

**Location Tracking** (`src/services/locationService.js`):
- Drivers send location updates via Socket.IO (`driver:location`)
- Stored in Redis geospatial index for fast radius queries
- Broadcasted to passengers during active trips

**Nearby Driver Search**:
- Uses Redis `GEORADIUS` command
- Default radius: 5km (configurable via `DRIVER_SEARCH_RADIUS_KM`)
- Returns drivers sorted by distance

**Fare Calculation** (`src/services/fareCalculatorService.js`):
- Uses Google Maps Directions API for route details
- Calculates fare: `base + (distance_km * per_km) + (duration_min * per_min)`
- Applies surge multiplier and enforces minimum fare
- Pricing rules stored per city in PriceRule table

### File Uploads

**Middleware** (`src/middleware/upload.js`):
- Uses Multer for file handling
- Sharp for image processing (resize, compress)
- Uploads stored in `uploads/` directory
- Static files served at `/uploads/*`

**Common Use Cases**:
- Driver documents (license, insurance, vehicle photos)
- Profile pictures

## Important Patterns

### Error Handling
- Use structured error objects with `status` property
- Middleware in `src/middleware/error.js`
- Console logging with emojis for visibility (🔄, ✅, ❌, ⚠️, 📍, 💾, etc.)

### Idempotency
- Middleware in `src/middleware/idempotency.js`
- Uses IdempotencyKey model to prevent duplicate trip requests

### Validation
- Validators in `src/validators/` using Joi
- Middleware in `src/middleware/validate.js`

### Distributed Locks
- Always use Redis locks when modifying shared resources (trips, driver status)
- Pattern: `acquireLock()` → try/catch → `releaseLock()` in finally block
- Default TTL: 10 seconds

### Socket.IO Event Naming
- Format: `{entity}:{action}` (e.g., `trip:accept`, `driver:online`)
- Always emit acknowledgments or error events back to client
- Log all socket events with context (userId, tripId, etc.)

## Vehicle Rental System

**Models**:
- `Vehicle` - vehicle details, belongs to partner (Account), posted by employee
- `VehicleCategory` - categories (sedan, SUV, motorcycle, etc.) with daily/weekly/monthly base prices
- `VehicleRental` - rental bookings with status tracking

**Relationships**:
- Vehicle → VehicleCategory (N:1)
- VehicleRental → Vehicle (N:1)
- VehicleRental → Account/user (N:1)
- VehicleRental → Account/employee (N:1, handledByEmployeeId)
- VehicleRental → Account/admin (N:1, approvedByAdminId)

## Debugging Tips

### Check Redis State
```bash
# Connect to Redis CLI
redis-cli

# Check online drivers
SMEMBERS drivers:online

# Check available drivers
SMEMBERS drivers:available

# Get driver location
HGETALL driver:location:{driverId}

# Find nearby drivers
GEORADIUS drivers:geo:locations {lng} {lat} 5 km WITHDIST
```

### Check Active Sockets
- Socket IDs stored in Redis: `user:socket:{userId}`
- Use `io.sockets.sockets.get(socketId)` to check if socket is connected

### Common Issues
- **"No drivers available"**: Check Redis geospatial index is populated with driver locations
- **Trip not accepting**: Check Redis lock isn't stuck (should auto-expire in 10s)
- **Socket not receiving events**: Verify JWT token is valid and socket is authenticated
- **Google Maps errors**: Check API key and quota limits

## Code Conventions

- Use `async/await` over promises
- Console log with contextual emojis and clear prefixes (e.g., `[MATCHING]`, `[SOCKET]`, `[AUTH]`)
- Store temporary/ephemeral data in Redis, persistent data in MySQL
- Always validate user input with Joi schemas
- Use UUIDs for all primary keys (via `uuid.v4()`)
- Timestamps handled by Sequelize (`createdAt`, `updatedAt`)
