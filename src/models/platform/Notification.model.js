const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'Notification',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      userId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      role: {
        type: DataTypes.ENUM('traveler', 'host', 'admin', 'staff'),
        allowNull: false,
        defaultValue: 'traveler',
      },
      type: {
        type: DataTypes.STRING(50),
        allowNull: false,
      },
      title: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      message: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      body: {
        type: DataTypes.TEXT,
        allowNull: false,
        defaultValue: '',
        get() {
          return this.getDataValue('message') || this.getDataValue('body');
        },
        set(value) {
          this.setDataValue('message', value);
          this.setDataValue('body', value);
        },
      },
      priority: {
        type: DataTypes.ENUM('normal', 'high'),
        allowNull: false,
        defaultValue: 'normal',
      },
      deepLink: {
        type: DataTypes.STRING(255),
        allowNull: true,
        field: 'deep_link',
      },
      metadataJson: {
        type: DataTypes.JSON,
        allowNull: true,
        field: 'metadata_json',
      },
      metadata: {
        type: DataTypes.JSON,
        allowNull: true,
        get() {
          return this.getDataValue('metadataJson') || this.getDataValue('metadata');
        },
        set(value) {
          this.setDataValue('metadataJson', value);
          this.setDataValue('metadata', value);
        },
      },
      isRead: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
    },
    {
      tableName: 'notifications',
      underscored: true,
      timestamps: true,
      indexes: [
        { name: 'notifications_user_id', fields: ['user_id'] },
        { name: 'notifications_role', fields: ['role'] },
        { name: 'notifications_is_read', fields: ['is_read'] },
        { name: 'notifications_priority', fields: ['priority'] },
      ],
    }
  );
};
