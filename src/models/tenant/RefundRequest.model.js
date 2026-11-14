const { DataTypes } = require('sequelize');

/**
 * NEW-253 (R-103): a member's request for a refund of a cancelled subscription. One per subscription
 * (unique `subscription_id`), decided once (PENDING → APPROVED / REJECTED) by a direct `payments.refund`
 * holder. An approval is the PAY-07 refund: `ledger_adjustment_id` is its REVERSAL row.
 * Table: tenant migration 028.
 */
module.exports = (sequelize) => sequelize.define(
  'RefundRequest',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    subscriptionId: { type: DataTypes.UUID, allowNull: false, unique: 'refund_requests_subscription_unique' },
    paymentId: { type: DataTypes.UUID, allowNull: false },
    userId: { type: DataTypes.UUID, allowNull: false },
    branchId: { type: DataTypes.UUID, allowNull: false },
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'PENDING' },
    currency: { type: DataTypes.STRING(3), allowNull: false },
    suggestedAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    approvedAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    reason: { type: DataTypes.STRING(500), allowNull: true },
    decidedBy: { type: DataTypes.UUID, allowNull: true },
    decidedAt: { type: DataTypes.DATE, allowNull: true },
    decisionReason: { type: DataTypes.STRING(500), allowNull: true },
    ledgerAdjustmentId: { type: DataTypes.UUID, allowNull: true },
  },
  {
    tableName: 'refund_requests',
    underscored: true,
    timestamps: true,
    indexes: [
      { fields: ['status', 'branch_id'] },
      { fields: ['user_id'] },
    ],
  }
);
