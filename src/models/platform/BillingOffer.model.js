const { DataTypes } = require('sequelize');

/**
 * A promotional offer, tracked independently of the plan catalog so adding
 * one is a data change, never a redeploy.
 *
 * Scope note: this table is the source of truth for "what offers exist and
 * who they apply to" — it does NOT by itself make a discount happen on any
 * store. iOS Introductory Offers (e.g. "first month 50% off") are configured
 * directly on the product in App Store Connect and need no code once set up
 * there; this row is then just a record of it, and lets the app query
 * "is there an active offer for this plan" to decide what banner to show.
 * iOS Promotional Offers (win-back discounts for lapsed subscribers) need a
 * server-signed JWT per redemption — `appleKeyId`/`applePromoOfferId` below
 * are where that identifier lives once that flow is built; it isn't yet.
 */
module.exports = (sequelize) => {
  return sequelize.define(
    'BillingOffer',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: { type: DataTypes.STRING(150), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
      discountType: {
        type: DataTypes.ENUM('PERCENTAGE', 'FIXED_AMOUNT', 'FREE_PERIOD'),
        allowNull: false,
      },
      discountValue: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
        comment: 'Percent (0-100) for PERCENTAGE, currency amount for FIXED_AMOUNT, number of billing periods for FREE_PERIOD.',
      },
      // Null = applies to every branch count on the staircase.
      appliesToBranchMin: { type: DataTypes.INTEGER, allowNull: true },
      appliesToBranchMax: { type: DataTypes.INTEGER, allowNull: true },
      platform: {
        type: DataTypes.ENUM('ALL', 'IOS', 'ANDROID', 'WEB'),
        allowNull: false,
        defaultValue: 'ALL',
      },
      // Set once the matching store-side offer is configured — see the
      // class doc comment above. Null until then; the offer can still exist
      // here as a plain "message + discount" the app displays.
      appleOfferId: { type: DataTypes.STRING(150), allowNull: true },
      androidOfferId: { type: DataTypes.STRING(150), allowNull: true },
      stripeCouponId: { type: DataTypes.STRING(150), allowNull: true },
      validFrom: { type: DataTypes.DATE, allowNull: true },
      validUntil: { type: DataTypes.DATE, allowNull: true },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    {
      tableName: 'billing_offers',
      underscored: true,
      timestamps: true,
      indexes: [{ fields: ['is_active'] }, { fields: ['platform'] }],
    }
  );
};
