const { DataTypes } = require('sequelize');
const { PaymentStatus, PaymentMethod } = require('../../constants/payment-status');

module.exports = (sequelize) => {
  return sequelize.define(
    'Payment',
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
      paymentFor: {
        type: DataTypes.ENUM('MEMBERSHIP', 'TRAINER', 'PRODUCT', 'OTHER'),
        allowNull: false,
        defaultValue: 'MEMBERSHIP',
      },
      // UUID of the entity being paid for (e.g. member_subscription id)
      referenceEntityId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      method: {
        type: DataTypes.ENUM(...Object.values(PaymentMethod)),
        allowNull: false,
      },
      gatewayName: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      gatewayTransactionId: {
        type: DataTypes.STRING(200),
        allowNull: true,
      },
      amount: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
      },
      currency: {
        type: DataTypes.STRING(5),
        allowNull: false,
        defaultValue: 'PKR',
      },
      status: {
        type: DataTypes.ENUM(...Object.values(PaymentStatus)),
        allowNull: false,
        defaultValue: PaymentStatus.PENDING,
      },
      paidAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      verifiedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      // Platform user ID who created this payment record
      createdBy: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      // Role of the creator ('GYM_HOST' | 'BRANCH_MANAGER') — drives auto-complete logic
      createdByRole: {
        type: DataTypes.STRING(30),
        allowNull: true,
      },
      // Branch this payment belongs to (for branch-level filtering)
      branchId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      // Staff who collected the cash (step 1 of 2-step verification)
      staffCollectedBy: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      collectedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      // Platform user ID of the tenant who gave final approval (cross-DB reference)
      verifiedBy: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      // Receipt / bank transfer proof uploaded by the member
      proofUrl: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      // Reason provided when a payment is rejected by staff
      rejectedReason: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
    },
    {
      tableName: 'payments',
      underscored: true,
      timestamps: true,
      indexes: [
        { fields: ['user_id'] },
        { fields: ['status', 'paid_at'] },
        { fields: ['payment_for', 'reference_entity_id'] },
        { fields: ['branch_id'] },
        { fields: ['created_by'] },
      ],
    }
  );
};
