const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'ExpenseCategory',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      isSystem: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        field: 'is_system',
      },
      businessId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'business_id',
      },
    },
    {
      tableName: 'expense_categories',
      underscored: true,
      timestamps: true,
    }
  );
};
