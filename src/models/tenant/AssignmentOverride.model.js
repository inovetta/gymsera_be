const { DataTypes } = require('sequelize');

/**
 * AssignmentOverride — a per-person delta on top of a role preset.
 *
 * Lets a host say "Salar is a Trainer, but he specifically may approve expenses"
 * without inventing a Senior Trainer role. Without this, hosts create role sprawl
 * within a month and the presets stop meaning anything.
 *
 * DENY is terminal: it beats any ALLOW and any preset grant. That asymmetry is
 * what lets a host withdraw one capability from one person safely.
 *
 * `branchId` null means the override applies across the assignment's whole scope.
 */
module.exports = (sequelize) => {
  return sequelize.define(
    'AssignmentOverride',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      assignmentId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      // Null = applies to every branch in the assignment's scope.
      branchId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      permissionKey: {
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      effect: {
        type: DataTypes.ENUM('ALLOW', 'DENY'),
        allowNull: false,
      },
      dataScope: {
        type: DataTypes.ENUM('ALL', 'ASSIGNED', 'OWN'),
        allowNull: true,
      },
      // Numeric and temporal limits: { max_amount, max_discount_pct, allowed_hours }.
      // Column ships in phase 1; the engine that reads it lands in phase 4.
      constraints: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      createdBy: {
        type: DataTypes.UUID,
        allowNull: true,
      },
    },
    {
      tableName: 'assignment_overrides',
      underscored: true,
      timestamps: true,
      indexes: [
        { fields: ['assignment_id'] },
        { fields: ['assignment_id', 'permission_key'] },
      ],
    }
  );
};
