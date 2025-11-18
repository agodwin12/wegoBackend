// src/models/index.js

const sequelize = require('../config/database');

// ═══════════════════════════════════════════════════════════════════════
// MODEL IMPORTS
// ═══════════════════════════════════════════════════════════════════════

const Account = require('./Account');
const PassengerProfile = require('./PassengerProfile');
const DriverProfile = require('./DriverProfile');
const VerificationCode = require('./VerificationCode');
const DriverDocument = require('./DriverDocument');
const Trip = require('./Trip');
const TripEvent = require('./TripEvent');
const ChatMessage = require('./ChatMessage');
const Rating = require('./rating.model');
const Payment = require('./Payment');
const Driver = require('./Driver');
const Vehicle = require('./Vehicle');
const PriceRule = require('./PriceRule');
const IdempotencyKey = require('./IdempotencyKey');
const VehicleRental = require('./VehicleRental');
const VehicleCategory = require('./VehicleCategory');
const DriverLocation = require('./DriverLocation');
const Employee = require('./Employee')(sequelize);

// ═══════════════════════════════════════════════════════════════════════
// ACCOUNT RELATIONSHIPS
// ═══════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────
// 1️⃣ Account ↔ PassengerProfile (1:1)
// ───────────────────────────────────────────────────────────────────────
Account.hasOne(PassengerProfile, {
    foreignKey: 'account_id',
    as: 'passenger_profile', // ✅ IMPORTANT: Must match login service
    onDelete: 'CASCADE',
});
PassengerProfile.belongsTo(Account, {
    foreignKey: 'account_id',
    as: 'account',
});

// ───────────────────────────────────────────────────────────────────────
// 2️⃣ Account ↔ DriverProfile (1:1)
// ───────────────────────────────────────────────────────────────────────
Account.hasOne(DriverProfile, {
    foreignKey: 'account_id',
    as: 'driver_profile', // ✅ IMPORTANT: Must match login service
    onDelete: 'CASCADE',
});
DriverProfile.belongsTo(Account, {
    foreignKey: 'account_id',
    as: 'account',
});

// ───────────────────────────────────────────────────────────────────────
// 3️⃣ Account ↔ VerificationCode (1:N)
// ───────────────────────────────────────────────────────────────────────
Account.hasMany(VerificationCode, {
    foreignKey: 'account_uuid',
    as: 'verificationCodes',
    onDelete: 'CASCADE',
});
VerificationCode.belongsTo(Account, {
    foreignKey: 'account_uuid',
    as: 'account',
});

// ───────────────────────────────────────────────────────────────────────
// 4️⃣ Account ↔ DriverDocument (1:N)
// ───────────────────────────────────────────────────────────────────────
Account.hasMany(DriverDocument, {
    foreignKey: 'account_id',
    as: 'driverDocuments',
    onDelete: 'CASCADE',
});
DriverDocument.belongsTo(Account, {
    foreignKey: 'account_id',
    as: 'account',
});

// ───────────────────────────────────────────────────────────────────────
// 5️⃣ Account ↔ DriverLocation (1:1)
// ───────────────────────────────────────────────────────────────────────
Account.hasOne(DriverLocation, {
    foreignKey: 'driver_id',
    as: 'driverLocation',
    onDelete: 'CASCADE',
});
DriverLocation.belongsTo(Account, {
    foreignKey: 'driver_id',
    as: 'driverAccount',
});

// ───────────────────────────────────────────────────────────────────────
// 6️⃣ Account ↔ Employee (1:1)
// ───────────────────────────────────────────────────────────────────────
Account.hasOne(Employee, {
    foreignKey: 'accountId',
    as: 'employee',
    onDelete: 'CASCADE',
});
Employee.belongsTo(Account, {
    foreignKey: 'accountId',
    as: 'account',
});

// ═══════════════════════════════════════════════════════════════════════
// TRIP RELATIONSHIPS
// ═══════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────
// Trip ↔ Account (Passenger)
// ───────────────────────────────────────────────────────────────────────
Trip.belongsTo(Account, {
    foreignKey: 'passengerId',
    as: 'passenger',
    targetKey: 'uuid',
});
Account.hasMany(Trip, {
    foreignKey: 'passengerId',
    sourceKey: 'uuid',
    as: 'tripsAsPassenger',
});

// ───────────────────────────────────────────────────────────────────────
// Trip ↔ Account (Driver)
// ───────────────────────────────────────────────────────────────────────
Trip.belongsTo(Account, {
    foreignKey: 'driverId',
    as: 'driver',
    targetKey: 'uuid',
});
Account.hasMany(Trip, {
    foreignKey: 'driverId',
    sourceKey: 'uuid',
    as: 'tripsAsDriver',
});

// ───────────────────────────────────────────────────────────────────────
// Trip ↔ TripEvent (1:N)
// ───────────────────────────────────────────────────────────────────────
Trip.hasMany(TripEvent, {
    foreignKey: 'tripId',
    as: 'events',
    onDelete: 'CASCADE',
});
TripEvent.belongsTo(Trip, {
    foreignKey: 'tripId',
    as: 'trip',
});

// ───────────────────────────────────────────────────────────────────────
// Trip ↔ ChatMessage (1:N)
// ───────────────────────────────────────────────────────────────────────
Trip.hasMany(ChatMessage, {
    foreignKey: 'tripId',
    as: 'messages',
    onDelete: 'CASCADE',
});
ChatMessage.belongsTo(Trip, {
    foreignKey: 'tripId',
    as: 'trip',
});

// ───────────────────────────────────────────────────────────────────────
// Trip ↔ Payment (1:1)
// ───────────────────────────────────────────────────────────────────────
Trip.hasOne(Payment, {
    foreignKey: 'tripId',
    as: 'payment',
    onDelete: 'CASCADE',
});
Payment.belongsTo(Trip, {
    foreignKey: 'tripId',
    as: 'trip',
});

// ───────────────────────────────────────────────────────────────────────
// Trip ↔ Rating (1:N)
// ───────────────────────────────────────────────────────────────────────
Trip.hasMany(Rating, {
    foreignKey: 'tripId',
    as: 'ratings',
    onDelete: 'CASCADE',
});

// ═══════════════════════════════════════════════════════════════════════
// RATING RELATIONSHIPS
// ═══════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────
// Rating ↔ Trip
// ───────────────────────────────────────────────────────────────────────
Rating.belongsTo(Trip, {
    foreignKey: 'tripId',
    as: 'trip',
});

// ───────────────────────────────────────────────────────────────────────
// Rating ↔ Account (Rater - who gave the rating)
// ───────────────────────────────────────────────────────────────────────
Rating.belongsTo(Account, {
    foreignKey: 'ratedBy',
    as: 'rater',
    targetKey: 'uuid',
});

// ───────────────────────────────────────────────────────────────────────
// Rating ↔ Account (Rated - who received the rating)
// ───────────────────────────────────────────────────────────────────────
Rating.belongsTo(Account, {
    foreignKey: 'ratedUser',
    as: 'rated',
    targetKey: 'uuid',
});

// ───────────────────────────────────────────────────────────────────────
// Account ↔ Ratings Given (1:N)
// ───────────────────────────────────────────────────────────────────────
Account.hasMany(Rating, {
    foreignKey: 'ratedBy',
    sourceKey: 'uuid',
    as: 'ratingsGiven',
});

// ───────────────────────────────────────────────────────────────────────
// Account ↔ Ratings Received (1:N)
// ───────────────────────────────────────────────────────────────────────
Account.hasMany(Rating, {
    foreignKey: 'ratedUser',
    sourceKey: 'uuid',
    as: 'ratingsReceived',
});

// ═══════════════════════════════════════════════════════════════════════
// CHAT RELATIONSHIPS
// ═══════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────
// ChatMessage ↔ Account (Sender)
// ───────────────────────────────────────────────────────────────────────
ChatMessage.belongsTo(Account, {
    foreignKey: 'fromUserId',
    as: 'sender',
    targetKey: 'uuid',
});

// ───────────────────────────────────────────────────────────────────────
// Account ↔ ChatMessages (Sent Messages)
// ───────────────────────────────────────────────────────────────────────
Account.hasMany(ChatMessage, {
    foreignKey: 'fromUserId',
    sourceKey: 'uuid',
    as: 'sentMessages',
});

// ───────────────────────────────────────────────────────────────────────
// ChatMessage ↔ Account (Recipient)
// ───────────────────────────────────────────────────────────────────────
ChatMessage.belongsTo(Account, {
    foreignKey: 'toUserId',
    as: 'recipient',
    targetKey: 'uuid',
});

// ───────────────────────────────────────────────────────────────────────
// Account ↔ ChatMessages (Received Messages)
// ───────────────────────────────────────────────────────────────────────
Account.hasMany(ChatMessage, {
    foreignKey: 'toUserId',
    sourceKey: 'uuid',
    as: 'receivedMessages',
});

// ═══════════════════════════════════════════════════════════════════════
// VEHICLE RELATIONSHIPS
// ═══════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────
// Vehicle ↔ Account (Partner - Owner)
// ───────────────────────────────────────────────────────────────────────
Vehicle.belongsTo(Account, {
    foreignKey: 'partnerId',
    as: 'partner',
    targetKey: 'uuid',
});
Account.hasMany(Vehicle, {
    foreignKey: 'partnerId',
    sourceKey: 'uuid',
    as: 'ownedVehicles',
});

// ───────────────────────────────────────────────────────────────────────
// Vehicle ↔ Account (Employee - Posted By)
// ───────────────────────────────────────────────────────────────────────
Vehicle.belongsTo(Account, {
    foreignKey: 'postedByEmployeeId',
    as: 'postedByEmployee',
    targetKey: 'uuid',
});
Account.hasMany(Vehicle, {
    foreignKey: 'postedByEmployeeId',
    sourceKey: 'uuid',
    as: 'postedVehicles',
});

// ───────────────────────────────────────────────────────────────────────
// Vehicle ↔ VehicleCategory
// ───────────────────────────────────────────────────────────────────────
Vehicle.belongsTo(VehicleCategory, {
    foreignKey: 'categoryId',
    as: 'category',
});
VehicleCategory.hasMany(Vehicle, {
    foreignKey: 'categoryId',
    as: 'vehicles',
});

// ───────────────────────────────────────────────────────────────────────
// Vehicle ↔ Driver (Legacy - if using Driver model)
// ───────────────────────────────────────────────────────────────────────
if (Driver) {
    Driver.belongsTo(Vehicle, {
        foreignKey: 'vehicleId',
        as: 'vehicle',
    });
    Vehicle.hasMany(Driver, {
        foreignKey: 'vehicleId',
        as: 'drivers',
    });
}

// ═══════════════════════════════════════════════════════════════════════
// RENTAL RELATIONSHIPS
// ═══════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────
// VehicleRental ↔ Account (User/Passenger)
// ───────────────────────────────────────────────────────────────────────
VehicleRental.belongsTo(Account, {
    foreignKey: 'userId',
    as: 'user',
    targetKey: 'uuid',
});
Account.hasMany(VehicleRental, {
    foreignKey: 'userId',
    sourceKey: 'uuid',
    as: 'rentals',
});

// ───────────────────────────────────────────────────────────────────────
// VehicleRental ↔ Vehicle
// ───────────────────────────────────────────────────────────────────────
VehicleRental.belongsTo(Vehicle, {
    foreignKey: 'vehicleId',
    as: 'vehicle',
});
Vehicle.hasMany(VehicleRental, {
    foreignKey: 'vehicleId',
    as: 'rentals',
});

// ───────────────────────────────────────────────────────────────────────
// VehicleRental ↔ Account (Employee - Handled By)
// ───────────────────────────────────────────────────────────────────────
VehicleRental.belongsTo(Account, {
    foreignKey: 'handledByEmployeeId',
    as: 'handledByEmployee',
    targetKey: 'uuid',
});
Account.hasMany(VehicleRental, {
    foreignKey: 'handledByEmployeeId',
    sourceKey: 'uuid',
    as: 'handledRentals',
});

// ───────────────────────────────────────────────────────────────────────
// VehicleRental ↔ Account (Admin - Approved By)
// ───────────────────────────────────────────────────────────────────────
VehicleRental.belongsTo(Account, {
    foreignKey: 'approvedByAdminId',
    as: 'approvedByAdmin',
    targetKey: 'uuid',
});
Account.hasMany(VehicleRental, {
    foreignKey: 'approvedByAdminId',
    sourceKey: 'uuid',
    as: 'approvedRentals',
});

// ═══════════════════════════════════════════════════════════════════════
// PAYMENT RELATIONSHIPS
// ═══════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────
// Payment ↔ Account (Passenger)
// ───────────────────────────────────────────────────────────────────────
Payment.belongsTo(Account, {
    foreignKey: 'passengerId',
    as: 'passenger',
    targetKey: 'uuid',
});
Account.hasMany(Payment, {
    foreignKey: 'passengerId',
    sourceKey: 'uuid',
    as: 'paymentsAsPassenger',
});

// ───────────────────────────────────────────────────────────────────────
// Payment ↔ Account (Driver)
// ───────────────────────────────────────────────────────────────────────
Payment.belongsTo(Account, {
    foreignKey: 'driverId',
    as: 'driver',
    targetKey: 'uuid',
});
Account.hasMany(Payment, {
    foreignKey: 'driverId',
    sourceKey: 'uuid',
    as: 'paymentsAsDriver',
});

// ═══════════════════════════════════════════════════════════════════════
// EXPORT ALL MODELS & SEQUELIZE INSTANCE
// ═══════════════════════════════════════════════════════════════════════

module.exports = {
    // Database instance
    sequelize,

    // Core models
    Account,
    PassengerProfile,
    DriverProfile,
    VerificationCode,
    DriverDocument,
    Employee,

    // Trip-related models
    Trip,
    TripEvent,
    Rating,
    Payment,

    // Communication models
    ChatMessage,

    // Vehicle-related models
    Vehicle,
    VehicleCategory,
    VehicleRental,

    // Legacy/Additional models
    Driver,
    DriverLocation,
    PriceRule,
    IdempotencyKey,
};