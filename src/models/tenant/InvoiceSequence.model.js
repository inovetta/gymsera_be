const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'InvoiceSequence',
    {
      branchId: {
        type: DataTypes.STRING(64),
        primaryKey: true,
        field: 'branch_id',
      },
      prefix: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'INV',
        field: 'prefix',
      },
      nextNumber: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 1,
        field: 'next_number',
      },
    },
    {
      tableName: 'invoice_sequences',
      timestamps: true,
      underscored: true,
    }
  );
};
