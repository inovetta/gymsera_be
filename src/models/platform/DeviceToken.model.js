const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'DeviceToken',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      userId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'user_id',
      },
      token: {
        type: DataTypes.STRING(500),
        allowNull: false,
        unique: true,
      },
      platform: {
        type: DataTypes.ENUM('android', 'ios', 'web'),
        allowNull: false,
        defaultValue: 'android',
      },
      lastActiveAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'last_active_at',
      },
      deviceId: {
        type: DataTypes.STRING(255),
        allowNull: true,
        field: 'device_id',
      },
      deviceName: {
        type: DataTypes.STRING(255),
        allowNull: true,
        field: 'device_name',
      },
      // RT-01 (spec §9.4): lets pushes be localized and old builds be found.
      appVersion: {
        type: DataTypes.STRING(40),
        allowNull: true,
        field: 'app_version',
      },
      locale: {
        type: DataTypes.STRING(35),
        allowNull: true,
      },
      timezone: {
        type: DataTypes.STRING(64),
        allowNull: true,
      },
    },
    {
      tableName: 'device_tokens',
      underscored: true,
      timestamps: true,
      indexes: [
        { fields: ['user_id'] },
        { fields: ['token'], unique: true },
      ],
    }
  );
};
