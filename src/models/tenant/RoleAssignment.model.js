const { DataTypes } = require('sequelize');

/**
 * RoleAssignment — "this user holds this role over this scope".
 *
 * Replaces gym_staff. One table for every role in the organization: an Org Admin,
 * a Branch Manager, a Front Desk clerk, a Trainer and a Cleaner are all rows here,
 * differing only in `roleKey` and which branches they are linked to.
 *
 * `userId` references platform.users across databases, so there is deliberately no
 * FK constraint. `email` carries invites issued before the person has an account.
 *
 * Rows are never deleted. Access is withdrawn by moving `status` to REVOKED, which
 * keeps audit trails and historical joins intact.
 */
module.exports = (sequelize) => {
  return sequelize.define(
    'RoleAssignment',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      // Platform user ID — cross-database reference, no FK constraint.
      // Null until an invited email is claimed.
      userId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      // Lowercased. Lets an invite exist before the user signs up.
      email: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      roleKey: {
        type: DataTypes.STRING(40),
        allowNull: false,
      },
      // Denormalized from ROLE_META so escalation guards are a single-row read.
      // Reconciled against the catalogue on every write.
      roleLevel: {
        type: DataTypes.SMALLINT,
        allowNull: false,
      },
      scopeType: {
        type: DataTypes.ENUM('ORG', 'BRANCH'),
        allowNull: false,
        defaultValue: 'BRANCH',
      },
      status: {
        type: DataTypes.ENUM('INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED'),
        allowNull: false,
        defaultValue: 'INVITED',
      },
      jobTitle: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      // Time-boxed access: contractors, holiday cover, trial periods.
      validFrom: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      validUntil: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      invitedBy: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      invitedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      acceptedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      revokedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      revokedBy: {
        type: DataTypes.UUID,
        allowNull: true,
      },
    },
    {
      tableName: 'role_assignments',
      underscored: true,
      timestamps: true,
      indexes: [
        { fields: ['user_id', 'status'] },
        { fields: ['email'] },
        { fields: ['role_key'] },
        { fields: ['status'] },
      ],
    }
  );
};
