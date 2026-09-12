const { DataTypes } = require('sequelize');

/**
 * RoleAssignmentBranch — which branches a BRANCH-scoped assignment covers.
 *
 * An ORG-scoped assignment has no rows here and implicitly covers every branch,
 * including branches created after the assignment was made. That difference is
 * intentional: "all branches" must keep meaning all branches.
 */
module.exports = (sequelize) => {
  return sequelize.define(
    'RoleAssignmentBranch',
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
      branchId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
    },
    {
      tableName: 'role_assignment_branches',
      underscored: true,
      timestamps: true,
      indexes: [
        { unique: true, fields: ['assignment_id', 'branch_id'], name: 'rab_assignment_branch_unique' },
        { fields: ['branch_id'] },
      ],
    }
  );
};
