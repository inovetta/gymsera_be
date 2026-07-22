const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'MembershipPlan',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      gymId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      // Null = gym-wide plan, set = branch-specific plan
      branchId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      name: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      durationType: {
        type: DataTypes.ENUM('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'),
        allowNull: false,
        defaultValue: 'MONTHLY',
      },
      durationValue: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
      },
      price: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
      },
      joiningFee: {
        type: DataTypes.DECIMAL(10, 2),
        defaultValue: 0.0,
      },
      securityFee: {
        type: DataTypes.DECIMAL(10, 2),
        defaultValue: 0.0,
      },
      // null = unlimited visits
      visitLimit: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      freezeLimitDays: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      isTrial: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      status: {
        type: DataTypes.ENUM('ACTIVE', 'INACTIVE'),
        allowNull: false,
        defaultValue: 'ACTIVE',
      },
      // Whether this plan is shown to travellers in the public listing
      isPublic: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      // Whether this plan's price is shown as the "Starting from" price on the listing card
      // Only one plan per gym should be featured at a time (enforced in service layer)
      isFeatured: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      posterUrl: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
    },
    {
      tableName: 'membership_plans',
      underscored: true,
      timestamps: true,
      indexes: [
        { fields: ['gym_id'] },
        { fields: ['branch_id'] },
        { fields: ['status'] },
        { fields: ['is_public'] },
        { fields: ['is_featured'] },
      ],
    }
  );
};
