const { DataTypes } = require('sequelize');

/**
 * AuditLog — append-only record of every consequential mutation.
 *
 * Non-negotiable in a system that handles cash. Lives in the tenant database so a
 * customer's trail stays inside their own data, which matters the first time a
 * chain asks for it.
 *
 * Never updated, never deleted. Retention is a scheduled archival job, not a
 * DELETE from application code.
 */
module.exports = (sequelize) => {
  return sequelize.define(
    'AuditLog',
    {
      id: {
        type: DataTypes.BIGINT,
        autoIncrement: true,
        primaryKey: true,
      },
      branchId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      actorUserId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      actorRoleKey: {
        type: DataTypes.STRING(40),
        allowNull: true,
      },
      // Dotted verb: 'team.invite', 'approvals.decide', 'members.create'.
      action: {
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      targetType: {
        type: DataTypes.STRING(40),
        allowNull: true,
      },
      targetId: {
        type: DataTypes.STRING(64),
        allowNull: true,
      },
      beforeState: {
        type: DataTypes.JSON,
        allowNull: true,
        field: 'before_state',
      },
      afterState: {
        type: DataTypes.JSON,
        allowNull: true,
        field: 'after_state',
      },
      ip: {
        type: DataTypes.STRING(64),
        allowNull: true,
      },
      userAgent: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
    },
    {
      tableName: 'audit_logs',
      underscored: true,
      timestamps: true,
      updatedAt: false,
      indexes: [
        { fields: ['actor_user_id'] },
        { fields: ['action'] },
        { fields: ['branch_id'] },
        { fields: ['target_type', 'target_id'] },
        { fields: ['created_at'] },
      ],
    }
  );
};
