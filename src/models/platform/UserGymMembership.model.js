const { DataTypes } = require('sequelize');
const { SubscriptionStatus } = require('../../constants/subscription-status');

/**
 * UserGymMembership — Platform DB cross-tenant subscription index.
 *
 * Created when a user subscribes to a gym plan (tenant DB).
 * Allows GET /me/subscriptions to list all of a user's active memberships
 * across multiple tenant DBs without scanning every tenant.
 *
 * The full subscription record lives in the tenant DB's member_subscriptions
 * table. This record stores just enough to route back to the correct tenant.
 */
module.exports = (sequelize) => {
  return sequelize.define(
    'UserGymMembership',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      // Platform user ID
      userId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      // Tenant the subscription lives in
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      // GymListing ID (for quick display without tenant DB round-trip)
      gymListingId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      // MemberSubscription UUID in the tenant DB
      subscriptionId: {
        type: DataTypes.UUID,
        allowNull: false,
        unique: true,
      },
      // Denormalised fields for fast listing without hitting tenant DB
      gymName: {
        type: DataTypes.STRING(200),
        allowNull: true,
      },
      planName: {
        type: DataTypes.STRING(200),
        allowNull: true,
      },
      startDate: {
        type: DataTypes.DATEONLY,
        allowNull: true,
      },
      endDate: {
        type: DataTypes.DATEONLY,
        allowNull: true,
      },
      status: {
        type: DataTypes.ENUM(...Object.values(SubscriptionStatus)),
        allowNull: false,
        defaultValue: SubscriptionStatus.ACTIVE,
      },
    },
    {
      tableName: 'user_gym_memberships',
      underscored: true,
      timestamps: true,
      indexes: [
        { fields: ['user_id', 'status'] },
        { fields: ['tenant_id'] },
        { fields: ['subscription_id'] },
        { fields: ['gym_listing_id'] },
      ],
    }
  );
};
