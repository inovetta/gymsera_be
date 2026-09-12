const { DataTypes } = require('sequelize');

/**
 * ApprovalRequest — an action awaiting a decision.
 *
 * The generalization of StaffActionRequest. `actionKey` holds a permission key
 * rather than an ENUM member, so adding an approvable action is a catalogue entry
 * and not a migration.
 *
 * `payload` is the serialized command. On approval the *same* handler the direct
 * path uses is invoked with it — never a second implementation, which is how the
 * two paths drift apart and the approved one stops being tested.
 */
module.exports = (sequelize) => {
  return sequelize.define(
    'ApprovalRequest',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      branchId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      // A permission key: 'members.create', 'payments.record', 'expenses.create'.
      actionKey: {
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      // Serialized command arguments, replayed through the normal handler on approve.
      payload: {
        type: DataTypes.JSON,
        allowNull: false,
      },
      // Human-readable summary captured at request time, so the inbox reads well
      // even if the referenced rows later change.
      summary: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      requestedBy: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      requestedByAssignmentId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      status: {
        type: DataTypes.ENUM('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'),
        allowNull: false,
        defaultValue: 'PENDING',
      },
      decidedBy: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      decidedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      decisionReason: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      // Result of the executed command, kept for the audit trail.
      resultRef: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      // Caller-supplied; makes a retried request idempotent. Critical for an
      // offline-capable front desk replaying a queue.
      idempotencyKey: {
        type: DataTypes.STRING(120),
        allowNull: true,
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      escalatedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      tableName: 'approval_requests',
      underscored: true,
      timestamps: true,
      indexes: [
        { fields: ['status', 'branch_id'] },
        { fields: ['requested_by'] },
        { fields: ['action_key'] },
        { unique: true, fields: ['idempotency_key'], name: 'approval_idempotency_unique' },
      ],
    }
  );
};
