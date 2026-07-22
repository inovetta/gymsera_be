const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'Expense',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      branchId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'branch_id',
      },
      categoryId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'category_id',
      },
      title: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      amount: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
      },
      expenseDate: {
        type: DataTypes.DATEONLY,
        allowNull: false,
        field: 'expense_date',
      },
      paymentMethod: {
        type: DataTypes.ENUM('cash', 'bank_transfer', 'card', 'other'),
        defaultValue: 'cash',
        field: 'payment_method',
      },
      vendorName: {
        type: DataTypes.STRING(255),
        allowNull: true,
        field: 'vendor_name',
      },
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      receiptUrl: {
        type: DataTypes.STRING(500),
        allowNull: true,
        field: 'receipt_url',
      },
      isRecurring: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        field: 'is_recurring',
      },
      recurrenceFrequency: {
        type: DataTypes.ENUM('weekly', 'monthly', 'yearly'),
        allowNull: true,
        field: 'recurrence_frequency',
      },
      recurrenceEndDate: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        field: 'recurrence_end_date',
      },
      recurringTemplateId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'recurring_template_id',
      },
      status: {
        type: DataTypes.ENUM('pending', 'approved', 'rejected'),
        defaultValue: 'approved',
      },
      createdBy: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'created_by',
      },
      reviewedBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'reviewed_by',
      },
    },
    {
      tableName: 'expenses',
      underscored: true,
      timestamps: true,
    }
  );
};
