const { DataTypes } = require('sequelize');

/**
 * LedgerAdjustment — append-only. Never updated, never deleted.
 *
 * The whole "never silently edit a finalized financial record" requirement lives
 * here: a discrepancy found while reconciling, a variance correction, or a
 * reversal of something already closed are each a new row referencing what they're
 * about — the ledger day stays exactly as closed, the correction is a visible,
 * attributable, timestamped fact next to it.
 */
module.exports = (sequelize) => {
  return sequelize.define(
    'LedgerAdjustment',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      ledgerDayId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      type: {
        type: DataTypes.ENUM(
          'DISCREPANCY_NOTE',
          'VARIANCE_ADJUSTMENT',
          'REVERSAL',
          'MISSED_DAY_RECONCILIATION'
        ),
        allowNull: false,
      },
      relatedPaymentId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      // Signed — positive adds to the day's verified total, negative subtracts.
      // Null for a pure DISCREPANCY_NOTE that isn't itself a monetary correction.
      amount: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
      },
      reason: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      createdBy: {
        type: DataTypes.UUID,
        allowNull: false,
      },
    },
    {
      tableName: 'ledger_adjustments',
      underscored: true,
      timestamps: true,
      updatedAt: false,
      indexes: [
        { fields: ['ledger_day_id'] },
        { fields: ['related_payment_id'] },
      ],
    }
  );
};
