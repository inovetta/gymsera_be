const { DataTypes } = require('sequelize');

/**
 * Result of the last read-only price check of one BillingPlan against a store (BILL-15).
 * One row per (plan, provider), replaced by each run. It records what the store said; it never feeds back into
 * the plan: prices and sync statuses on BillingPlan stay exactly as the admin set them.
 */
module.exports = (sequelize) =>
  sequelize.define(
    'BillingPlanPriceCheck',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      billingPlanId: { type: DataTypes.UUID, allowNull: false },
      provider: { type: DataTypes.STRING(10), allowNull: false },
      status: { type: DataTypes.ENUM('VERIFIED', 'MISMATCH', 'UNVERIFIABLE'), allowNull: false },
      mismatchCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      detailsJson: { type: DataTypes.JSON, allowNull: true },
      checkedAt: { type: DataTypes.DATE, allowNull: false },
    },
    {
      tableName: 'billing_plan_price_checks',
      underscored: true,
      timestamps: false,
      indexes: [{ unique: true, fields: ['billing_plan_id', 'provider'] }],
    }
  );
