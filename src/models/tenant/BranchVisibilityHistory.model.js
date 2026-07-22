const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'BranchVisibilityHistory',
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
      status: {
        type: DataTypes.ENUM('pending', 'active', 'deactivated'),
        allowNull: false,
      },
      reason: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      changedBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'changed_by',
      },
      changedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'changed_at',
      },
    },
    {
      tableName: 'branch_visibility_histories',
      underscored: true,
      timestamps: false,
      indexes: [
        { fields: ['branch_id'] },
        { fields: ['changed_at'] },
      ],
    }
  );
};
