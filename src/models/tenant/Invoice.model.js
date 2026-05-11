const { DataTypes } = require('sequelize');
const { InvoiceStatus } = require('../../constants/payment-status');

module.exports = (sequelize) => {
  return sequelize.define(
    'Invoice',
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
      invoiceNo: {
        type: DataTypes.STRING(50),
        allowNull: false,
        unique: true,
      },
      invoiceType: {
        type: DataTypes.ENUM('MEMBERSHIP', 'TRAINER', 'PRODUCT'),
        allowNull: false,
        defaultValue: 'MEMBERSHIP',
      },
      referenceEntityId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      subtotal: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
      },
      discountAmount: {
        type: DataTypes.DECIMAL(10, 2),
        defaultValue: 0.0,
      },
      taxAmount: {
        type: DataTypes.DECIMAL(10, 2),
        defaultValue: 0.0,
      },
      totalAmount: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
      },
      dueDate: {
        type: DataTypes.DATEONLY,
        allowNull: true,
      },
      paidAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      status: {
        type: DataTypes.ENUM(...Object.values(InvoiceStatus)),
        allowNull: false,
        defaultValue: InvoiceStatus.DRAFT,
      },
    },
    {
      tableName: 'invoices',
      underscored: true,
      timestamps: true,
      indexes: [
        { unique: true, fields: ['invoice_no'] },
        { fields: ['user_id'] },
        { fields: ['status'] },
        { fields: ['due_date'] },
      ],
    }
  );
};
