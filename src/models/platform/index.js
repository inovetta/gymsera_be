/**
 * Platform models index.
 *
 * Registers all platform-side Sequelize models and declares their associations.
 * Import this module (not individual model files) wherever platform models are needed.
 *
 * Usage: const { User, Tenant, City } = require('./src/models/platform');
 */
const { sequelize } = require('../../database/platform');

const User = require('./User.model')(sequelize);
const Tenant = require('./Tenant.model')(sequelize);
const City = require('./City.model')(sequelize);
const Area = require('./Area.model')(sequelize);
const PlatformPackage = require('./PlatformPackage.model')(sequelize);
const TenantSubscription = require('./TenantSubscription.model')(sequelize);
const PlatformInvoice = require('./PlatformInvoice.model')(sequelize);
const GymListing = require('./GymListing.model')(sequelize);
const RefreshToken = require('./RefreshToken.model')(sequelize);
const Otp = require('./Otp.model')(sequelize);
const UserGymMembership = require('./UserGymMembership.model')(sequelize);
const GymReview = require('./GymReview.model')(sequelize);
const Device = require('./Device.model')(sequelize);
const DeviceMember = require('./DeviceMember.model')(sequelize);
const SavedGym = require('./SavedGym.model')(sequelize);
const Notification = require('./Notification.model')(sequelize);
const Conversation = require('./Conversation.model')(sequelize);
const Message = require('./Message.model')(sequelize);
const DeviceToken = require('./DeviceToken.model')(sequelize);
const UserOrgIndex = require('./UserOrgIndex.model')(sequelize);
const BillingPlan = require('./BillingPlan.model')(sequelize);
const BillingPlanPrice = require('./BillingPlanPrice.model')(sequelize);
const BillingPlanPriceCheck = require('./BillingPlanPriceCheck.model')(sequelize);
const BillingOffer = require('./BillingOffer.model')(sequelize);
const CapacityEvent = require('./CapacityEvent.model')(sequelize);
const BillingEvent = require('./BillingEvent.model')(sequelize);
const TenantInvitation = require('./TenantInvitation.model')(sequelize);
const PlatformAuditLog = require('./PlatformAuditLog.model')(sequelize);
const AuditLog = require('./AuditLog.model')(sequelize);
const IdempotencyRecord = require('./IdempotencyRecord.model')(sequelize);
const PayoutAccount = require('./PayoutAccount.model')(sequelize);
const PlanPaymentRequest = require('./PlanPaymentRequest.model')(sequelize);
const ContentReport = require('./ContentReport.model')(sequelize);
const UserBlock = require('./UserBlock.model')(sequelize);
const ModerationWord = require('./ModerationWord.model')(sequelize);
const AreaRequest = require('./AreaRequest.model')(sequelize);
const AreaRequestLink = require('./AreaRequestLink.model')(sequelize);
const AreaAlias = require('./AreaAlias.model')(sequelize);

// ── Associations ──────────────────────────────────────────────────────────────

// User ↔ UserOrgIndex (routing index — see UserOrgIndex.model.js)
User.hasMany(UserOrgIndex, { foreignKey: 'userId', as: 'orgMemberships', onDelete: 'CASCADE' });
UserOrgIndex.belongsTo(User, { foreignKey: 'userId', as: 'user' });
UserOrgIndex.belongsTo(Tenant, { foreignKey: 'organizationId', as: 'tenant', constraints: false });

// User ↔ DeviceToken
User.hasMany(DeviceToken, { foreignKey: 'userId', as: 'deviceTokens', onDelete: 'CASCADE' });
DeviceToken.belongsTo(User, { foreignKey: 'userId', as: 'user' });
DeviceToken.sync().catch((err) => {
  console.warn('[DeviceToken] Auto-sync notice:', err.message);
});

// Conversation ↔ Message
Conversation.hasMany(Message, { foreignKey: 'conversationId', as: 'messages', onDelete: 'CASCADE' });
Message.belongsTo(Conversation, { foreignKey: 'conversationId', as: 'conversation' });

// User ↔ Conversation
User.hasMany(Conversation, { foreignKey: 'userId', as: 'conversations', onDelete: 'CASCADE' });
Conversation.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// GymListing ↔ Conversation
GymListing.hasMany(Conversation, { foreignKey: 'branchId', sourceKey: 'branchId', as: 'conversations', constraints: false });
Conversation.belongsTo(GymListing, { foreignKey: 'branchId', targetKey: 'branchId', as: 'gymListing', constraints: false });

// User ↔ Notification
User.hasMany(Notification, { foreignKey: 'userId', as: 'notifications', onDelete: 'CASCADE' });
Notification.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// User ↔ SavedGym
User.hasMany(SavedGym, { foreignKey: 'userId', as: 'savedGyms', onDelete: 'CASCADE' });
SavedGym.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// GymListing ↔ SavedGym
GymListing.hasMany(SavedGym, { foreignKey: 'businessId', as: 'savedGyms', onDelete: 'CASCADE' });
SavedGym.belongsTo(GymListing, { foreignKey: 'businessId', as: 'gym' });

// User ↔ RefreshToken
User.hasMany(RefreshToken, { foreignKey: 'userId', as: 'refreshTokens', onDelete: 'CASCADE' });
RefreshToken.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// User ↔ Otp
User.hasMany(Otp, { foreignKey: 'userId', as: 'otps', onDelete: 'CASCADE' });
Otp.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// User ↔ Tenant (as owner)
User.hasMany(Tenant, { foreignKey: 'ownerUserId', as: 'ownedTenants' });
Tenant.belongsTo(User, { foreignKey: 'ownerUserId', as: 'owner' });

// City ↔ Area
City.hasMany(Area, { foreignKey: 'cityId', as: 'areas', onDelete: 'CASCADE' });
Area.belongsTo(City, { foreignKey: 'cityId', as: 'city' });

// City ↔ Tenant
City.hasMany(Tenant, { foreignKey: 'cityId', as: 'tenants' });
Tenant.belongsTo(City, { foreignKey: 'cityId', as: 'city' });

// Tenant ↔ TenantSubscription
Tenant.hasMany(TenantSubscription, { foreignKey: 'organizationId', as: 'subscriptions' });
TenantSubscription.belongsTo(Tenant, { foreignKey: 'organizationId', as: 'tenant' });

// Tenant ↔ PlatformPackage (selected package)
Tenant.belongsTo(PlatformPackage, { foreignKey: 'selectedPackageId', as: 'selectedPackage' });
PlatformPackage.hasMany(Tenant, { foreignKey: 'selectedPackageId', as: 'tenants' });

// Tenant ↔ GymListing (one-to-one: each approved tenant has one public gym listing)
Tenant.hasOne(GymListing, { foreignKey: 'organizationId', as: 'gymListing' });
Tenant.hasMany(GymListing, { foreignKey: 'organizationId', as: 'gymListings' });
GymListing.belongsTo(Tenant, { foreignKey: 'organizationId', as: 'tenant' });

// Tenant / GymListing ↔ CapacityEvent (audit trail — see CapacityEvent.model.js).
// constraints: false on both associations deliberately — an append-only
// audit log should never be blocked from writing, or have its own rows
// cascade-deleted, by referential churn on the rows it describes.
Tenant.hasMany(CapacityEvent, { foreignKey: 'organizationId', as: 'capacityEvents', constraints: false });
CapacityEvent.belongsTo(Tenant, { foreignKey: 'organizationId', as: 'tenant', constraints: false });
GymListing.hasMany(CapacityEvent, { foreignKey: 'listingId', as: 'capacityEvents', constraints: false });
CapacityEvent.belongsTo(GymListing, { foreignKey: 'listingId', as: 'listing', constraints: false });

// PlatformPackage ↔ TenantSubscription (legacy manual/Enterprise path only)
PlatformPackage.hasMany(TenantSubscription, { foreignKey: 'platformPackageId', as: 'tenantSubscriptions' });
TenantSubscription.belongsTo(PlatformPackage, { foreignKey: 'platformPackageId', as: 'package' });

// BillingPlan ↔ BillingPlanPrice (extra currencies, BILL-11)
BillingPlan.hasMany(BillingPlanPrice, { foreignKey: 'billingPlanId', as: 'prices' });
BillingPlanPrice.belongsTo(BillingPlan, { foreignKey: 'billingPlanId', as: 'plan' });
BillingPlan.hasMany(BillingPlanPriceCheck, { foreignKey: 'billingPlanId', as: 'priceChecks' });

// BillingPlan ↔ TenantSubscription (real store-verified purchases)
BillingPlan.hasMany(TenantSubscription, { foreignKey: 'billingPlanId', as: 'tenantSubscriptions' });
TenantSubscription.belongsTo(BillingPlan, { foreignKey: 'billingPlanId', as: 'billingPlan' });

// Tenant ↔ PlatformInvoice
Tenant.hasMany(PlatformInvoice, { foreignKey: 'organizationId', as: 'platformInvoices' });
PlatformInvoice.belongsTo(Tenant, { foreignKey: 'organizationId', as: 'tenant' });

// TenantSubscription ↔ PlatformInvoice
TenantSubscription.hasMany(PlatformInvoice, { foreignKey: 'organizationSubscriptionId', as: 'invoices' });
PlatformInvoice.belongsTo(TenantSubscription, { foreignKey: 'organizationSubscriptionId', as: 'subscription' });

// City / Area ↔ GymListing
City.hasMany(GymListing, { foreignKey: 'cityId', as: 'gymListings' });
GymListing.belongsTo(City, { foreignKey: 'cityId', as: 'city' });

Area.hasMany(GymListing, { foreignKey: 'areaId', as: 'gymListings' });
GymListing.belongsTo(Area, { foreignKey: 'areaId', as: 'area' });

// User ↔ UserGymMembership (cross-tenant subscription index)
User.hasMany(UserGymMembership, { foreignKey: 'userId', as: 'gymMemberships', onDelete: 'CASCADE' });
UserGymMembership.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// Tenant ↔ UserGymMembership
Tenant.hasMany(UserGymMembership, { foreignKey: 'organizationId', as: 'memberMemberships' });
UserGymMembership.belongsTo(Tenant, { foreignKey: 'organizationId', as: 'tenant' });

// GymListing ↔ UserGymMembership
GymListing.hasMany(UserGymMembership, { foreignKey: 'businessId', as: 'memberships' });
UserGymMembership.belongsTo(GymListing, { foreignKey: 'businessId', as: 'gymListing' });

// GymListing ↔ GymReview
GymListing.hasMany(GymReview, { foreignKey: 'businessId', as: 'reviews', onDelete: 'CASCADE' });
GymReview.belongsTo(GymListing, { foreignKey: 'businessId', as: 'gym' });

// User ↔ GymReview
User.hasMany(GymReview, { foreignKey: 'userId', as: 'gymReviews', onDelete: 'CASCADE' });
GymReview.belongsTo(User, { foreignKey: 'userId', as: 'reviewer' });

// Tenant ↔ GymReview
Tenant.hasMany(GymReview, { foreignKey: 'organizationId', as: 'gymReviews' });
GymReview.belongsTo(Tenant, { foreignKey: 'organizationId', as: 'tenant' });

// NEW-256: names for the CMS report queue. No database constraints (p031 creates none).
ContentReport.belongsTo(User, { foreignKey: 'reporterUserId', as: 'reporter', constraints: false });
ContentReport.belongsTo(User, { foreignKey: 'targetUserId', as: 'targetUser', constraints: false });
ContentReport.belongsTo(User, { foreignKey: 'handledByUserId', as: 'handledBy', constraints: false });
UserBlock.belongsTo(User, { foreignKey: 'userId', as: 'user', constraints: false });
UserBlock.belongsTo(Tenant, { foreignKey: 'organizationId', as: 'tenant', constraints: false });

// Tenant ↔ Device
Tenant.hasMany(Device, { foreignKey: 'organizationId', as: 'devices', onDelete: 'CASCADE' });
Device.belongsTo(Tenant, { foreignKey: 'organizationId', as: 'tenant' });

// Device ↔ DeviceMember
Device.hasMany(DeviceMember, { foreignKey: 'deviceId', as: 'members', onDelete: 'CASCADE' });
DeviceMember.belongsTo(Device, { foreignKey: 'deviceId', as: 'device' });

// User ↔ DeviceMember
User.hasMany(DeviceMember, { foreignKey: 'userId', as: 'deviceMemberships', onDelete: 'CASCADE' });
DeviceMember.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// TenantInvitation associations
User.hasMany(TenantInvitation, { foreignKey: 'invitedBy', as: 'sentTenantInvitations' });
TenantInvitation.belongsTo(User, { foreignKey: 'invitedBy', as: 'inviter' });
Tenant.hasMany(TenantInvitation, { foreignKey: 'organizationId', as: 'invitations' });
TenantInvitation.belongsTo(Tenant, { foreignKey: 'organizationId', as: 'tenant' });

// PlatformAuditLog associations
User.hasMany(PlatformAuditLog, { foreignKey: 'actorUserId', as: 'platformAuditLogs' });
PlatformAuditLog.belongsTo(User, { foreignKey: 'actorUserId', as: 'actor' });

// AuditLog (HTTP mutation audit trail) associations
User.hasMany(AuditLog, { foreignKey: 'userId', as: 'auditLogs', constraints: false });
AuditLog.belongsTo(User, { foreignKey: 'userId', as: 'user', constraints: false });
Tenant.hasMany(AuditLog, { foreignKey: 'organizationId', as: 'auditLogs', constraints: false });
AuditLog.belongsTo(Tenant, { foreignKey: 'organizationId', as: 'tenant', constraints: false });

// Discovery snapshot (PERF-06): a write to any platform model the public listing
// reads (listing status/featured, tenant status, ratings, cities/areas) drops it.
// TenantSubscription: a subscription that stops (or starts) entitling a tenant changes who is live (R-77, BUG-26).
require('../../services/discovery-cache.service').watchModels([GymListing, Tenant, TenantSubscription, GymReview, City, Area]);

// ZKTeco Phase 3: a suspended user leaves every access device at once (device-triggers.js).
require('../../services/devices/device-triggers').attachUserHook(User);

module.exports = {
  sequelize,
  User,
  Tenant,
  City,
  Area,
  PlatformPackage,
  TenantSubscription,
  PlatformInvoice,
  GymListing,
  RefreshToken,
  Otp,
  UserGymMembership,
  GymReview,
  Device,
  DeviceMember,
  SavedGym,
  Notification,
  Conversation,
  Message,
  DeviceToken,
  UserOrgIndex,
  BillingPlan,
  BillingPlanPrice,
  BillingPlanPriceCheck,
  BillingOffer,
  CapacityEvent,
  BillingEvent,
  TenantInvitation,
  PlatformAuditLog,
  AuditLog,
  IdempotencyRecord,
  PayoutAccount,
  PlanPaymentRequest,
  ContentReport,
  UserBlock,
  ModerationWord,
  AreaRequest,
  AreaRequestLink,
  AreaAlias,
};
