const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Payout = sequelize.define(
    'Payout',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      branchId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'branch_id',
      },
      amount: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
      },
      currency: {
        type: DataTypes.STRING(3),
        allowNull: false,
        defaultValue: 'PKR',
      },
      status: {
        type: DataTypes.ENUM('PENDING', 'APPROVED', 'PROCESSING', 'COMPLETED', 'REJECTED', 'CANCELLED'),
        allowNull: false,
        defaultValue: 'PENDING',
      },
      destinationJson: {
        type: DataTypes.JSON,
        allowNull: true,
        field: 'destination_json',
      },
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      idempotencyKey: {
        type: DataTypes.STRING(120),
        allowNull: true,
        field: 'idempotency_key',
        unique: true,
      },
      requestedBy: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'requested_by',
      },
      approvedBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'approved_by',
      },
      paidAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'paid_at',
      },
      transactionRef: {
        type: DataTypes.STRING(255),
        allowNull: true,
        field: 'transaction_ref',
      },
    },
    {
      tableName: 'payouts',
      underscored: true,
      timestamps: true,
      indexes: [
        { unique: true, fields: ['idempotency_key'] },
        { fields: ['branch_id', 'status'] },
        { fields: ['created_at'] },
      ],
    }
  );

  return Payout;
};
