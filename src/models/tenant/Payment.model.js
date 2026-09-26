const { DataTypes } = require('sequelize');
const { PaymentStatus, PaymentMethod } = require('../../constants/payment-status');

module.exports = (sequelize) => {
  const Payment = sequelize.define(
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
      // Branch-timezone calendar date this collection belongs to, stamped once at
      // creation (see ledger.service.js#computeBusinessDate). Every ledger query —
      // daily, weekly, monthly, reconciliation — filters on this, never on a
      // recomputed timezone conversion.
      businessDate: {
        type: DataTypes.DATEONLY,
        allowNull: true,
      },
      // Optional client-supplied key so a retried/double-tapped "record payment"
      // can't create the same collection twice.
      idempotencyKey: {
        type: DataTypes.STRING(120),
        allowNull: true,
      },
      // A thermal-printer receipt was handed to the customer for this payment.
      // Set by a fire-and-forget ping from the app after a successful print —
      // never required for anything, purely a "was a receipt actually given
      // out" fact for the one dispute that matters: a customer saying they
      // never got one.
      printedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      printedBy: {
        type: DataTypes.UUID,
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

  const resolveBranchTimezone = async (payment, options) => {
    let effectiveBranchId = payment.branchId || (payment.getDataValue && payment.getDataValue('branchId'));
    if (!effectiveBranchId && payment.referenceEntityId && payment.paymentFor === 'MEMBERSHIP') {
      try {
        const { MemberSubscription } = sequelize.models;
        if (MemberSubscription) {
          const sub = await MemberSubscription.findByPk(payment.referenceEntityId, {
            attributes: ['id', 'branchId'],
            transaction: options?.transaction,
          });
          if (sub && sub.branchId) {
            payment.setDataValue('branchId', sub.branchId);
            payment.branchId = sub.branchId;
            effectiveBranchId = sub.branchId;
          }
        }
      } catch (_) {}
    }

    let timezone = 'Asia/Karachi';
    if (effectiveBranchId) {
      try {
        const { Branch } = sequelize.models;
        if (Branch) {
          const branch = await Branch.findByPk(effectiveBranchId, {
            attributes: ['id', 'timezone'],
            transaction: options?.transaction,
          });
          if (branch?.timezone) {
            timezone = branch.timezone;
          }
        }
      } catch (_) {}
    }
    return timezone;
  };

  const getCollectionTime = (payment) => {
    return (
      payment.collectedAt ||
      (payment.getDataValue && payment.getDataValue('collectedAt')) ||
      payment.paidAt ||
      (payment.getDataValue && payment.getDataValue('paidAt')) ||
      payment.createdAt ||
      (payment.getDataValue && payment.getDataValue('createdAt')) ||
      new Date()
    );
  };

  const stampBusinessDateIfMissing = async (payment, options) => {
    const currentBDate = payment.businessDate || (payment.getDataValue && payment.getDataValue('businessDate'));
    if (currentBDate) return;

    const timezone = await resolveBranchTimezone(payment, options);
    const collectionTime = getCollectionTime(payment);
    const { computeBusinessDate } = require('../../services/ledger.service');
    const bDate = computeBusinessDate(collectionTime, timezone);
    payment.setDataValue('businessDate', bDate);
    payment.businessDate = bDate;
  };

  Payment.beforeCreate(async (instance, options) => {
    await stampBusinessDateIfMissing(instance, options);
  });

  Payment.beforeBulkCreate(async (instances, options) => {
    for (const inst of instances) {
      await stampBusinessDateIfMissing(inst, options);
    }
  });

  Payment.beforeUpdate(async (instance, options) => {
    const previousBDate = instance.previous('businessDate');
    const currentBDate = (instance.getDataValue && instance.getDataValue('businessDate')) || instance.businessDate;

    // 1. NEVER change an existing business_date: if an update tries to change it, throw an error
    if (previousBDate) {
      if (instance.changed('businessDate') && currentBDate !== previousBDate) {
        throw new Error('business_date is immutable and cannot be changed once set');
      }
      return;
    }

    // 2. If an old row has NULL business_date:
    // If update explicitly provided a businessDate, allow it to be set once
    if (currentBDate) {
      return;
    }

    // If still NULL, stamp it from its original collection time, not from "now"
    const timezone = await resolveBranchTimezone(instance, options);
    const originalTime =
      instance.collectedAt ||
      instance.previous('collectedAt') ||
      (instance.getDataValue && instance.getDataValue('collectedAt')) ||
      instance.paidAt ||
      instance.previous('paidAt') ||
      (instance.getDataValue && instance.getDataValue('paidAt')) ||
      instance.createdAt ||
      instance.previous('createdAt') ||
      (instance.getDataValue && instance.getDataValue('createdAt'));

    const timestampToUse = originalTime || new Date();
    const { computeBusinessDate } = require('../../services/ledger.service');
    const bDate = computeBusinessDate(timestampToUse, timezone);
    instance.setDataValue('businessDate', bDate);
    instance.businessDate = bDate;
  });

  Payment.beforeBulkUpdate((options) => {
    if (options.attributes && ('businessDate' in options.attributes || 'business_date' in options.attributes)) {
      throw new Error('business_date cannot be changed via bulk update');
    }
  });

  return Payment;
};
