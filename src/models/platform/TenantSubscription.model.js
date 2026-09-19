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
      // Nullable now: only the legacy manual/Enterprise path (bank transfer,
      // sales-assisted) links to a PlatformPackage. A real store-verified
      // subscription (platform IOS/ANDROID/STRIPE below) links to BillingPlan
      // via billingPlanId instead — the two catalogs are deliberately separate
      // (see BillingPlan.model.js) rather than forcing one system to serve both.
      platformPackageId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      billingPlanId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      // MANUAL covers every existing row (bank transfer / "pay after
      // approval" / admin-assigned Enterprise deals) — the default preserves
      // that path exactly as-is. A real purchase sets this to where it was
      // actually made.
      platform: {
        type: DataTypes.ENUM('MANUAL', 'IOS', 'ANDROID', 'STRIPE'),
        allowNull: false,
        defaultValue: 'MANUAL',
      },
      // Snapshotted from BillingPlan.branchCount at purchase time so branch-
      // limit enforcement (gym.service.js) never has to join back to the
      // catalog on every check — and so a later price/catalog edit can never
      // retroactively change what an already-active subscription entitles.
      branchCount: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      productId: {
        type: DataTypes.STRING(150),
        allowNull: true,
        comment: 'The store product ID actually purchased, e.g. branches_3_monthly.',
      },
      // Apple's stable per-subscription identifier — constant across
      // renewals and tier upgrades, it's what App Store Server Notifications
      // key their events off. Google's equivalent (purchaseToken) and
      // Stripe's (subscription id) also live here once those platforms exist.
      externalOriginalTransactionId: {
        type: DataTypes.STRING(150),
        allowNull: true,
      },
      externalTransactionId: {
        type: DataTypes.STRING(150),
        allowNull: true,
        comment: 'The specific transaction last verified — changes on every renewal, unlike externalOriginalTransactionId.',
      },
      environment: {
        type: DataTypes.ENUM('SANDBOX', 'PRODUCTION'),
        allowNull: true,
      },
      lastVerifiedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'Last time this row was confirmed against the store (verify call or webhook) — not the same as when it was created.',
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
      bankTransferRef: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      // Set by the downgrade-trim logic (subscription-quota.service.js) when
      // a subscription shrinks below the tenant's real ACTIVE branch count
      // even after every unbuilt reservedSlots has been trimmed to zero.
      // Real branches are never auto-deleted to resolve this — it's a host-
      // facing "you're over your new plan" flag that blocks new branches/
      // restores until they upgrade or close branches themselves. 0 = in
      // good standing.
      overQuotaCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
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
        { fields: ['external_original_transaction_id'] },
      ],
    }
  );
};
