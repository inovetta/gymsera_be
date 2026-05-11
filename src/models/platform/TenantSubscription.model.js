const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'TenantSubscription',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      platformPackageId: {
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
      amount: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
      },
      billingCycle: {
        type: DataTypes.ENUM('MONTHLY', 'QUARTERLY', 'YEARLY'),
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('ACTIVE', 'EXPIRED', 'CANCELLED'),
        allowNull: false,
        defaultValue: 'ACTIVE',
      },
      autoRenew: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
      paymentStatus: {
        type: DataTypes.ENUM('PENDING', 'PAID', 'FAILED'),
        allowNull: false,
        defaultValue: 'PENDING',
      },
    },
    {
      tableName: 'tenant_subscriptions',
      underscored: true,
      timestamps: true,
      indexes: [
        { fields: ['tenant_id'] },
        { fields: ['status'] },
        { fields: ['end_date'] },
      ],
    }
  );
};
