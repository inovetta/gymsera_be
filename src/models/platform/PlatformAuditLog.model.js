'use strict';

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define(
    'PlatformAuditLog',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      actorUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'actor_user_id',
      },
      action: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      targetType: {
        type: DataTypes.STRING(50),
        allowNull: true,
        field: 'target_type',
      },
      targetId: {
        type: DataTypes.STRING(100),
        allowNull: true,
        field: 'target_id',
      },
      details: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'created_at',
      },
    },
    {
      tableName: 'platform_audit_logs',
      underscored: true,
      timestamps: false,
      indexes: [
        { fields: ['actor_user_id'] },
        { fields: ['action'] },
      ],
    }
  );
};
