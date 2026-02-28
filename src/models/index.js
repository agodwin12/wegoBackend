// backend/src/models/index.js

const sequelize = require('../config/database');

// ═══════════════════════════════════════════════════════════════════════
// MODEL IMPORTS — CORE
// ═══════════════════════════════════════════════════════════════════════

const Account          = require('./Account');
const PassengerProfile = require('./PassengerProfile');
const DriverProfile    = require('./DriverProfile');
const VerificationCode = require('./VerificationCode');
const DriverDocument   = require('./DriverDocument');
const Trip             = require('./Trip');
const TripEvent        = require('./TripEvent');
const ChatMessage      = require('./ChatMessage');
const Rating           = require('./Rating');
const Payment          = require('./Payment');
const Driver           = require('./Driver');
const Vehicle          = require('./Vehicle');
const PriceRule        = require('./PriceRule');
const IdempotencyKey   = require('./IdempotencyKey');
const VehicleRental    = require('./VehicleRental');
const VehicleCategory  = require('./VehicleCategory');
const DriverLocation   = require('./DriverLocation');
const Employee         = require('./Employee')(sequelize);
const Coupon           = require('./Coupon');
const SupportTicket    = require('./SupportTicket');
const PartnerProfile   = require('./PartnerProfile');
const PendingSignup    = require('./PendingSignup');

// ═══════════════════════════════════════════════════════════════════════
// MODEL IMPORTS — AUTHENTICATION
// ═══════════════════════════════════════════════════════════════════════

const RefreshToken = require('./RefreshToken')(sequelize, require('sequelize').DataTypes);

// ═══════════════════════════════════════════════════════════════════════
// MODEL IMPORTS — SERVICES MARKETPLACE
// ═══════════════════════════════════════════════════════════════════════

const ServiceCategory = require('./ServiceCategory');
const ServiceListing  = require('./ServiceListing');
const ServiceRequest  = require('./ServiceRequest');
const ServiceRating   = require('./ServiceRating');
const ServiceDispute  = require('./ServiceDispute');

// ═══════════════════════════════════════════════════════════════════════
// MODEL IMPORTS — EARNINGS ENGINE  ✅ NEW
// ═══════════════════════════════════════════════════════════════════════

const TripReceipt            = require('./TripReceipt');
const DriverWallet           = require('./DriverWallet');
const DriverWalletTransaction = require('./DriverWalletTransaction');
const EarningRule            = require('./EarningRule');
const { BonusProgram, BonusAward } = require('./BonusProgramAndAward');

// ═══════════════════════════════════════════════════════════════════════
// ASSOCIATIONS — ACCOUNT
// ═══════════════════════════════════════════════════════════════════════

// SupportTicket ↔ Account (User)
SupportTicket.belongsTo(Account, { foreignKey: 'user_id',    targetKey: 'uuid', as: 'user' });
Account.hasMany(SupportTicket,   { foreignKey: 'user_id',    sourceKey: 'uuid', as: 'supportTickets' });

// SupportTicket ↔ Employee (Assigned Agent)
SupportTicket.belongsTo(Employee, { foreignKey: 'assigned_to', as: 'employee' });
Employee.hasMany(SupportTicket,   { foreignKey: 'assigned_to', as: 'assignedTickets' });

// 1️⃣ Account ↔ PassengerProfile (1:1)
Account.hasOne(PassengerProfile,        { foreignKey: 'account_id', as: 'passenger_profile', onDelete: 'CASCADE' });
PassengerProfile.belongsTo(Account,     { foreignKey: 'account_id', as: 'account' });

// 2️⃣ Account ↔ DriverProfile (1:1)
Account.hasOne(DriverProfile,           { foreignKey: 'account_id', as: 'driver_profile', onDelete: 'CASCADE' });
DriverProfile.belongsTo(Account,        { foreignKey: 'account_id', as: 'account' });

// 3️⃣ Account ↔ VerificationCode (1:N)
Account.hasMany(VerificationCode,       { foreignKey: 'account_uuid', as: 'verificationCodes', onDelete: 'CASCADE' });
VerificationCode.belongsTo(Account,     { foreignKey: 'account_uuid', as: 'account' });

// 4️⃣ Account ↔ DriverDocument (1:N)
Account.hasMany(DriverDocument,         { foreignKey: 'account_id', as: 'driverDocuments', onDelete: 'CASCADE' });
DriverDocument.belongsTo(Account,       { foreignKey: 'account_id', as: 'account' });

// 5️⃣ Account ↔ DriverLocation (1:1)
Account.hasOne(DriverLocation,          { foreignKey: 'driver_id', as: 'driverLocation', onDelete: 'CASCADE' });
DriverLocation.belongsTo(Account,       { foreignKey: 'driver_id', as: 'driverAccount' });

// 6️⃣ Account ↔ Employee (1:1)
Account.hasOne(Employee,                { foreignKey: 'accountId', as: 'employee', onDelete: 'CASCADE' });
Employee.belongsTo(Account,             { foreignKey: 'accountId', as: 'account' });

// 7️⃣ Account ↔ PartnerProfile (1:1)
Account.hasOne(PartnerProfile,          { foreignKey: 'accountId', sourceKey: 'uuid', as: 'partner_profile', onDelete: 'CASCADE' });
PartnerProfile.belongsTo(Account,       { foreignKey: 'accountId', targetKey: 'uuid', as: 'account' });

// 8️⃣ Account ↔ RefreshToken (1:N)
Account.hasMany(RefreshToken,           { foreignKey: 'account_uuid', sourceKey: 'uuid', as: 'refresh_tokens', onDelete: 'CASCADE' });
RefreshToken.belongsTo(Account,         { foreignKey: 'account_uuid', targetKey: 'uuid', as: 'account' });

// ═══════════════════════════════════════════════════════════════════════
// ASSOCIATIONS — EMPLOYEE
// ═══════════════════════════════════════════════════════════════════════

Employee.belongsTo(Employee, { foreignKey: 'created_by', as: 'creator' });
Employee.hasMany(Employee,   { foreignKey: 'created_by', as: 'createdEmployees' });

Employee.hasMany(PriceRule,  { foreignKey: 'created_by', as: 'createdPriceRules' });
PriceRule.belongsTo(Employee,{ foreignKey: 'created_by', as: 'creator' });

Employee.hasMany(PriceRule,  { foreignKey: 'updated_by', as: 'updatedPriceRules' });
PriceRule.belongsTo(Employee,{ foreignKey: 'updated_by', as: 'updater' });

Employee.hasMany(Coupon,     { foreignKey: 'created_by', as: 'createdCoupons' });
Coupon.belongsTo(Employee,   { foreignKey: 'created_by', as: 'creator' });

// ═══════════════════════════════════════════════════════════════════════
// ASSOCIATIONS — PARTNER PROFILE
// ═══════════════════════════════════════════════════════════════════════

PartnerProfile.belongsTo(Employee, { foreignKey: 'createdByEmployeeId', as: 'createdByEmployee', onDelete: 'SET NULL' });
Employee.hasMany(PartnerProfile,   { foreignKey: 'createdByEmployeeId', as: 'createdPartners' });

PartnerProfile.belongsTo(Employee, { foreignKey: 'blockedBy', as: 'blockedByEmployee', onDelete: 'SET NULL' });
Employee.hasMany(PartnerProfile,   { foreignKey: 'blockedBy', as: 'blockedPartners' });

PartnerProfile.hasMany(Vehicle,    { foreignKey: 'partnerId', sourceKey: 'accountId', as: 'vehicles', onDelete: 'RESTRICT' });
Vehicle.belongsTo(PartnerProfile,  { foreignKey: 'partnerId', targetKey: 'accountId', as: 'partnerProfile' });

// ═══════════════════════════════════════════════════════════════════════
// ASSOCIATIONS — TRIP
// ═══════════════════════════════════════════════════════════════════════

Trip.belongsTo(Account, { foreignKey: 'passengerId', as: 'passenger', targetKey: 'uuid' });
Account.hasMany(Trip,   { foreignKey: 'passengerId', sourceKey: 'uuid', as: 'tripsAsPassenger' });

Trip.belongsTo(Account, { foreignKey: 'driverId', as: 'driver', targetKey: 'uuid' });
Account.hasMany(Trip,   { foreignKey: 'driverId', sourceKey: 'uuid', as: 'tripsAsDriver' });

Trip.hasMany(TripEvent,   { foreignKey: 'tripId', as: 'events',   onDelete: 'CASCADE' });
TripEvent.belongsTo(Trip, { foreignKey: 'tripId', as: 'trip' });

Trip.hasMany(ChatMessage,   { foreignKey: 'tripId', as: 'messages', onDelete: 'CASCADE' });
ChatMessage.belongsTo(Trip, { foreignKey: 'tripId', as: 'trip' });

Trip.hasOne(Payment,      { foreignKey: 'tripId', as: 'payment',  onDelete: 'CASCADE' });
Payment.belongsTo(Trip,   { foreignKey: 'tripId', as: 'trip' });

Trip.hasMany(Rating, { foreignKey: 'trip_id', as: 'ratings', onDelete: 'CASCADE' });

// ── Trip ↔ TripReceipt (1:1) ✅ NEW ───────────────────────────────────
Trip.hasOne(TripReceipt,       { foreignKey: 'tripId', as: 'receipt', onDelete: 'RESTRICT' });
TripReceipt.belongsTo(Trip,    { foreignKey: 'tripId', as: 'trip' });

// ═══════════════════════════════════════════════════════════════════════
// ASSOCIATIONS — RATING
// ═══════════════════════════════════════════════════════════════════════

Rating.belongsTo(Trip,    { foreignKey: 'trip_id',   as: 'trip' });
Rating.belongsTo(Account, { foreignKey: 'rated_by',  as: 'rater',  targetKey: 'uuid' });
Account.hasMany(Rating,   { foreignKey: 'rated_by',  sourceKey: 'uuid', as: 'ratingsGiven' });
Rating.belongsTo(Account, { foreignKey: 'rated_user',as: 'rated',  targetKey: 'uuid' });
Account.hasMany(Rating,   { foreignKey: 'rated_user',sourceKey: 'uuid', as: 'ratingsReceived' });

// ═══════════════════════════════════════════════════════════════════════
// ASSOCIATIONS — CHAT
// ═══════════════════════════════════════════════════════════════════════

ChatMessage.belongsTo(Account, { foreignKey: 'fromUserId', as: 'sender',    targetKey: 'uuid' });
Account.hasMany(ChatMessage,   { foreignKey: 'fromUserId', sourceKey: 'uuid', as: 'sentMessages' });

ChatMessage.belongsTo(Account, { foreignKey: 'toUserId',   as: 'recipient', targetKey: 'uuid' });
Account.hasMany(ChatMessage,   { foreignKey: 'toUserId',   sourceKey: 'uuid', as: 'receivedMessages' });

// ═══════════════════════════════════════════════════════════════════════
// ASSOCIATIONS — VEHICLE
// ═══════════════════════════════════════════════════════════════════════

Vehicle.belongsTo(Account,       { foreignKey: 'partnerId',  as: 'partner',   targetKey: 'uuid' });
Account.hasMany(Vehicle,         { foreignKey: 'partnerId',  sourceKey: 'uuid', as: 'ownedVehicles' });

Vehicle.belongsTo(VehicleCategory,  { foreignKey: 'categoryId', as: 'category' });
VehicleCategory.hasMany(Vehicle,    { foreignKey: 'categoryId', as: 'vehicles' });

if (Driver) {
    Driver.belongsTo(Vehicle, { foreignKey: 'vehicleId', as: 'vehicle' });
    Vehicle.hasMany(Driver,   { foreignKey: 'vehicleId', as: 'drivers' });
}

// ═══════════════════════════════════════════════════════════════════════
// ASSOCIATIONS — VEHICLE RENTAL
// ═══════════════════════════════════════════════════════════════════════

VehicleRental.belongsTo(Account,  { foreignKey: 'userId',               as: 'user',              targetKey: 'uuid' });
Account.hasMany(VehicleRental,    { foreignKey: 'userId',               sourceKey: 'uuid',        as: 'rentals' });

VehicleRental.belongsTo(Vehicle,  { foreignKey: 'vehicleId',            as: 'vehicle' });
Vehicle.hasMany(VehicleRental,    { foreignKey: 'vehicleId',            as: 'rentals' });

VehicleRental.belongsTo(Account,  { foreignKey: 'handledByEmployeeId',  as: 'handledByEmployee', targetKey: 'uuid' });
Account.hasMany(VehicleRental,    { foreignKey: 'handledByEmployeeId',  sourceKey: 'uuid',        as: 'handledRentals' });

VehicleRental.belongsTo(Account,  { foreignKey: 'approvedByAdminId',    as: 'approvedByAdmin',   targetKey: 'uuid' });
Account.hasMany(VehicleRental,    { foreignKey: 'approvedByAdminId',    sourceKey: 'uuid',        as: 'approvedRentals' });

// ═══════════════════════════════════════════════════════════════════════
// ASSOCIATIONS — PAYMENT
// ═══════════════════════════════════════════════════════════════════════

Payment.belongsTo(Account, { foreignKey: 'passengerId', as: 'passenger', targetKey: 'uuid' });
Account.hasMany(Payment,   { foreignKey: 'passengerId', sourceKey: 'uuid', as: 'paymentsAsPassenger' });

Payment.belongsTo(Account, { foreignKey: 'driverId',    as: 'driver',    targetKey: 'uuid' });
Account.hasMany(Payment,   { foreignKey: 'driverId',    sourceKey: 'uuid', as: 'paymentsAsDriver' });

Vehicle.belongsTo(Employee, { foreignKey: 'postedByEmployeeId',   as: 'postedByEmployee' });
Employee.hasMany(Vehicle,   { foreignKey: 'postedByEmployeeId',   as: 'postedVehicles' });

Vehicle.belongsTo(Employee, { foreignKey: 'verifiedByEmployeeId', as: 'verifiedByEmployee' });
Employee.hasMany(Vehicle,   { foreignKey: 'verifiedByEmployeeId', as: 'verifiedVehicles' });

// ═══════════════════════════════════════════════════════════════════════
// ASSOCIATIONS — SERVICES MARKETPLACE
// ═══════════════════════════════════════════════════════════════════════

ServiceCategory.hasMany(ServiceCategory,  { foreignKey: 'parent_id', as: 'subcategories' });
ServiceCategory.belongsTo(ServiceCategory,{ foreignKey: 'parent_id', as: 'parent' });

ServiceCategory.belongsTo(Employee, { foreignKey: 'created_by', as: 'creator' });
Employee.hasMany(ServiceCategory,   { foreignKey: 'created_by', as: 'createdServiceCategories' });

ServiceCategory.belongsTo(Employee, { foreignKey: 'updated_by', as: 'updater' });
Employee.hasMany(ServiceCategory,   { foreignKey: 'updated_by', as: 'updatedServiceCategories' });

ServiceCategory.hasMany(ServiceListing,  { foreignKey: 'category_id', as: 'listings' });
ServiceListing.belongsTo(ServiceCategory,{ foreignKey: 'category_id', as: 'category' });

ServiceListing.belongsTo(Account, { foreignKey: 'provider_id', targetKey: 'uuid', as: 'provider' });
Account.hasMany(ServiceListing,   { foreignKey: 'provider_id', sourceKey: 'uuid', as: 'serviceListings' });

ServiceListing.belongsTo(Employee, { foreignKey: 'approved_by', as: 'approver' });
Employee.hasMany(ServiceListing,   { foreignKey: 'approved_by', as: 'approvedServiceListings' });

ServiceListing.belongsTo(Employee, { foreignKey: 'rejected_by', as: 'rejecter' });
Employee.hasMany(ServiceListing,   { foreignKey: 'rejected_by', as: 'rejectedServiceListings' });

ServiceListing.hasMany(ServiceRequest,  { foreignKey: 'listing_id', as: 'requests' });
ServiceRequest.belongsTo(ServiceListing,{ foreignKey: 'listing_id', as: 'listing' });

ServiceRequest.belongsTo(Account, { foreignKey: 'provider_id', targetKey: 'uuid', as: 'provider' });
Account.hasMany(ServiceRequest,   { foreignKey: 'provider_id', sourceKey: 'uuid', as: 'serviceRequestsAsProvider' });

ServiceRequest.belongsTo(Account, { foreignKey: 'customer_id', targetKey: 'uuid', as: 'customer' });
Account.hasMany(ServiceRequest,   { foreignKey: 'customer_id', sourceKey: 'uuid', as: 'serviceRequestsAsCustomer' });

ServiceRequest.belongsTo(Account, { foreignKey: 'cancelled_by', targetKey: 'uuid', as: 'canceller' });

ServiceRequest.hasOne(ServiceRating,  { foreignKey: 'request_id', as: 'rating' });
ServiceRating.belongsTo(ServiceRequest,{ foreignKey: 'request_id', as: 'request' });

ServiceRating.belongsTo(Account, { foreignKey: 'provider_id', targetKey: 'uuid', as: 'provider' });
Account.hasMany(ServiceRating,   { foreignKey: 'provider_id', sourceKey: 'uuid', as: 'serviceRatingsReceived' });

ServiceRating.belongsTo(Account, { foreignKey: 'customer_id', targetKey: 'uuid', as: 'customer' });
Account.hasMany(ServiceRating,   { foreignKey: 'customer_id', sourceKey: 'uuid', as: 'serviceRatingsGiven' });

ServiceRating.belongsTo(ServiceListing,  { foreignKey: 'listing_id', as: 'listing' });
ServiceListing.hasMany(ServiceRating,    { foreignKey: 'listing_id', as: 'ratings' });

ServiceRating.belongsTo(Employee, { foreignKey: 'moderated_by', as: 'moderator' });
Employee.hasMany(ServiceRating,   { foreignKey: 'moderated_by', as: 'moderatedServiceRatings' });

ServiceDispute.belongsTo(ServiceRequest, { foreignKey: 'request_id', as: 'request' });
ServiceRequest.hasMany(ServiceDispute,   { foreignKey: 'request_id', as: 'disputes' });

ServiceDispute.belongsTo(Account, { foreignKey: 'filed_by',     targetKey: 'uuid', as: 'filer' });
Account.hasMany(ServiceDispute,   { foreignKey: 'filed_by',     sourceKey: 'uuid', as: 'serviceDisputesFiled' });

ServiceDispute.belongsTo(Account, { foreignKey: 'against_user', targetKey: 'uuid', as: 'defendant' });
Account.hasMany(ServiceDispute,   { foreignKey: 'against_user', sourceKey: 'uuid', as: 'serviceDisputesAgainst' });

ServiceDispute.belongsTo(Employee, { foreignKey: 'assigned_to', as: 'assignedEmployee' });
Employee.hasMany(ServiceDispute,   { foreignKey: 'assigned_to', as: 'assignedServiceDisputes' });

ServiceDispute.belongsTo(Employee, { foreignKey: 'resolved_by', as: 'resolver' });
Employee.hasMany(ServiceDispute,   { foreignKey: 'resolved_by', as: 'resolvedServiceDisputes' });

// ═══════════════════════════════════════════════════════════════════════
// ASSOCIATIONS — EARNINGS ENGINE  ✅ NEW
// ═══════════════════════════════════════════════════════════════════════

// ── DriverWallet ↔ Account (1:1) ──────────────────────────────────────
Account.hasOne(DriverWallet,     { foreignKey: 'driverId', sourceKey: 'uuid', as: 'wallet', onDelete: 'RESTRICT' });
DriverWallet.belongsTo(Account,  { foreignKey: 'driverId', targetKey: 'uuid', as: 'driver' });

// ── DriverWallet ↔ Employee (frozen by) ───────────────────────────────
DriverWallet.belongsTo(Employee, { foreignKey: 'frozenBy', as: 'frozenByEmployee' });
Employee.hasMany(DriverWallet,   { foreignKey: 'frozenBy', as: 'frozenWallets' });

// ── DriverWalletTransaction ↔ DriverWallet (1:N) ─────────────────────
DriverWallet.hasMany(DriverWalletTransaction,        { foreignKey: 'walletId', as: 'transactions', onDelete: 'RESTRICT' });
DriverWalletTransaction.belongsTo(DriverWallet,      { foreignKey: 'walletId', as: 'wallet' });

// ── DriverWalletTransaction ↔ Account (driver) ────────────────────────
Account.hasMany(DriverWalletTransaction,             { foreignKey: 'driverId', sourceKey: 'uuid', as: 'walletTransactions' });
DriverWalletTransaction.belongsTo(Account,           { foreignKey: 'driverId', targetKey: 'uuid', as: 'driver' });

// ── DriverWalletTransaction ↔ Trip ────────────────────────────────────
Trip.hasMany(DriverWalletTransaction,                { foreignKey: 'tripId', as: 'walletEntries' });
DriverWalletTransaction.belongsTo(Trip,              { foreignKey: 'tripId', as: 'trip' });

// ── DriverWalletTransaction ↔ TripReceipt ─────────────────────────────
TripReceipt.hasMany(DriverWalletTransaction,         { foreignKey: 'receiptId', as: 'walletEntries' });
DriverWalletTransaction.belongsTo(TripReceipt,       { foreignKey: 'receiptId', as: 'receipt' });

// ── DriverWalletTransaction ↔ EarningRule ─────────────────────────────
EarningRule.hasMany(DriverWalletTransaction,         { foreignKey: 'ruleId', as: 'walletEntries' });
DriverWalletTransaction.belongsTo(EarningRule,       { foreignKey: 'ruleId', as: 'rule' });

// ── DriverWalletTransaction ↔ BonusProgram ────────────────────────────
BonusProgram.hasMany(DriverWalletTransaction,        { foreignKey: 'bonusProgramId', as: 'walletEntries' });
DriverWalletTransaction.belongsTo(BonusProgram,      { foreignKey: 'bonusProgramId', as: 'bonusProgram' });

// ── DriverWalletTransaction ↔ BonusAward ──────────────────────────────
BonusAward.hasOne(DriverWalletTransaction,           { foreignKey: 'bonusAwardId', as: 'walletEntry' });
DriverWalletTransaction.belongsTo(BonusAward,        { foreignKey: 'bonusAwardId', as: 'bonusAward' });

// ── DriverWalletTransaction ↔ Employee (adjustedBy) ───────────────────
Employee.hasMany(DriverWalletTransaction,            { foreignKey: 'adjustedBy', as: 'manualAdjustments' });
DriverWalletTransaction.belongsTo(Employee,          { foreignKey: 'adjustedBy', as: 'adjustedByEmployee' });

// ── TripReceipt ↔ Account (driver) ────────────────────────────────────
Account.hasMany(TripReceipt,                         { foreignKey: 'driverId', sourceKey: 'uuid', as: 'tripReceipts' });
TripReceipt.belongsTo(Account,                       { foreignKey: 'driverId', targetKey: 'uuid', as: 'driver' });

// ── TripReceipt ↔ Account (passenger) ────────────────────────────────
TripReceipt.belongsTo(Account,                       { foreignKey: 'passengerId', targetKey: 'uuid', as: 'passenger' });

// ── TripReceipt ↔ EarningRule (commission rule used) ─────────────────
EarningRule.hasMany(TripReceipt,                     { foreignKey: 'commissionRuleId', as: 'receipts' });
TripReceipt.belongsTo(EarningRule,                   { foreignKey: 'commissionRuleId', as: 'commissionRule' });

// ── EarningRule ↔ Employee (audit) ────────────────────────────────────
Employee.hasMany(EarningRule, { foreignKey: 'createdBy', as: 'createdEarningRules' });
EarningRule.belongsTo(Employee, { foreignKey: 'createdBy', as: 'creator' });

Employee.hasMany(EarningRule, { foreignKey: 'updatedBy', as: 'updatedEarningRules' });
EarningRule.belongsTo(Employee, { foreignKey: 'updatedBy', as: 'updater' });

// ── BonusProgram ↔ Employee (audit) ───────────────────────────────────
Employee.hasMany(BonusProgram, { foreignKey: 'createdBy', as: 'createdBonusPrograms' });
BonusProgram.belongsTo(Employee, { foreignKey: 'createdBy', as: 'creator' });

Employee.hasMany(BonusProgram, { foreignKey: 'updatedBy', as: 'updatedBonusPrograms' });
BonusProgram.belongsTo(Employee, { foreignKey: 'updatedBy', as: 'updater' });

// ── BonusAward ↔ Account (driver) ─────────────────────────────────────
Account.hasMany(BonusAward,    { foreignKey: 'driverId', sourceKey: 'uuid', as: 'bonusAwards' });
BonusAward.belongsTo(Account,  { foreignKey: 'driverId', targetKey: 'uuid', as: 'driver' });

// ── BonusAward ↔ Trip (which trip triggered the award) ────────────────
Trip.hasMany(BonusAward,       { foreignKey: 'triggerTripId', as: 'triggeredAwards' });
BonusAward.belongsTo(Trip,     { foreignKey: 'triggerTripId', as: 'triggerTrip' });

// NOTE: BonusProgram ↔ BonusAward (1:N) is already defined inside
// BonusProgramAndAward.js via BonusProgram.hasMany(BonusAward) —
// no need to repeat it here.

// ═══════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════

module.exports = {
    // ── Database instance ─────────────────────────────────────────────
    sequelize,

    // ── Core account models ───────────────────────────────────────────
    Account,
    PendingSignup,
    PassengerProfile,
    DriverProfile,
    VerificationCode,
    DriverDocument,
    Employee,
    Coupon,
    PartnerProfile,

    // ── Authentication ────────────────────────────────────────────────
    RefreshToken,

    // ── Trip models ───────────────────────────────────────────────────
    Trip,
    TripEvent,
    Rating,
    Payment,

    // ── Communication ─────────────────────────────────────────────────
    ChatMessage,

    // ── Vehicle models ────────────────────────────────────────────────
    Vehicle,
    VehicleCategory,
    VehicleRental,

    // ── Pricing ───────────────────────────────────────────────────────
    PriceRule,
    SupportTicket,

    // ── Services Marketplace ──────────────────────────────────────────
    ServiceCategory,
    ServiceListing,
    ServiceRequest,
    ServiceRating,
    ServiceDispute,

    // ── Legacy / Additional ───────────────────────────────────────────
    Driver,
    DriverLocation,
    IdempotencyKey,

    // ── Earnings Engine ✅ NEW ────────────────────────────────────────
    TripReceipt,
    DriverWallet,
    DriverWalletTransaction,
    EarningRule,
    BonusProgram,
    BonusAward,
};