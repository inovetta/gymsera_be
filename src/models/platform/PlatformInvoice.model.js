const { DataTypes } = require('sequelize');

const PlatformInvoiceStatus = {
  DRAFT: 'DRAFT',
  ISSUED: 'ISSUED',
  PAID: 'PAID',
  OVERDUE: 'OVERDUE',
  CANCELLED: 'CANCELLED',
};

module.exports = (sequelize) => {
  const model = sequelize.define(
    'PlatformInvoice',
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
      tenantSubscriptionId: {
        type: DataTypes.UUID,
        allowNull: true,
        comment: 'Link to tenant_subscriptions — null for manual/standalone invoices',
      },
      invoiceNo: {
        type: DataTypes.STRING(50),
        allowNull: false,
      },
      description: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      subtotal: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
      },
      taxAmount: {
        type: DataTypes.DECIMAL(10, 2),
        defaultValue: 0.0,
      },
      totalAmount: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM(...Object.values(PlatformInvoiceStatus)),
        allowNull: false,
        defaultValue: PlatformInvoiceStatus.DRAFT,
      },
      dueDate: {
        type: DataTypes.DATEONLY,
        allowNull: true,
      },
      paidAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'Internal admin notes',
      },
      createdBy: {
        type: DataTypes.UUID,
        allowNull: true,
        comment: 'Platform admin user ID who created this invoice',
      },
    },
    {
      tableName: 'platform_invoices',
      underscored: true,
      timestamps: true,
      indexes: [
        { name: 'platform_invoices_invoice_no_unique', unique: true, fields: ['invoice_no'] },
        { fields: ['tenant_id'] },
        { fields: ['tenant_subscription_id'] },
        { fields: ['status'] },
        { fields: ['due_date'] },
      ],
    }
  );

  model.PlatformInvoiceStatus = PlatformInvoiceStatus;
  return model;
};

module.exports.PlatformInvoiceStatus = {
  DRAFT: 'DRAFT',
  ISSUED: 'ISSUED',
  PAID: 'PAID',
  OVERDUE: 'OVERDUE',
  CANCELLED: 'CANCELLED',
};
