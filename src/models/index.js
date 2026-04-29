// src/models/index.js
'use strict';

const sequelize = require('../config/database');

// ═══════════════════════════════════════════════════════════════════════════════
// MODEL IMPORTS — CORE ACCOUNT
// ═══════════════════════════════════════════════════════════════════════════════

const Account          = require('./Account');
const PassengerProfile = require('./PassengerProfile');
const DriverProfile    = require('./DriverProfile');
const VerificationCode = require('./VerificationCode');
const DriverDocument   = require('./DriverDocument');
const PendingSignup    = require('./PendingSignup');
const PartnerProfile   = require('./PartnerProfile');
const Coupon           = require('./Coupon');
const SupportTicket    = require('./SupportTicket');

// ─── Factory-pattern models (called before any associations) ──────────────────
const Employee     = require('./Employee')(sequelize);
const RefreshToken = require('./RefreshToken')(sequelize);

// ═══════════════════════════════════════════════════════════════════════════════
// MODEL IMPORTS — TRIP / RIDE
// ═══════════════════════════════════════════════════════════════════════════════

const Trip        = require('./Trip');
const TripEvent   = require('./TripEvent');
const ChatMessage = require('./ChatMessage');
const Rating      = require('./Rating');
const Payment     = require('./Payment');

// ═══════════════════════════════════════════════════════════════════════════════
// MODEL IMPORTS — DRIVER / VEHICLE
// ═══════════════════════════════════════════════════════════════════════════════

const Driver          = require('./Driver');
const Vehicle         = require('./Vehicle');
const VehicleCategory = require('./VehicleCategory');
const VehicleRental   = require('./VehicleRental');
const DriverLocation  = require('./DriverLocation');

// ═══════════════════════════════════════════════════════════════════════════════
// MODEL IMPORTS — PRICING / MISC
// ═══════════════════════════════════════════════════════════════════════════════

const PriceRule      = require('./PriceRule');
const IdempotencyKey = require('./IdempotencyKey');

// ═══════════════════════════════════════════════════════════════════════════════
// MODEL IMPORTS — SERVICES MARKETPLACE
// ═══════════════════════════════════════════════════════════════════════════════

const ServiceCategory = require('./ServiceCategory');
const ServiceListing  = require('./ServiceListing');
const ServiceRequest  = require('./ServiceRequest');
const ServiceRating   = require('./ServiceRating');
const ServiceDispute  = require('./ServiceDispute');

// ═══════════════════════════════════════════════════════════════════════════════
// MODEL IMPORTS — EARNINGS ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

const TripReceipt             = require('./TripReceipt');
const DriverWallet            = require('./DriverWallet');
const DriverWalletTransaction = require('./DriverWalletTransaction');
const EarningRule             = require('./EarningRule');
const { BonusProgram, BonusAward } = require('./BonusProgramAndAward');

// ═══════════════════════════════════════════════════════════════════════════════
// MODEL IMPORTS — PAYOUT SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

const DailyBalanceSheet = require('./DailyBalanceSheet');
const PayoutRequest     = require('./PayoutRequest');
const DebtPayment       = require('./DebtPayment');

// ═══════════════════════════════════════════════════════════════════════════════
// MODEL IMPORTS — DELIVERY
// ═══════════════════════════════════════════════════════════════════════════════

const DeliveryPricing           = require('./DeliveryPricing')(sequelize);
const DeliverySurgeRule         = require('./DeliverySurgeRule')(sequelize);
const Delivery                  = require('./Delivery')(sequelize);
const DeliveryTracking          = require('./DeliveryTracking')(sequelize);
const DeliveryDispute           = require('./DeliveryDispute')(sequelize);
const DeliveryCategory          = require('./DeliveryCategory')(sequelize);
const DeliveryWallet            = require('./DeliveryWallet')(sequelize);
const DeliveryWalletTransaction = require('./DeliveryWalletTransaction')(sequelize);
const DeliveryPayoutRequest     = require('./DeliveryPayoutRequest')(sequelize);
const DeliveryWalletTopUp       = require('./DeliveryWalletTopUp')(sequelize);

// ═══════════════════════════════════════════════════════════════════════════════
// VALIDATION — catch undefined models BEFORE associations run
// If any model is undefined here, it means its require() failed silently due
// to a circular dependency. The log below will identify the exact culprit.
// ═══════════════════════════════════════════════════════════════════════════════

const _allModels = {
    Account, PassengerProfile, DriverProfile, VerificationCode, DriverDocument,
    PendingSignup, PartnerProfile, Coupon, SupportTicket, Employee, RefreshToken,
    Trip, TripEvent, ChatMessage, Rating, Payment,
    Driver, Vehicle, VehicleCategory, VehicleRental, DriverLocation,
    PriceRule, IdempotencyKey,
    ServiceCategory, ServiceListing, ServiceRequest, ServiceRating, ServiceDispute,
    TripReceipt, DriverWallet, DriverWalletTransaction, EarningRule, BonusProgram, BonusAward,
    DailyBalanceSheet, PayoutRequest, DebtPayment,
    DeliveryPricing, DeliverySurgeRule, Delivery, DeliveryTracking, DeliveryDispute,
    DeliveryCategory, DeliveryWallet, DeliveryWalletTransaction, DeliveryPayoutRequest,
    DeliveryWalletTopUp,
};

const _broken = Object.entries(_allModels)
    .filter(([, v]) => !v || typeof v.findAll !== 'function')
    .map(([k]) => k);

if (_broken.length > 0) {
    throw new Error(
        `[models/index.js] The following models are undefined or not valid Sequelize models.\n` +
        `This is caused by a circular require() — one of these model files requires models/index.js\n` +
        `(directly or indirectly) at the TOP LEVEL, before index.js finishes loading.\n\n` +
        `Broken models: ${_broken.join(', ')}\n\n` +
        `Fix: remove any top-level require('../models') or require('./index') calls\n` +
        `from those model files. Use lazy requires inside function bodies if needed.`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ASSOCIATIONS — ACCOUNT
// ═══════════════════════════════════════════════════════════════════════════════

SupportTicket.belongsTo(Account,  { foreignKey: 'user_id',    targetKey: 'uuid', as: 'user' });
Account.hasMany(SupportTicket,    { foreignKey: 'user_id',    sourceKey: 'uuid', as: 'supportTickets' });

SupportTicket.belongsTo(Employee, { foreignKey: 'assigned_to', as: 'employee' });
Employee.hasMany(SupportTicket,   { foreignKey: 'assigned_to', as: 'assignedTickets' });

Account.hasOne(PassengerProfile,    { foreignKey: 'account_id', as: 'passenger_profile', onDelete: 'CASCADE' });
PassengerProfile.belongsTo(Account, { foreignKey: 'account_id', as: 'account' });

Account.hasOne(DriverProfile,    { foreignKey: 'account_id', as: 'driver_profile', onDelete: 'CASCADE' });
DriverProfile.belongsTo(Account, { foreignKey: 'account_id', as: 'account' });

Account.hasMany(VerificationCode,   { foreignKey: 'account_uuid', as: 'verificationCodes', onDelete: 'CASCADE' });
VerificationCode.belongsTo(Account, { foreignKey: 'account_uuid', as: 'account' });

Account.hasMany(DriverDocument,   { foreignKey: 'account_id', as: 'driverDocuments', onDelete: 'CASCADE' });
DriverDocument.belongsTo(Account, { foreignKey: 'account_id', as: 'account' });

Account.hasOne(DriverLocation,    { foreignKey: 'driver_id', as: 'driverLocation', onDelete: 'CASCADE' });
DriverLocation.belongsTo(Account, { foreignKey: 'driver_id', as: 'driverAccount' });

Account.hasOne(Employee,    { foreignKey: 'accountId', as: 'employee', onDelete: 'CASCADE' });
Employee.belongsTo(Account, { foreignKey: 'accountId', as: 'account' });

Account.hasOne(PartnerProfile,    { foreignKey: 'accountId', sourceKey: 'uuid', as: 'partner_profile', onDelete: 'CASCADE' });
PartnerProfile.belongsTo(Account, { foreignKey: 'accountId', targetKey: 'uuid', as: 'account' });

Account.hasMany(RefreshToken,   { foreignKey: 'account_uuid', sourceKey: 'uuid', as: 'refresh_tokens', onDelete: 'CASCADE' });
RefreshToken.belongsTo(Account, { foreignKey: 'account_uuid', targetKey: 'uuid', as: 'account' });

// ═══════════════════════════════════════════════════════════════════════════════
// ASSOCIATIONS — EMPLOYEE
// ═══════════════════════════════════════════════════════════════════════════════

Employee.belongsTo(Employee, { foreignKey: 'created_by', as: 'creator' });
Employee.hasMany(Employee,   { foreignKey: 'created_by', as: 'createdEmployees' });

Employee.hasMany(PriceRule,   { foreignKey: 'created_by', as: 'createdPriceRules' });
PriceRule.belongsTo(Employee, { foreignKey: 'created_by', as: 'creator' });

Employee.hasMany(PriceRule,   { foreignKey: 'updated_by', as: 'updatedPriceRules' });
PriceRule.belongsTo(Employee, { foreignKey: 'updated_by', as: 'updater' });

Employee.hasMany(Coupon,   { foreignKey: 'created_by', as: 'createdCoupons' });
Coupon.belongsTo(Employee, { foreignKey: 'created_by', as: 'creator' });

// ═══════════════════════════════════════════════════════════════════════════════
// ASSOCIATIONS — PARTNER PROFILE
// ═══════════════════════════════════════════════════════════════════════════════

PartnerProfile.belongsTo(Employee, { foreignKey: 'createdByEmployeeId', as: 'createdByEmployee', onDelete: 'SET NULL' });
Employee.hasMany(PartnerProfile,   { foreignKey: 'createdByEmployeeId', as: 'createdPartners' });

PartnerProfile.belongsTo(Employee, { foreignKey: 'blockedBy', as: 'blockedByEmployee', onDelete: 'SET NULL' });
Employee.hasMany(PartnerProfile,   { foreignKey: 'blockedBy', as: 'blockedPartners' });

PartnerProfile.hasMany(Vehicle,   { foreignKey: 'partnerId', sourceKey: 'accountId', as: 'vehicles', onDelete: 'RESTRICT' });
Vehicle.belongsTo(PartnerProfile, { foreignKey: 'partnerId', targetKey: 'accountId', as: 'partnerProfile' });

// ═══════════════════════════════════════════════════════════════════════════════
// ASSOCIATIONS — TRIP
// ═══════════════════════════════════════════════════════════════════════════════

Trip.belongsTo(Account, { foreignKey: 'passengerId', as: 'passenger', targetKey: 'uuid' });
Account.hasMany(Trip,   { foreignKey: 'passengerId', sourceKey: 'uuid', as: 'tripsAsPassenger' });

Trip.belongsTo(Account, { foreignKey: 'driverId', as: 'driver', targetKey: 'uuid' });
Account.hasMany(Trip,   { foreignKey: 'driverId', sourceKey: 'uuid', as: 'tripsAsDriver' });

Trip.hasMany(TripEvent,   { foreignKey: 'tripId', as: 'events', onDelete: 'CASCADE' });
TripEvent.belongsTo(Trip, { foreignKey: 'tripId', as: 'trip' });

Trip.hasMany(ChatMessage,   { foreignKey: 'tripId', as: 'messages', onDelete: 'CASCADE' });
ChatMessage.belongsTo(Trip, { foreignKey: 'tripId', as: 'trip' });

Trip.hasOne(Payment,    { foreignKey: 'tripId', as: 'payment', onDelete: 'CASCADE' });
Payment.belongsTo(Trip, { foreignKey: 'tripId', as: 'trip' });

Trip.hasMany(Rating, { foreignKey: 'trip_id', as: 'ratings', onDelete: 'CASCADE' });

Trip.hasOne(TripReceipt,    { foreignKey: 'tripId', as: 'receipt', onDelete: 'RESTRICT' });
TripReceipt.belongsTo(Trip, { foreignKey: 'tripId', as: 'trip' });

// ═══════════════════════════════════════════════════════════════════════════════
// ASSOCIATIONS — RATING
// ═══════════════════════════════════════════════════════════════════════════════

Rating.belongsTo(Trip,    { foreignKey: 'trip_id', as: 'trip' });
Rating.belongsTo(Account, { foreignKey: 'rated_by',   as: 'rater',  targetKey: 'uuid' });
Account.hasMany(Rating,   { foreignKey: 'rated_by',   sourceKey: 'uuid', as: 'ratingsGiven' });
Rating.belongsTo(Account, { foreignKey: 'rated_user', as: 'rated',  targetKey: 'uuid' });
Account.hasMany(Rating,   { foreignKey: 'rated_user', sourceKey: 'uuid', as: 'ratingsReceived' });

// ═══════════════════════════════════════════════════════════════════════════════
// ASSOCIATIONS — CHAT
// ═══════════════════════════════════════════════════════════════════════════════

ChatMessage.belongsTo(Account, { foreignKey: 'fromUserId', as: 'sender',    targetKey: 'uuid' });
Account.hasMany(ChatMessage,   { foreignKey: 'fromUserId', sourceKey: 'uuid', as: 'sentMessages' });

ChatMessage.belongsTo(Account, { foreignKey: 'toUserId', as: 'recipient', targetKey: 'uuid' });
Account.hasMany(ChatMessage,   { foreignKey: 'toUserId', sourceKey: 'uuid', as: 'receivedMessages' });

// ═══════════════════════════════════════════════════════════════════════════════
// ASSOCIATIONS — VEHICLE & DRIVER
// ═══════════════════════════════════════════════════════════════════════════════

Vehicle.belongsTo(Account,         { foreignKey: 'partnerId',  as: 'partner',   targetKey: 'uuid' });
Account.hasMany(Vehicle,           { foreignKey: 'partnerId',  sourceKey: 'uuid', as: 'ownedVehicles' });

Vehicle.belongsTo(VehicleCategory, { foreignKey: 'categoryId', as: 'category' });
VehicleCategory.hasMany(Vehicle,   { foreignKey: 'categoryId', as: 'vehicles' });

if (Driver) {
    Driver.belongsTo(Vehicle, { foreignKey: 'vehicleId', as: 'vehicle' });
    Vehicle.hasMany(Driver,   { foreignKey: 'vehicleId', as: 'drivers' });

    Driver.belongsTo(Account, { foreignKey: 'userId', targetKey: 'uuid', as: 'account' });
    Account.hasMany(Driver,   { foreignKey: 'userId', sourceKey: 'uuid', as: 'driverRecords' });

    // ← AJOUTER CES DEUX LIGNES
    Account.hasOne(Driver, { foreignKey: 'userId', sourceKey: 'uuid', as: 'driver_record' });
    Driver.hasOne(DeliveryWallet, { foreignKey: 'driver_id', as: 'delivery_wallet' });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ASSOCIATIONS — VEHICLE RENTAL
// ═══════════════════════════════════════════════════════════════════════════════

VehicleRental.belongsTo(Account, { foreignKey: 'userId',              as: 'user',              targetKey: 'uuid' });
Account.hasMany(VehicleRental,   { foreignKey: 'userId',              sourceKey: 'uuid',        as: 'rentals' });

VehicleRental.belongsTo(Vehicle, { foreignKey: 'vehicleId',           as: 'vehicle' });
Vehicle.hasMany(VehicleRental,   { foreignKey: 'vehicleId',           as: 'rentals' });

VehicleRental.belongsTo(Account, { foreignKey: 'handledByEmployeeId', as: 'handledByEmployee', targetKey: 'uuid' });
Account.hasMany(VehicleRental,   { foreignKey: 'handledByEmployeeId', sourceKey: 'uuid',        as: 'handledRentals' });

VehicleRental.belongsTo(Account, { foreignKey: 'approvedByAdminId',   as: 'approvedByAdmin',   targetKey: 'uuid' });
Account.hasMany(VehicleRental,   { foreignKey: 'approvedByAdminId',   sourceKey: 'uuid',        as: 'approvedRentals' });

// ═══════════════════════════════════════════════════════════════════════════════
// ASSOCIATIONS — PAYMENT
// ═══════════════════════════════════════════════════════════════════════════════

Payment.belongsTo(Account, { foreignKey: 'passengerId', as: 'passenger', targetKey: 'uuid' });
Account.hasMany(Payment,   { foreignKey: 'passengerId', sourceKey: 'uuid', as: 'paymentsAsPassenger' });

Payment.belongsTo(Account, { foreignKey: 'driverId', as: 'driver', targetKey: 'uuid' });
Account.hasMany(Payment,   { foreignKey: 'driverId', sourceKey: 'uuid', as: 'paymentsAsDriver' });

Vehicle.belongsTo(Employee, { foreignKey: 'postedByEmployeeId',   as: 'postedByEmployee' });
Employee.hasMany(Vehicle,   { foreignKey: 'postedByEmployeeId',   as: 'postedVehicles' });

Vehicle.belongsTo(Employee, { foreignKey: 'verifiedByEmployeeId', as: 'verifiedByEmployee' });
Employee.hasMany(Vehicle,   { foreignKey: 'verifiedByEmployeeId', as: 'verifiedVehicles' });

// ═══════════════════════════════════════════════════════════════════════════════
// ASSOCIATIONS — SERVICES MARKETPLACE
// ═══════════════════════════════════════════════════════════════════════════════

ServiceCategory.hasMany(ServiceCategory,   { foreignKey: 'parent_id', as: 'subcategories' });
ServiceCategory.belongsTo(ServiceCategory, { foreignKey: 'parent_id', as: 'parent' });

ServiceCategory.belongsTo(Employee, { foreignKey: 'created_by', as: 'creator' });
Employee.hasMany(ServiceCategory,   { foreignKey: 'created_by', as: 'createdServiceCategories' });

ServiceCategory.belongsTo(Employee, { foreignKey: 'updated_by', as: 'updater' });
Employee.hasMany(ServiceCategory,   { foreignKey: 'updated_by', as: 'updatedServiceCategories' });

ServiceCategory.hasMany(ServiceListing,   { foreignKey: 'category_id', as: 'listings' });
ServiceListing.belongsTo(ServiceCategory, { foreignKey: 'category_id', as: 'category' });

ServiceListing.belongsTo(Account, { foreignKey: 'provider_id', targetKey: 'uuid', as: 'provider' });
Account.hasMany(ServiceListing,   { foreignKey: 'provider_id', sourceKey: 'uuid', as: 'serviceListings' });

ServiceListing.belongsTo(Employee, { foreignKey: 'approved_by', as: 'approver' });
Employee.hasMany(ServiceListing,   { foreignKey: 'approved_by', as: 'approvedServiceListings' });

ServiceListing.belongsTo(Employee, { foreignKey: 'rejected_by', as: 'rejecter' });
Employee.hasMany(ServiceListing,   { foreignKey: 'rejected_by', as: 'rejectedServiceListings' });

ServiceListing.hasMany(ServiceRequest,   { foreignKey: 'listing_id', as: 'requests' });
ServiceRequest.belongsTo(ServiceListing, { foreignKey: 'listing_id', as: 'listing' });

ServiceRequest.belongsTo(Account, { foreignKey: 'provider_id', targetKey: 'uuid', as: 'provider' });
Account.hasMany(ServiceRequest,   { foreignKey: 'provider_id', sourceKey: 'uuid', as: 'serviceRequestsAsProvider' });

ServiceRequest.belongsTo(Account, { foreignKey: 'customer_id', targetKey: 'uuid', as: 'customer' });
Account.hasMany(ServiceRequest,   { foreignKey: 'customer_id', sourceKey: 'uuid', as: 'serviceRequestsAsCustomer' });

ServiceRequest.belongsTo(Account, { foreignKey: 'cancelled_by', targetKey: 'uuid', as: 'canceller' });

ServiceRequest.hasOne(ServiceRating,    { foreignKey: 'request_id', as: 'rating' });
ServiceRating.belongsTo(ServiceRequest, { foreignKey: 'request_id', as: 'request' });

ServiceRating.belongsTo(Account, { foreignKey: 'provider_id', targetKey: 'uuid', as: 'provider' });
Account.hasMany(ServiceRating,   { foreignKey: 'provider_id', sourceKey: 'uuid', as: 'serviceRatingsReceived' });

ServiceRating.belongsTo(Account, { foreignKey: 'customer_id', targetKey: 'uuid', as: 'customer' });
Account.hasMany(ServiceRating,   { foreignKey: 'customer_id', sourceKey: 'uuid', as: 'serviceRatingsGiven' });

ServiceRating.belongsTo(ServiceListing, { foreignKey: 'listing_id', as: 'listing' });
ServiceListing.hasMany(ServiceRating,   { foreignKey: 'listing_id', as: 'ratings' });

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

// ═══════════════════════════════════════════════════════════════════════════════
// ASSOCIATIONS — EARNINGS ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

Account.hasOne(DriverWallet,    { foreignKey: 'driverId', sourceKey: 'uuid', as: 'wallet', onDelete: 'RESTRICT' });
DriverWallet.belongsTo(Account, { foreignKey: 'driverId', targetKey: 'uuid', as: 'driver' });

DriverWallet.belongsTo(Employee, { foreignKey: 'frozenBy', as: 'frozenByEmployee' });
Employee.hasMany(DriverWallet,   { foreignKey: 'frozenBy', as: 'frozenWallets' });

DriverWallet.hasMany(DriverWalletTransaction,   { foreignKey: 'walletId', as: 'transactions', onDelete: 'RESTRICT' });
DriverWalletTransaction.belongsTo(DriverWallet, { foreignKey: 'walletId', as: 'wallet' });

Account.hasMany(DriverWalletTransaction,   { foreignKey: 'driverId', sourceKey: 'uuid', as: 'walletTransactions' });
DriverWalletTransaction.belongsTo(Account, { foreignKey: 'driverId', targetKey: 'uuid', as: 'driver' });

Trip.hasMany(DriverWalletTransaction,   { foreignKey: 'tripId', as: 'walletEntries' });
DriverWalletTransaction.belongsTo(Trip, { foreignKey: 'tripId', as: 'trip' });

TripReceipt.hasMany(DriverWalletTransaction,   { foreignKey: 'receiptId', as: 'walletEntries' });
DriverWalletTransaction.belongsTo(TripReceipt, { foreignKey: 'receiptId', as: 'receipt' });

EarningRule.hasMany(DriverWalletTransaction,   { foreignKey: 'ruleId', as: 'walletEntries' });
DriverWalletTransaction.belongsTo(EarningRule, { foreignKey: 'ruleId', as: 'rule' });

BonusProgram.hasMany(DriverWalletTransaction,   { foreignKey: 'bonusProgramId', as: 'walletEntries' });
DriverWalletTransaction.belongsTo(BonusProgram, { foreignKey: 'bonusProgramId', as: 'bonusProgram' });

BonusAward.hasOne(DriverWalletTransaction,    { foreignKey: 'bonusAwardId', as: 'walletEntry' });
DriverWalletTransaction.belongsTo(BonusAward, { foreignKey: 'bonusAwardId', as: 'bonusAward' });

Employee.hasMany(DriverWalletTransaction,   { foreignKey: 'adjustedBy', as: 'manualAdjustments' });
DriverWalletTransaction.belongsTo(Employee, { foreignKey: 'adjustedBy', as: 'adjustedByEmployee' });

Account.hasMany(TripReceipt,   { foreignKey: 'driverId',    sourceKey: 'uuid', as: 'tripReceipts' });
TripReceipt.belongsTo(Account, { foreignKey: 'driverId',    targetKey: 'uuid', as: 'driver' });

TripReceipt.belongsTo(Account, { foreignKey: 'passengerId', targetKey: 'uuid', as: 'passenger' });

EarningRule.hasMany(TripReceipt,   { foreignKey: 'commissionRuleId', as: 'receipts' });
TripReceipt.belongsTo(EarningRule, { foreignKey: 'commissionRuleId', as: 'commissionRule' });

Employee.hasMany(EarningRule,   { foreignKey: 'createdBy', as: 'createdEarningRules' });
EarningRule.belongsTo(Employee, { foreignKey: 'createdBy', as: 'creator' });

Employee.hasMany(EarningRule,   { foreignKey: 'updatedBy', as: 'updatedEarningRules' });
EarningRule.belongsTo(Employee, { foreignKey: 'updatedBy', as: 'updater' });

Employee.hasMany(BonusProgram,   { foreignKey: 'createdBy', as: 'createdBonusPrograms' });
BonusProgram.belongsTo(Employee, { foreignKey: 'createdBy', as: 'creator' });

Employee.hasMany(BonusProgram,   { foreignKey: 'updatedBy', as: 'updatedBonusPrograms' });
BonusProgram.belongsTo(Employee, { foreignKey: 'updatedBy', as: 'updater' });

Account.hasMany(BonusAward,   { foreignKey: 'driverId', sourceKey: 'uuid', as: 'bonusAwards' });
BonusAward.belongsTo(Account, { foreignKey: 'driverId', targetKey: 'uuid', as: 'driver' });

Trip.hasMany(BonusAward,   { foreignKey: 'triggerTripId', as: 'triggeredAwards' });
BonusAward.belongsTo(Trip, { foreignKey: 'triggerTripId', as: 'triggerTrip' });

// ═══════════════════════════════════════════════════════════════════════════════
// ASSOCIATIONS — PAYOUT SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

Account.hasMany(DailyBalanceSheet,   { foreignKey: 'driverId', sourceKey: 'uuid', as: 'balanceSheets', onDelete: 'RESTRICT' });
DailyBalanceSheet.belongsTo(Account, { foreignKey: 'driverId', targetKey: 'uuid', as: 'driver' });

DailyBalanceSheet.belongsTo(Employee, { foreignKey: 'closedBy', as: 'closedByEmployee' });
Employee.hasMany(DailyBalanceSheet,   { foreignKey: 'closedBy', as: 'closedBalanceSheets' });

Account.hasMany(PayoutRequest,   { foreignKey: 'driverId', sourceKey: 'uuid', as: 'payoutRequests', onDelete: 'RESTRICT' });
PayoutRequest.belongsTo(Account, { foreignKey: 'driverId', targetKey: 'uuid', as: 'driver' });

DailyBalanceSheet.hasMany(PayoutRequest,   { foreignKey: 'balanceSheetId', as: 'payoutRequests' });
PayoutRequest.belongsTo(DailyBalanceSheet, { foreignKey: 'balanceSheetId', as: 'balanceSheet' });

PayoutRequest.belongsTo(Employee, { foreignKey: 'initiatedByEmployeeId', as: 'initiatedByEmployee' });
Employee.hasMany(PayoutRequest,   { foreignKey: 'initiatedByEmployeeId', as: 'initiatedPayouts' });

PayoutRequest.belongsTo(Employee, { foreignKey: 'processedBy', as: 'processedByEmployee' });
Employee.hasMany(PayoutRequest,   { foreignKey: 'processedBy', as: 'processedPayouts' });

PayoutRequest.belongsTo(Employee, { foreignKey: 'confirmedBy', as: 'confirmedByEmployee' });
Employee.hasMany(PayoutRequest,   { foreignKey: 'confirmedBy', as: 'confirmedPayouts' });

PayoutRequest.belongsTo(Employee, { foreignKey: 'rejectedBy', as: 'rejectedByPayoutEmployee' });
Employee.hasMany(PayoutRequest,   { foreignKey: 'rejectedBy', as: 'rejectedPayouts' });

PayoutRequest.belongsTo(Employee, { foreignKey: 'cancelledBy', as: 'cancelledByEmployee' });
Employee.hasMany(PayoutRequest,   { foreignKey: 'cancelledBy', as: 'cancelledPayouts' });

Account.hasMany(DebtPayment,   { foreignKey: 'driverId', sourceKey: 'uuid', as: 'debtPayments', onDelete: 'RESTRICT' });
DebtPayment.belongsTo(Account, { foreignKey: 'driverId', targetKey: 'uuid', as: 'driver' });

DailyBalanceSheet.hasMany(DebtPayment,   { foreignKey: 'balanceSheetId', as: 'debtPayments' });
DebtPayment.belongsTo(DailyBalanceSheet, { foreignKey: 'balanceSheetId', as: 'balanceSheet' });

DebtPayment.belongsTo(Employee, { foreignKey: 'handledByEmployeeId', as: 'handledByEmployee' });
Employee.hasMany(DebtPayment,   { foreignKey: 'handledByEmployeeId', as: 'handledDebtPayments' });

DebtPayment.belongsTo(Employee, { foreignKey: 'verifiedBy', as: 'verifiedByEmployee' });
Employee.hasMany(DebtPayment,   { foreignKey: 'verifiedBy', as: 'verifiedDebtPayments' });

DebtPayment.belongsTo(Employee, { foreignKey: 'rejectedBy', as: 'rejectedByDebtEmployee' });
Employee.hasMany(DebtPayment,   { foreignKey: 'rejectedBy', as: 'rejectedDebtPayments' });

// ═══════════════════════════════════════════════════════════════════════════════
// ASSOCIATIONS — DELIVERY
// ═══════════════════════════════════════════════════════════════════════════════
//
// ⚠️  RULE: Never define a delivery association directly in this file.
//     Each model's associate() is the single source of truth.
//     Defining the same association twice with the same alias causes the
//     "Account.hasOne called with something that's not a subclass of
//     Sequelize.Model" startup crash.
//
const deliveryModels = {
    Account,
    Driver,
    Employee,
    Delivery,
    DeliveryPricing,
    DeliverySurgeRule,
    DeliveryTracking,
    DeliveryDispute,
    DeliveryWallet,
    DeliveryWalletTransaction,
    DeliveryWalletTopUp,
    DeliveryPayoutRequest,
    DeliveryCategory,
};

DeliveryPricing.associate(deliveryModels);
DeliverySurgeRule.associate(deliveryModels);
Delivery.associate(deliveryModels);
DeliveryTracking.associate(deliveryModels);
DeliveryDispute.associate(deliveryModels);
DeliveryWallet.associate(deliveryModels);            // ← does hasMany(topUps) internally — do NOT repeat here
DeliveryWalletTransaction.associate(deliveryModels);
DeliveryPayoutRequest.associate(deliveryModels);
DeliveryWalletTopUp.associate(deliveryModels);
DeliveryCategory.associate(deliveryModels);

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
    sequelize,

    // ── Core account ────────────────────────────────────────────────────────
    Account,
    PendingSignup,
    PassengerProfile,
    DriverProfile,
    VerificationCode,
    DriverDocument,
    Employee,
    Coupon,
    PartnerProfile,

    // ── Authentication ───────────────────────────────────────────────────────
    RefreshToken,

    // ── Trip ─────────────────────────────────────────────────────────────────
    Trip,
    TripEvent,
    Rating,
    Payment,

    // ── Communication ────────────────────────────────────────────────────────
    ChatMessage,

    // ── Vehicle ──────────────────────────────────────────────────────────────
    Vehicle,
    VehicleCategory,
    VehicleRental,

    // ── Pricing / misc ───────────────────────────────────────────────────────
    PriceRule,
    SupportTicket,
    IdempotencyKey,

    // ── Services marketplace ─────────────────────────────────────────────────
    ServiceCategory,
    ServiceListing,
    ServiceRequest,
    ServiceRating,
    ServiceDispute,

    // ── Driver ───────────────────────────────────────────────────────────────
    Driver,
    DriverLocation,

    // ── Earnings engine ──────────────────────────────────────────────────────
    TripReceipt,
    DriverWallet,
    DriverWalletTransaction,
    EarningRule,
    BonusProgram,
    BonusAward,

    // ── Payout system ────────────────────────────────────────────────────────
    DailyBalanceSheet,
    PayoutRequest,
    DebtPayment,

    // ── Delivery ─────────────────────────────────────────────────────────────
    Delivery,
    DeliveryDispute,
    DeliveryPricing,
    DeliveryTracking,
    DeliverySurgeRule,
    DeliveryWallet,
    DeliveryWalletTransaction,
    DeliveryWalletTopUp,
    DeliveryPayoutRequest,
    DeliveryCategory,
};