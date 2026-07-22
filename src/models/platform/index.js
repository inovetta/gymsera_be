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

// ── Associations ──────────────────────────────────────────────────────────────

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
GymListing.hasMany(SavedGym, { foreignKey: 'gymListingId', as: 'savedGyms', onDelete: 'CASCADE' });
SavedGym.belongsTo(GymListing, { foreignKey: 'gymListingId', as: 'gym' });

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
Tenant.hasMany(TenantSubscription, { foreignKey: 'tenantId', as: 'subscriptions' });
TenantSubscription.belongsTo(Tenant, { foreignKey: 'tenantId', as: 'tenant' });

// Tenant ↔ PlatformPackage (selected package)
Tenant.belongsTo(PlatformPackage, { foreignKey: 'selectedPackageId', as: 'selectedPackage' });
PlatformPackage.hasMany(Tenant, { foreignKey: 'selectedPackageId', as: 'tenants' });

// Tenant ↔ GymListing (one-to-one: each approved tenant has one public gym listing)
Tenant.hasOne(GymListing, { foreignKey: 'tenantId', as: 'gymListing' });
Tenant.hasMany(GymListing, { foreignKey: 'tenantId', as: 'gymListings' });
GymListing.belongsTo(Tenant, { foreignKey: 'tenantId', as: 'tenant' });

// PlatformPackage ↔ TenantSubscription
PlatformPackage.hasMany(TenantSubscription, { foreignKey: 'platformPackageId', as: 'tenantSubscriptions' });
TenantSubscription.belongsTo(PlatformPackage, { foreignKey: 'platformPackageId', as: 'package' });

// Tenant ↔ PlatformInvoice
Tenant.hasMany(PlatformInvoice, { foreignKey: 'tenantId', as: 'platformInvoices' });
PlatformInvoice.belongsTo(Tenant, { foreignKey: 'tenantId', as: 'tenant' });

// TenantSubscription ↔ PlatformInvoice
TenantSubscription.hasMany(PlatformInvoice, { foreignKey: 'tenantSubscriptionId', as: 'invoices' });
PlatformInvoice.belongsTo(TenantSubscription, { foreignKey: 'tenantSubscriptionId', as: 'subscription' });

// City / Area ↔ GymListing
City.hasMany(GymListing, { foreignKey: 'cityId', as: 'gymListings' });
GymListing.belongsTo(City, { foreignKey: 'cityId', as: 'city' });

Area.hasMany(GymListing, { foreignKey: 'areaId', as: 'gymListings' });
GymListing.belongsTo(Area, { foreignKey: 'areaId', as: 'area' });

// User ↔ UserGymMembership (cross-tenant subscription index)
User.hasMany(UserGymMembership, { foreignKey: 'userId', as: 'gymMemberships', onDelete: 'CASCADE' });
UserGymMembership.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// Tenant ↔ UserGymMembership
Tenant.hasMany(UserGymMembership, { foreignKey: 'tenantId', as: 'memberMemberships' });
UserGymMembership.belongsTo(Tenant, { foreignKey: 'tenantId', as: 'tenant' });

// GymListing ↔ UserGymMembership
GymListing.hasMany(UserGymMembership, { foreignKey: 'gymListingId', as: 'memberships' });
UserGymMembership.belongsTo(GymListing, { foreignKey: 'gymListingId', as: 'gymListing' });

// GymListing ↔ GymReview
GymListing.hasMany(GymReview, { foreignKey: 'gymListingId', as: 'reviews', onDelete: 'CASCADE' });
GymReview.belongsTo(GymListing, { foreignKey: 'gymListingId', as: 'gym' });

// User ↔ GymReview
User.hasMany(GymReview, { foreignKey: 'userId', as: 'gymReviews', onDelete: 'CASCADE' });
GymReview.belongsTo(User, { foreignKey: 'userId', as: 'reviewer' });

// Tenant ↔ GymReview
Tenant.hasMany(GymReview, { foreignKey: 'tenantId', as: 'gymReviews' });
GymReview.belongsTo(Tenant, { foreignKey: 'tenantId', as: 'tenant' });

// Tenant ↔ Device
Tenant.hasMany(Device, { foreignKey: 'tenantId', as: 'devices', onDelete: 'CASCADE' });
Device.belongsTo(Tenant, { foreignKey: 'tenantId', as: 'tenant' });

// Device ↔ DeviceMember
Device.hasMany(DeviceMember, { foreignKey: 'deviceId', as: 'members', onDelete: 'CASCADE' });
DeviceMember.belongsTo(Device, { foreignKey: 'deviceId', as: 'device' });

// User ↔ DeviceMember
User.hasMany(DeviceMember, { foreignKey: 'userId', as: 'deviceMemberships', onDelete: 'CASCADE' });
DeviceMember.belongsTo(User, { foreignKey: 'userId', as: 'user' });

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
};
