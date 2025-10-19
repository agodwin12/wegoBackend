// src/models/index.js

const sequelize = require('../config/database');

// ────────────────────────────────────────────────────────────────
// Model Imports
// ────────────────────────────────────────────────────────────────
const Account = require('./Account');
const PassengerProfile = require('./PassengerProfile');
const DriverProfile = require('./DriverProfile');
const VerificationCode = require('./VerificationCode');
const DriverDocument = require('./DriverDocument');
const Trip = require('./Trip');
const TripEvent = require('./TripEvent');
const ChatMessage = require('./ChatMessage');
const Rating = require('./Rating');
const Payment = require('./Payment');
const Driver = require('./Driver');
const Vehicle = require('./Vehicle');
const PriceRule = require('./PriceRule');
const IdempotencyKey = require('./IdempotencyKey');
const VehicleRental = require('./VehicleRental');
const VehicleCategory = require('./VehicleCategory');
const DriverLocation = require('./DriverLocation');

// ────────────────────────────────────────────────────────────────
// ACCOUNT RELATIONSHIPS
// ────────────────────────────────────────────────────────────────

// 1️⃣ Account ↔ PassengerProfile (1:1)
Account.hasOne(PassengerProfile, {
    foreignKey: 'account_id',
    as: 'passengerProfile',
    onDelete: 'CASCADE',
});
PassengerProfile.belongsTo(Account, {
    foreignKey: 'account_id',
    as: 'passengerAccount',
});

// 2️⃣ Account ↔ DriverProfile (1:1)
Account.hasOne(DriverProfile, {
    foreignKey: 'account_id',
    as: 'driverProfile',
    onDelete: 'CASCADE',
});
DriverProfile.belongsTo(Account, {
    foreignKey: 'account_id',
    as: 'driverAccount',
});

// 3️⃣ Account ↔ VerificationCode (1:N)
Account.hasMany(VerificationCode, {
    foreignKey: 'account_uuid',
    as: 'verificationCodes',
    onDelete: 'CASCADE',
});
VerificationCode.belongsTo(Account, {
    foreignKey: 'account_uuid',
    as: 'verificationAccount',
});

// 4️⃣ Account ↔ DriverDocument (1:N)
Account.hasMany(DriverDocument, {
    foreignKey: 'account_id',
    as: 'driverDocuments',
    onDelete: 'CASCADE',
});
DriverDocument.belongsTo(Account, {
    foreignKey: 'account_id',
    as: 'driverDocumentAccount',
});

// 5️⃣ Account ↔ DriverLocation (1:1)
Account.hasOne(DriverLocation, {
    foreignKey: 'driver_id',
    as: 'driverLocation',
    onDelete: 'CASCADE',
});
DriverLocation.belongsTo(Account, {
    foreignKey: 'driver_id',
    as: 'driverAccountLocation',
});

// ────────────────────────────────────────────────────────────────
// TRIP RELATIONSHIPS
// ────────────────────────────────────────────────────────────────

// Driver ↔ Vehicle
Driver.belongsTo(Vehicle, { foreignKey: 'vehicleId', as: 'vehicle' });

// Trip ↔ Driver
Trip.belongsTo(Driver, { foreignKey: 'driverId', as: 'driver' });

// Trip ↔ TripEvent (1:N)
Trip.hasMany(TripEvent, { foreignKey: 'tripId', as: 'events' });
TripEvent.belongsTo(Trip, { foreignKey: 'tripId', as: 'trip' });

// Trip ↔ ChatMessage (1:N)
Trip.hasMany(ChatMessage, { foreignKey: 'tripId', as: 'messages' });
ChatMessage.belongsTo(Trip, { foreignKey: 'tripId', as: 'trip' });

// Trip ↔ Payment (1:1)
Trip.hasOne(Payment, { foreignKey: 'tripId', as: 'payment' });
Payment.belongsTo(Trip, { foreignKey: 'tripId', as: 'trip' });

// Rating ↔ Trip
Rating.belongsTo(Trip, { foreignKey: 'tripId', as: 'trip' });

// ────────────────────────────────────────────────────────────────
// VEHICLE / RENTAL / CATEGORY RELATIONSHIPS
// ────────────────────────────────────────────────────────────────

// Vehicle ↔ VehicleCategory
Vehicle.belongsTo(VehicleCategory, {
    foreignKey: 'category_id',
    as: 'vehicleCategory', // ✅ renamed alias (no more conflicts)
});
VehicleCategory.hasMany(Vehicle, {
    foreignKey: 'category_id',
    as: 'vehicles',
});

// Vehicle ↔ VehicleRental (1:N)
Vehicle.hasMany(VehicleRental, {
    foreignKey: 'vehicle_id',
    as: 'rentals',
});
VehicleRental.belongsTo(Vehicle, {
    foreignKey: 'vehicle_id',
    as: 'vehicle',
});

// ────────────────────────────────────────────────────────────────
// EXPORT ALL MODELS
// ────────────────────────────────────────────────────────────────

module.exports = {
    sequelize,
    Account,
    PassengerProfile,
    DriverProfile,
    VerificationCode,
    DriverDocument,
    Trip,
    TripEvent,
    ChatMessage,
    Rating,
    Payment,
    Driver,
    Vehicle,
    PriceRule,
    IdempotencyKey,
    VehicleRental,
    VehicleCategory,
    DriverLocation,
};
