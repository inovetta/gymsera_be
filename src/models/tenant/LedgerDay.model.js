const { DataTypes } = require('sequelize');

/**
 * LedgerDay — one row per branch per business date.
 *
 * Not a copy of collections; the collections are the `payments` table itself,
 * filtered by branch_id + business_date. This row exists only to hold the thing
 * that genuinely has no other home: the OPEN/CLOSED state of that day, and who
 * closed it and when. A day that is OPEN and older than today is a missed day —
 * that's a computed fact (business_date < today), never a third stored status.
 *
 * Immutable once CLOSED: application code never updates a CLOSED row. A mistake
 * discovered later is a new LedgerAdjustment of type REVERSAL, not an edit here.
 */
module.exports = (sequelize) => {
  return sequelize.define(
    'LedgerDay',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      branchId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      businessDate: {
        type: DataTypes.DATEONLY,
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('OPEN', 'CLOSED'),
        allowNull: false,
        defaultValue: 'OPEN',
      },
      openedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      closedBy: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      closedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      // Snapshots taken at the moment of close — the ledger's own record of what
      // it believed the totals were, independent of whatever payments might do
      // afterward (a late verification, say). Divergence from a later live query
      // is exactly what a post-close REVERSAL adjustment explains.
      closedExpectedTotal: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
      },
      closedVerifiedTotal: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
      },
    },
    {
      tableName: 'ledger_days',
      underscored: true,
      timestamps: true,
      indexes: [
        { unique: true, fields: ['branch_id', 'business_date'] },
        { fields: ['status'] },
        { fields: ['branch_id', 'status'] },
      ],
    }
  );
};
