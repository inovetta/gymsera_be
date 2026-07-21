const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'StaffActionRequest',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      staffId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      branchId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      actionType: {
        type: DataTypes.ENUM('add_member', 'renew', 'change_plan', 'upgrade'),
        allowNull: false,
      },
      payloadJson: {
        type: DataTypes.JSON,
        allowNull: false,
        field: 'payload_json',
      },
      status: {
        type: DataTypes.ENUM('pending', 'approved', 'rejected'),
        allowNull: false,
        defaultValue: 'pending',
      },
      requestedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'requested_at',
      },
      reviewedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'reviewed_at',
      },
      reviewedBy: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'reviewed_by',
      },
    },
    {
      tableName: 'staff_action_requests',
      underscored: true,
      timestamps: false,
    }
  );
};
