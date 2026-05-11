const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'AttendanceLog',
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
      // Platform user ID (cross-DB reference)
      userId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      memberSubscriptionId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      attendanceType: {
        type: DataTypes.ENUM('CHECK_IN', 'CHECK_OUT'),
        allowNull: false,
        defaultValue: 'CHECK_IN',
      },
      checkInAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      checkOutAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      entryMethod: {
        type: DataTypes.ENUM('QR_SCAN', 'MANUAL', 'RFID'),
        allowNull: false,
        defaultValue: 'MANUAL',
      },
      deviceId: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      notes: {
        type: DataTypes.STRING(300),
        allowNull: true,
      },
    },
    {
      tableName: 'attendance_logs',
      underscored: true,
      timestamps: true,
      indexes: [
        { fields: ['branch_id', 'check_in_at'] },
        { fields: ['user_id'] },
        { fields: ['member_subscription_id'] },
      ],
    }
  );
};
