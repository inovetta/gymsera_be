const { DataTypes } = require('sequelize');

/**
 * The branch-count pricing staircase, as actual data — never hardcoded in the
 * app or in backend code. One row per branch count (1..N); each row carries
 * every storefront's product identifiers and prices side by side, so adding
 * a step, changing a price, or wiring up a new platform (Android, web/Stripe)
 * is a data change here, not an app release on any platform.
 *
 * The app fetches this via `GET /billing/plans` and never assumes a product
 * ID or price — it always asks. iOS/Android still separately need a matching
 * product configured in App Store Connect / Play Console (this table doesn't
 * create that for you), but once configured, wiring is one row here.
 */
module.exports = (sequelize) => {
  return sequelize.define(
    'BillingPlan',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      branchCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: 'How many branches this step of the staircase includes, across all of a tenant\'s organizations combined.',
      },
      // iOS — App Store Connect product IDs, e.g. "branches_3_monthly".
      iosMonthlyProductId: { type: DataTypes.STRING(150), allowNull: true },
      iosAnnualProductId: { type: DataTypes.STRING(150), allowNull: true },
      // Android — Play Console: one subscription product ID per branch count,
      // with "monthly"/"annual" as its base plan IDs (see billing docs).
      androidProductId: { type: DataTypes.STRING(150), allowNull: true },
      androidMonthlyBasePlanId: { type: DataTypes.STRING(150), allowNull: true },
      androidAnnualBasePlanId: { type: DataTypes.STRING(150), allowNull: true },
      // Web — Stripe Price IDs.
      stripeMonthlyPriceId: { type: DataTypes.STRING(150), allowNull: true },
      stripeAnnualPriceId: { type: DataTypes.STRING(150), allowNull: true },
      // Display/reference prices — the actual charge always comes from
      // whichever store processed the purchase, never computed here. These
      // exist so the app can show a price before the store's own product
      // details have loaded, and so non-IAP flows (Enterprise invoicing)
      // have a number to reference.
      monthlyPrice: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      annualPrice: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'PKR' },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    {
      tableName: 'billing_plans',
      underscored: true,
      timestamps: true,
      indexes: [{ fields: ['branch_count'] }, { fields: ['is_active'] }],
    }
  );
};
