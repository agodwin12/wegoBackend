# Database Schema Consistency Fixes

**Date**: 2025-01-20
**Issue**: Trip status values and field names were inconsistent between database schema, models, and application code

---

## Problem Summary

The WEGO backend had critical inconsistencies:

1. **Trip Status Values**: Mixed lowercase (`'searching'`, `'matched'`) and UPPERCASE (`'MATCHED'`, `'SEARCHING'`)
2. **Field Names**: Mixed snake_case (`distance_m`, `fare_estimate`) and camelCase (`distanceM`, `fareEstimate`)
3. **Payment Method Values**: Mixed lowercase (`'cash'`, `'momo'`) and UPPERCASE (`'CASH'`, `'MOMO'`)

This caused **complete system failure** where:
- Trips created with lowercase status couldn't be found by socket handlers expecting UPPERCASE
- Database queries failed due to field name mismatches
- Redis and database stored different formats

---

## Files Fixed

### 1. **src/controllers/tripController.js**
- ✅ Changed all status values to UPPERCASE: `'SEARCHING'`, `'MATCHED'`, `'DRIVER_EN_ROUTE'`, `'DRIVER_ARRIVED'`, `'IN_PROGRESS'`, `'COMPLETED'`, `'CANCELED'`
- ✅ Changed field names to camelCase: `distanceM`, `durationS`, `fareEstimate`, `paymentMethod`
- ✅ Updated status checks in lines: 58, 86-97, 109, 223, 264

### 2. **src/services/tripMatchingService.js**
- ✅ Changed status values to UPPERCASE: `'SEARCHING'`, `'MATCHED'`
- ✅ Changed field names to camelCase: `distanceM`, `durationS`, `fareEstimate`, `paymentMethod`
- ✅ Updated in lines: 24, 44-55, 122, 130-145, 167, 240

### 3. **src/sockets/driverHandlers.js**
- ✅ Already using UPPERCASE status values correctly
- ✅ Already using camelCase field names correctly
- ℹ️ No changes needed (this file was the "source of truth")

### 4. **src/validators/trips.validators.js**
- ✅ Updated `payment_method` validator to accept only UPPERCASE: `'CASH'`, `'MOMO'`, `'OM'`
- ✅ Updated `status` validator to accept UPPERCASE values
- ✅ Added `.uppercase()` transformation to ensure consistency

### 5. **src/migrations/20250120000000-fix-trip-schema-inconsistencies.js** (NEW)
- ✅ Created comprehensive migration to fix database schema
- ✅ Renames columns from snake_case to camelCase
- ✅ Updates ENUM values from lowercase to UPPERCASE
- ✅ Adds missing timestamp columns: `driverAssignedAt`, `driverEnRouteAt`, `driverArrivedAt`, `tripStartedAt`, `tripCompletedAt`, `canceledAt`
- ✅ Adds `canceledBy` column
- ✅ Includes rollback functionality for safe deployment

---

## Database Migration

### Running the Migration

```bash
# Run the migration (if Sequelize CLI is configured)
npx sequelize-cli db:migrate

# OR manually run it with Node
node -e "const migration = require('./src/migrations/20250120000000-fix-trip-schema-inconsistencies.js'); const { sequelize } = require('./src/models'); migration.up(sequelize.getQueryInterface(), require('sequelize')).then(() => process.exit(0));"
```

### What the Migration Does

1. **Renames columns** (snake_case → camelCase):
   - `distance_m` → `distanceM`
   - `duration_s` → `durationS`
   - `fare_estimate` → `fareEstimate`
   - `fare_final` → `fareFinal`
   - `payment_method` → `paymentMethod`
   - `cancel_reason` → `cancelReason`

2. **Updates ENUM values** (lowercase → UPPERCASE):
   - Status: `'searching'` → `'SEARCHING'`, `'matched'` → `'MATCHED'`, etc.
   - Payment: `'cash'` → `'CASH'`, `'momo'` → `'MOMO'`, `'om'` → `'OM'`

3. **Adds missing columns**:
   - `driverAssignedAt` (DATE)
   - `driverEnRouteAt` (DATE)
   - `driverArrivedAt` (DATE)
   - `tripStartedAt` (DATE)
   - `tripCompletedAt` (DATE)
   - `canceledAt` (DATE)
   - `canceledBy` (ENUM: 'PASSENGER', 'DRIVER', 'SYSTEM')

4. **Uses transactions** for data safety

---

## Standardized Values

### Trip Status Values (UPPERCASE)
```javascript
'DRAFT'
'SEARCHING'
'MATCHED'
'DRIVER_ASSIGNED'
'DRIVER_EN_ROUTE'
'DRIVER_ARRIVED'
'IN_PROGRESS'
'COMPLETED'
'CANCELED'
'NO_DRIVERS'
```

### Payment Method Values (UPPERCASE)
```javascript
'CASH'
'MOMO'  // MTN Mobile Money
'OM'    // Orange Money
```

### CanceledBy Values (UPPERCASE)
```javascript
'PASSENGER'
'DRIVER'
'SYSTEM'
```

---

## Field Naming Convention

All Trip model fields now use **camelCase** (matching Sequelize best practices):

```javascript
{
  id: String,
  passengerId: String,
  driverId: String,
  status: Enum,
  pickupLat: Decimal,
  pickupLng: Decimal,
  pickupAddress: String,
  dropoffLat: Decimal,
  dropoffLng: Decimal,
  dropoffAddress: String,
  routePolyline: Text,
  distanceM: Integer,        // meters
  durationS: Integer,        // seconds
  fareEstimate: Integer,     // XAF
  fareFinal: Integer,        // XAF
  paymentMethod: Enum,
  cancelReason: String,
  canceledBy: Enum,
  driverAssignedAt: Date,
  driverEnRouteAt: Date,
  driverArrivedAt: Date,
  tripStartedAt: Date,
  tripCompletedAt: Date,
  canceledAt: Date,
  createdAt: Date,
  updatedAt: Date
}
```

---

## Testing Checklist

After running the migration, verify:

- [ ] Existing trips in database have updated status values
- [ ] Trip creation works with new UPPERCASE status
- [ ] Driver can accept trips (status changes to `MATCHED`)
- [ ] Socket handlers receive correct status updates
- [ ] Trip history queries return correct data
- [ ] Payment method validation works
- [ ] All timestamp fields are properly set during trip lifecycle
- [ ] Redis trip data matches database schema

---

## Breaking Changes

⚠️ **WARNING**: This is a breaking change if:
- External clients expect lowercase status values
- API responses are cached with old field names
- Frontend apps use hardcoded lowercase values

**Recommended Actions**:
1. Update all frontend/mobile apps to use UPPERCASE status values
2. Clear any cached API responses
3. Update API documentation
4. Test all trip-related workflows end-to-end

---

## Rollback Procedure

If issues occur, rollback with:

```bash
# Rollback the migration
npx sequelize-cli db:migrate:undo

# OR manually
node -e "const migration = require('./src/migrations/20250120000000-fix-trip-schema-inconsistencies.js'); const { sequelize } = require('./src/models'); migration.down(sequelize.getQueryInterface(), require('sequelize')).then(() => process.exit(0));"
```

This will revert:
- Column names back to snake_case
- ENUM values back to lowercase
- Remove the new timestamp columns

---

## Future Recommendations

1. **Use TypeScript** for compile-time type safety
2. **Add database schema validation** on startup
3. **Implement integration tests** for trip lifecycle
4. **Document API contract** with OpenAPI/Swagger
5. **Add enum constants** to avoid hardcoded strings:
   ```javascript
   const TripStatus = {
     DRAFT: 'DRAFT',
     SEARCHING: 'SEARCHING',
     MATCHED: 'MATCHED',
     // ...
   };
   ```

---

## Contact

For questions about these changes, review the git commit history or check:
- Trip Model: `src/models/Trip.js`
- Migration: `src/migrations/20250120000000-fix-trip-schema-inconsistencies.js`
