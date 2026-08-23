const { DataTypes } = require('sequelize');
const { SubscriptionStatus } = require('../../constants/subscription-status');

module.exports = (sequelize) => {
  return sequelize.define(
    'MemberSubscription',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      // Platform user ID (cross-DB reference)
      userId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      branchId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      membershipPlanId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      startDate: {
        type: DataTypes.DATEONLY,
        allowNull: false,
      },
      endDate: {
        type: DataTypes.DATEONLY,
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM(...Object.values(SubscriptionStatus)),
        allowNull: false,
        defaultValue: SubscriptionStatus.PENDING,
      },
      autoRenew: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      qrCode: {
        type: DataTypes.STRING(500),
        allowNull: true,
        unique: true,
      },
      subscribedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      cancelledAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      freezeFrom: {
        type: DataTypes.DATEONLY,
        allowNull: true,
      },
      freezeTo: {
        type: DataTypes.DATEONLY,
        allowNull: true,
      },
      // null = unlimited
      remainingVisits: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      sourceChannel: {
        type: DataTypes.ENUM('ONLINE', 'WALK_IN', 'STAFF'),
        allowNull: true,
        defaultValue: 'WALK_IN',
      },
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      pendingPlanId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      pendingChangeEffectiveDate: {
        type: DataTypes.DATEONLY,
        allowNull: true,
      },
      // Platform user ID who created/initiated this subscription
      createdBy: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      // Role of creator ('HOST' | 'ADMIN' | 'STAFF' | 'MEMBER' | 'SYSTEM')
      createdByRole: {
        type: DataTypes.STRING(30),
        allowNull: true,
      },
    },
    {
      tableName: 'member_subscriptions',
      underscored: true,
      timestamps: true,
      indexes: [
        { fields: ['user_id', 'status'] },
        { fields: ['branch_id'] },
        { fields: ['membership_plan_id'] },
        { fields: ['end_date'] },
        { fields: ['status'] },
      ],
    }
  );
};
