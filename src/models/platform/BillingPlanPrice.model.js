const { DataTypes } = require('sequelize');

/**
 * One extra currency for a BillingPlan tier (BILL-11). The BillingPlan row's own monthlyPrice / annualPrice /
 * currency stay the default (PKR) price; a row here adds a price in another currency, in the currency's own
 * minor units (USD cents, JPY yen), together with that currency's Stripe Price IDs.
 *
 * Catalog only: the charge itself always comes from the store or Stripe that processed the purchase, and an
 * existing subscriber's locked-in price (TenantSubscription.amount) is never touched by editing a row here.
 */
module.exports = (sequelize) =>
  sequelize.define(
    'BillingPlanPrice',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      billingPlanId: { type: DataTypes.UUID, allowNull: false },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      monthlyMinor: { type: DataTypes.BIGINT, allowNull: false },
      annualMinor: { type: DataTypes.BIGINT, allowNull: false },
      stripeMonthlyPriceId: { type: DataTypes.STRING(150), allowNull: true },
      stripeAnnualPriceId: { type: DataTypes.STRING(150), allowNull: true },
    },
    {
      tableName: 'billing_plan_prices',
      underscored: true,
      timestamps: true,
      indexes: [{ unique: true, fields: ['billing_plan_id', 'currency'] }],
    }
  );
