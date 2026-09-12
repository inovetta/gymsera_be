const { DataTypes } = require('sequelize');

/**
 * ApprovalPolicy — who decides a given approvable action, and how fast.
 *
 * A null `branchId` is the organization-wide default; a row with a branchId
 * overrides it for that branch only. Absent any row, the engine falls back to the
 * catalogue default (approvals.decide at minimum level 60).
 */
module.exports = (sequelize) => {
  return sequelize.define(
    'ApprovalPolicy',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      // Null = organization-wide default for this action.
      branchId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      actionKey: {
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      // The permission a user must hold to decide this request.
      approverPermission: {
        type: DataTypes.STRING(64),
        allowNull: false,
        defaultValue: 'approvals.decide',
      },
      minApproverLevel: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 40,
      },
      // Column ships now, always 1 in v1. Two-person approval is rare in a gym and
      // half-building it is worse than not having it.
      quorum: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
      },
      slaHours: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      escalateToLevel: {
        type: DataTypes.SMALLINT,
        allowNull: true,
      },
      autoExpireHours: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
    },
    {
      tableName: 'approval_policies',
      underscored: true,
      timestamps: true,
      indexes: [
        { fields: ['action_key'] },
        { fields: ['branch_id', 'action_key'] },
      ],
    }
  );
};
