const { DataTypes } = require('sequelize');

/**
 * A host's request to pay for a GymsEra plan outside the stores (Phase 7 P9c item D, R-95).
 *
 * The host picks a catalog plan and a cycle; the SERVER fixes the amount and currency from the
 * catalog (monthlyPrice / annualPrice) when the request is made. With the BANK_TRANSFER method the
 * host uploads a receipt (private store, `proofKey`); a platform admin approves (the plan is granted
 * through applyVerifiedSubscription as a MANUAL row, `tenantSubscriptionId`) or rejects with a reason.
 *
 * `method` is the pluggable payment method (plan-payment-methods.js). BANK_TRANSFER is the only one;
 * a card provider adds a method and uses `externalReference` for its checkout / payment id. The host
 * flow (choose plan → pay → status) does not change. No card provider is approved (§14).
 */
const STATUSES = Object.freeze({ PENDING: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED' });
const CYCLES = Object.freeze({ MONTHLY: 'MONTHLY', YEARLY: 'YEARLY' });

module.exports = (sequelize) => {
  const PlanPaymentRequest = sequelize.define(
    'PlanPaymentRequest',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      requestedByUserId: { type: DataTypes.UUID, allowNull: false },
      billingPlanId: { type: DataTypes.UUID, allowNull: false },
      branchCount: { type: DataTypes.INTEGER, allowNull: false },
      billingCycle: { type: DataTypes.STRING(16), allowNull: false },
      amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      method: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'BANK_TRANSFER' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: STATUSES.PENDING },
      proofKey: { type: DataTypes.STRING(500), allowNull: true },
      payerReference: { type: DataTypes.STRING(100), allowNull: true },
      externalReference: { type: DataTypes.STRING(255), allowNull: true },
      reviewedByUserId: { type: DataTypes.UUID, allowNull: true },
      reviewedAt: { type: DataTypes.DATE, allowNull: true },
      rejectionReason: { type: DataTypes.STRING(500), allowNull: true },
      tenantSubscriptionId: { type: DataTypes.UUID, allowNull: true },
      periodStart: { type: DataTypes.DATEONLY, allowNull: true },
      periodEnd: { type: DataTypes.DATEONLY, allowNull: true },
    },
    {
      tableName: 'plan_payment_requests',
      underscored: true,
      timestamps: true,
      indexes: [{ fields: ['tenant_id', 'status'] }, { fields: ['status', 'created_at'] }],
    }
  );
  PlanPaymentRequest.STATUSES = STATUSES;
  PlanPaymentRequest.CYCLES = CYCLES;
  // The proof key never leaves the API.
  PlanPaymentRequest.prototype.toJSON = function toJSON() {
    const v = { ...this.get() };
    v.hasProof = !!v.proofKey;
    delete v.proofKey;
    return v;
  };
  return PlanPaymentRequest;
};
