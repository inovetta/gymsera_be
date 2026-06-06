const { DataTypes } = require('sequelize');

/**
 * DeviceMember — maps a ZKTeco numeric PIN to a platform userId for a specific device.
 *
 * Each ZKTeco device uses small integers as user identifiers (called "PIN" or
 * "Enroll Number" in ZKTeco terminology). Since GymsEra uses UUIDs for users,
 * this table bridges the two: when the device sends PIN=1001, we look here to
 * find which platform userId that corresponds to on that device.
 *
 * A user can have different PINs on different devices. A PIN must be unique
 * within a single device.
 */
module.exports = (sequelize) => {
  return sequelize.define(
    'DeviceMember',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      deviceId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
        comment: 'Denormalized for fast lookup without joining devices table',
      },
      // Platform user UUID
      userId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      // Numeric PIN as used on the physical ZKTeco device (1–9999999)
      zkPin: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      // Optional display label (e.g. member full name, for convenience)
      label: {
        type: DataTypes.STRING(200),
        allowNull: true,
      },
    },
    {
      tableName: 'device_members',
      underscored: true,
      timestamps: true,
      indexes: [
        { name: 'device_members_device_pin_unique', unique: true, fields: ['device_id', 'zk_pin'] },
        { name: 'device_members_device_user_unique', unique: true, fields: ['device_id', 'user_id'] },
        { fields: ['tenant_id'] },
        { fields: ['user_id'] },
      ],
    }
  );
};
